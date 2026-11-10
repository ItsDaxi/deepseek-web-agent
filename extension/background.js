// Bridges DeepSeek tabs and the native host, and routes command output back to the tab that asked.
'use strict';

// Chromium runs this file as a service worker and loads the library here. Firefox runs it as an event
// page, where the manifest lists lib/update-check.js before this file, so it is already loaded.
if (typeof importScripts === 'function') importScripts('lib/update-check.js', 'lib/agent-pool.js', 'lib/agent-registry.js');

const HOST_NAME = 'com.dsx.shell_host';
const ALLOWED_ORIGIN = 'https://chat.deepseek.com';
const MAX_DIAGNOSTICS = 30;
// The release is looked up at most once an hour, a failed try included. GitHub allows 60 requests an
// hour per address without logging in, so this stays far below it.
const UPDATE_CHECK_EVERY_MS = 60 * 60 * 1000;
const UPDATE_FORCE_MIN_MS = 30 * 1000;
const UPDATE_FETCH_TIMEOUT_MS = 8000;
const MAX_ETAG_CHARS = 200;
// How long the tabs get to say whether they can be reloaded, how long a reload remembers which tabs
// to bring back, and how long before the same version may trigger another reload.
const RELOAD_QUERY_TIMEOUT_MS = 1500;
const RELOAD_RESUME_WINDOW_MS = 2 * 60 * 1000;
const RELOAD_COOLDOWN_MS = 10 * 60 * 1000;
const PAGE_ORIGIN_PREFIX = 'https://chat.deepseek.com/';

const tabPorts = new Set();
const jobOwners = new Map();
let nativePort = null;
let hostInfo = null;
let hostError = null;
let lastDiagnostic = null;
let diagnosticsWrite = Promise.resolve();

// Keeps recent connection events in storage, so failures can be read after the fact.
function logDiagnostic(event, detail = null) {
  const entry = JSON.stringify([event, detail]);
  if (entry === lastDiagnostic) return;
  lastDiagnostic = entry;
  const at = new Date().toISOString();
  // Writes run one at a time, or two close events would overwrite each other.
  diagnosticsWrite = diagnosticsWrite
    .then(() => chrome.storage.local.get({ diagnostics: [] }))
    .then(({ diagnostics }) => chrome.storage.local.set({ diagnostics: [...diagnostics, { at, event, detail }].slice(-MAX_DIAGNOSTICS) }))
    .catch(() => {});
}

logDiagnostic('worker-started');

function hostStatus() {
  return { type: 'host-status', connected: Boolean(nativePort && hostInfo), info: hostInfo, error: hostError };
}

function broadcast(message) {
  for (const port of tabPorts) port.postMessage(message);
}

function connectHost() {
  if (nativePort) return;
  try {
    nativePort = chrome.runtime.connectNative(HOST_NAME);
  } catch (error) {
    hostError = error.message;
    logDiagnostic('connect-native-threw', hostError);
    broadcast(hostStatus());
    return;
  }

  nativePort.onMessage.addListener((message) => {
    if (message.type === 'hello') {
      hostInfo = message;
      hostError = null;
      logDiagnostic('host-connected', message.version);
      broadcast(hostStatus());
      reloadIfFilesAreNewer(message.extensionVersion).catch(() => {});
      return;
    }
    // The MCP servers belong to the host, not to one tab: every tab hears when one starts, fails or stops.
    if (message.type === 'mcp-servers') {
      broadcast(message);
      return;
    }
    const owner = jobOwners.get(message.id);
    if (owner) owner.postMessage(message);
    // A text sent in pieces keeps its owner until the last piece has gone through.
    const lastPromptPiece = message.type === 'instructions' && !(message.part < message.parts - 1);
    if (message.type === 'exit' || message.type === 'folder-picked' || lastPromptPiece) jobOwners.delete(message.id);
  });

  nativePort.onDisconnect.addListener(() => {
    hostError = chrome.runtime.lastError ? chrome.runtime.lastError.message : 'The native host closed.';
    logDiagnostic('host-disconnected', hostError);
    nativePort = null;
    hostInfo = null;
    for (const [id, owner] of jobOwners) {
      owner.postMessage({ type: 'exit', id, status: 'spawn_error', code: null, durationMs: 0, error: hostError });
    }
    jobOwners.clear();
    broadcast(hostStatus());
  });

  nativePort.postMessage({ type: 'hello' });
}

// ---- Update check ------------------------------------------------------------------------------
// Asks GitHub for the latest release. No account and no data of the user is sent, and GitHub allows
// this request from an extension without any extra permission. Turn it off with
// chrome.storage.local.set({ checkForUpdates: false }).

let updateLookup = null;

// `previous` is the last answer. With its ETag, a repeat lookup is a conditional request: GitHub
// replies 304 when the release has not changed, and does not count that against its rate limit.
async function fetchLatestTag(previous) {
  const headers = { Accept: 'application/vnd.github+json' };
  if (previous && previous.tag && previous.etag) headers['If-None-Match'] = previous.etag;
  const response = await fetch(DsxUpdateCheck.API_URL, {
    headers,
    cache: 'no-store',
    signal: AbortSignal.timeout(UPDATE_FETCH_TIMEOUT_MS),
  });
  if (response.status === 304 && previous && previous.tag) return { tag: previous.tag, etag: previous.etag };
  if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
  const { tag_name: tag } = await response.json();
  // A tag that is not a plain version is ignored rather than trusted.
  if (!DsxUpdateCheck.parseVersion(tag)) throw new Error('The latest release has no usable version.');
  const etag = response.headers.get('ETag');
  return { tag, etag: etag && etag.length <= MAX_ETAG_CHARS ? etag : null };
}

// Returns what is known about the latest release: { tag, failed }. A lookup the user asked for
// (`force`) skips the hourly wait, but never repeats within half a minute.
async function lookUpLatestTag(force = false) {
  const { updateCheck } = await chrome.storage.local.get({ updateCheck: null });
  const age = updateCheck ? Date.now() - updateCheck.checkedAt : Infinity;
  if (age < (force ? UPDATE_FORCE_MIN_MS : UPDATE_CHECK_EVERY_MS)) return updateCheck;

  let entry;
  try {
    entry = { checkedAt: Date.now(), ...(await fetchLatestTag(updateCheck)), failed: false };
  } catch (error) {
    logDiagnostic('update-check-failed', error.message);
    // The last known release stays, so a short outage does not hide an update already found.
    entry = { checkedAt: Date.now(), tag: updateCheck ? updateCheck.tag : null, etag: updateCheck ? updateCheck.etag : null, failed: true };
  }
  await chrome.storage.local.set({ updateCheck: entry });
  return entry;
}

// `force` is a lookup the user asked for with /update. It is allowed even when the automatic check
// is turned off, because the user is asking for it now.
async function checkForUpdate(force = false) {
  const { checkForUpdates } = await chrome.storage.local.get({ checkForUpdates: true });
  if (checkForUpdates === false && !force) return { available: false };
  // Several tabs can ask at once, and they share one lookup.
  updateLookup = updateLookup || lookUpLatestTag(force).finally(() => { updateLookup = null; });
  const entry = await updateLookup;
  const current = chrome.runtime.getManifest().version;
  return {
    ...DsxUpdateCheck.status(current, entry && entry.tag),
    current,
    latest: entry ? entry.tag : null,
    failed: !entry || entry.failed,
  };
}

// ---- Reload after an update ----------------------------------------------------------------------
// The setup replaces the extension's files, but the browser keeps running the old ones until the
// extension is reloaded. The host reports the version of the files on disk when it connects. If that
// is higher than the version running here, the extension reloads itself. Nothing is downloaded or
// run: it only compares two version numbers.
//
// The DeepSeek tabs that are open lose their connection to a reloaded extension, so tabs with
// nothing to lose are reloaded too. A tab with a draft, an unanswered card or a running command is
// left alone, and shows its own "Reload page" notice.

let reloadQuery = null;

// Asks every connected tab whether it can be reloaded, and returns the ids of those that can.
function askTabsWhichCanReload() {
  return new Promise((resolve) => {
    const waiting = new Set();
    const safe = [];
    let timer = null;
    const finish = () => {
      clearTimeout(timer);
      reloadQuery = null;
      resolve(safe);
    };
    reloadQuery = {
      answer(port, busy) {
        if (!waiting.delete(port)) return;
        if (!busy) safe.push(port.sender.tab.id);
        if (!waiting.size) finish();
      },
    };
    for (const port of tabPorts) {
      if (!port.sender || !port.sender.tab) continue;
      waiting.add(port);
      port.postMessage({ type: 'prepare-reload' });
    }
    timer = setTimeout(finish, RELOAD_QUERY_TIMEOUT_MS);
    if (!waiting.size) finish();
  });
}

async function reloadIfFilesAreNewer(versionOnDisk) {
  const running = DsxUpdateCheck.parseVersion(chrome.runtime.getManifest().version);
  const onDisk = DsxUpdateCheck.parseVersion(versionOnDisk);
  if (!running || !onDisk || DsxUpdateCheck.compare(onDisk, running) <= 0) return;

  // A reload that did not bring the two versions together is not repeated for ten minutes.
  const { selfReload } = await chrome.storage.local.get({ selfReload: null });
  if (selfReload && selfReload.version === versionOnDisk && Date.now() - selfReload.at < RELOAD_COOLDOWN_MS) return;

  const tabIds = await askTabsWhichCanReload();
  await chrome.storage.local.set({
    selfReload: { version: versionOnDisk, at: Date.now() },
    reloadTabs: { ids: tabIds, at: Date.now() },
  });
  logDiagnostic('reloading-for-update', versionOnDisk);
  // The note is written before the worker is stopped, so it is still there afterwards.
  await diagnosticsWrite;
  chrome.runtime.reload();
}

// Runs each time this worker starts: right after a reload it brings back the tabs that were safe.
async function reloadTabsAfterUpdate() {
  const { reloadTabs } = await chrome.storage.local.get({ reloadTabs: null });
  if (!reloadTabs) return;
  await chrome.storage.local.remove('reloadTabs');
  if (Date.now() - reloadTabs.at > RELOAD_RESUME_WINDOW_MS) return;
  for (const id of reloadTabs.ids) {
    try {
      const tab = await chrome.tabs.get(id);
      // The id may belong to another page by now.
      if (tab.url && tab.url.startsWith(PAGE_ORIGIN_PREFIX)) await chrome.tabs.reload(id);
    } catch {
      // The tab was closed in the meantime.
    }
  }
}

reloadTabsAfterUpdate();
// After a reload the worker does not start until something wakes it, and this is what does.
chrome.runtime.onInstalled.addListener(() => { reloadTabsAfterUpdate(); });
chrome.runtime.onStartup.addListener(() => { reloadTabsAfterUpdate(); });

// ---- Helpers (sub-agents) ------------------------------------------------------------------------
// A chat asks for a helper with <dsx:agent>. The pool (lib/agent-pool.js) lets two work at the same time,
// because DeepSeek refuses a third chat that generates at once, and keeps the rest waiting. A helper is a
// DeepSeek chat in a background tab whose address carries #dsx-agent=<id>; content.js sees that and works
// as a helper. Its report goes back to the tab that asked.

const OWNER_GRACE_MS = 15 * 1000;
const MAX_REPORT_CHARS = 200 * 1000;
const helperTabs = new Map();
const waitingForOwner = new Map();
const ownerTimers = new Map();
// What the Agents menu lists: every helper of a tab, kept after it ends. See lib/agent-registry.js.
const helperRegistry = DsxAgentRegistry.createAgentRegistry();
// Tabs opened to look at the chat of a helper that has ended: tab id → { owner }.
const viewerTabs = new Map();

function tabIdOf(port) {
  return port.sender && port.sender.tab ? port.sender.tab.id : undefined;
}

function portsOfTab(tabId) {
  return [...tabPorts].filter((port) => tabIdOf(port) === tabId);
}

// Tells the tab that asked for a helper. A page that is reloading has no connection for a moment, so a
// report that finds none waits there until the page is back.
function tellOwner(job, message) {
  const ports = portsOfTab(job.owner);
  if (ports.length) {
    for (const port of ports) port.postMessage(message);
    return;
  }
  if (message.type !== 'agent-result') return;
  waitingForOwner.set(job.owner, [...(waitingForOwner.get(job.owner) || []), message]);
}

// Sends a tab the current list of its helpers, which the page draws in its Agents menu.
function pushAgents(owner) {
  const list = helperRegistry.snapshot(owner);
  for (const port of portsOfTab(owner)) port.postMessage({ type: 'agents', list });
}

const helperPool = DsxAgentPool.createAgentPool({
  open: async (job) => {
    const tab = await chrome.tabs.create({ url: `${PAGE_ORIGIN_PREFIX}#dsx-agent=${job.id}`, active: false });
    // The job may have been stopped while its tab was being made.
    if (!helperPool.get(job.id)) {
      chrome.tabs.remove(tab.id).catch(() => {});
      return;
    }
    job.tabId = tab.id;
    helperTabs.set(tab.id, job.id);
    helperRegistry.update(job.id, { tabId: tab.id });
    pushAgents(job.owner);
  },
  close: (job) => {
    if (job.tabId === undefined) return null;
    helperTabs.delete(job.tabId);
    return chrome.tabs.remove(job.tabId);
  },
  onUpdate: (job, state) => {
    if (state === 'running') helperRegistry.update(job.id, { state: 'running', startedAt: Date.now() });
    pushAgents(job.owner);
    tellOwner(job, { type: 'agent-update', id: job.toolId, note: state === 'queued' ? 'Waiting: two helpers are already working.' : '' });
  },
  onDone: (job, result) => {
    logDiagnostic('helper-done', result.status);
    helperRegistry.update(job.id, { state: result.status, endedAt: Date.now(), tabId: null });
    pushAgents(job.owner);
    tellOwner(job, { type: 'agent-result', id: job.toolId, status: result.status, text: result.text });
  },
});

// Brings a tab to the front, and its window with it.
async function focusTab(tabId) {
  try {
    const tab = await chrome.tabs.update(tabId, { active: true });
    if (tab && tab.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
    return true;
  } catch {
    // The tab is gone.
    return false;
  }
}

// The Agents menu: a helper that is working is in a tab of its own, which comes to the front. One that has
// ended has no tab, so its chat is opened in a new one, and that tab gets a way back.
async function openHelper(port, message) {
  const owner = tabIdOf(port);
  const entry = owner === undefined ? null : helperRegistry.findByTool(owner, message.id);
  if (!entry) return;
  if (entry.tabId !== null && (await focusTab(entry.tabId))) return;
  if (!entry.sessionId) return;
  for (const [tabId, viewer] of viewerTabs) {
    if (viewer.entry === entry.id && (await focusTab(tabId))) return;
  }
  const tab = await chrome.tabs.create({ url: `${PAGE_ORIGIN_PREFIX}a/chat/s/${entry.sessionId}`, active: true });
  viewerTabs.set(tab.id, { owner, entry: entry.id });
}

// "Back to the main chat", from the tab of a helper or from a tab opened to look at one.
async function backToOwner(port) {
  const tabId = tabIdOf(port);
  const jobId = helperTabs.get(tabId);
  const owner = jobId ? (helperRegistry.get(jobId) || {}).owner : (viewerTabs.get(tabId) || {}).owner;
  if (owner === undefined) return;
  if (!(await focusTab(owner))) return;
  // A tab that was only opened to look at a finished helper has done its job. A working helper's tab stays.
  if (viewerTabs.has(tabId)) chrome.tabs.remove(tabId).catch(() => {});
}

// What a helper's tab reports about itself: the chat it is in, and the figures DeepSeek gave for it.
function recordProgress(message) {
  const entry = helperRegistry.get(message.agentId);
  if (!entry || entry.state !== 'running') return;
  const patch = {};
  if (message.sessionId) patch.sessionId = message.sessionId;
  if (Number.isFinite(message.output)) patch.output = message.output;
  if (message.input === null || Number.isFinite(message.input)) patch.input = message.input;
  if (Number.isFinite(message.steps)) patch.steps = message.steps;
  helperRegistry.update(entry.id, patch);
  pushAgents(entry.owner);
}

chrome.tabs.onRemoved.addListener((tabId) => {
  viewerTabs.delete(tabId);
  const jobId = helperTabs.get(tabId);
  if (!jobId) return;
  helperTabs.delete(tabId);
  helperPool.finish(jobId, { status: 'failed', text: "The helper's tab was closed before it finished." });
});

function startHelper(port, message) {
  const owner = tabIdOf(port);
  if (owner === undefined) return;
  const task = String(message.task || '').trim();
  if (!task) {
    port.postMessage({ type: 'agent-result', id: message.id, status: 'failed', text: 'The helper was given no task.' });
    return;
  }
  const id = `${owner}-${message.id}`.replace(/[^\w.-]/g, '_');
  const description = String(message.description || '').trim().slice(0, 80);
  // A call replayed after a reload is already listed; it is started again as a new helper.
  helperRegistry.remove(id);
  helperRegistry.add({ id, toolId: message.id, owner, description });
  helperPool.submit({ id, toolId: message.id, owner, task, description });
  pushAgents(owner);
}

function answerHelperHello(port, message) {
  const job = helperPool.get(message.agentId);
  if (job) {
    port.postMessage({ type: 'agent-task', agentId: job.id, task: job.task });
    return;
  }
  // A helper tab nobody is waiting for any more, for instance after the worker restarted, is closed.
  const tabId = tabIdOf(port);
  if (tabId !== undefined) chrome.tabs.remove(tabId).catch(() => {});
}

function handleHelperMessage(port, message) {
  switch (message.type) {
    case 'agent-start':
      startHelper(port, message);
      break;
    case 'agent-cancel':
      helperPool.cancel(`${tabIdOf(port)}-${message.id}`.replace(/[^\w.-]/g, '_'));
      break;
    case 'agent-hello':
      answerHelperHello(port, message);
      break;
    case 'agent-progress':
      recordProgress(message);
      break;
    case 'agent-open':
      openHelper(port, message);
      break;
    case 'agent-dismiss':
      // Only takes the helper off the list. Its chat stays in the DeepSeek history.
      if (tabIdOf(port) !== undefined && helperRegistry.dismiss(tabIdOf(port), message.id)) pushAgents(tabIdOf(port));
      break;
    case 'agent-clear':
      if (tabIdOf(port) !== undefined && helperRegistry.clearFinished(tabIdOf(port))) pushAgents(tabIdOf(port));
      break;
    case 'agent-back':
      backToOwner(port);
      break;
    case 'agent-done':
      helperPool.finish(message.agentId, {
        status: message.status === 'ok' ? 'ok' : 'failed',
        text: String(message.text || '').slice(0, MAX_REPORT_CHARS),
      });
      break;
    default:
      // 'agent-ping' says nothing: it only keeps the worker awake while a helper is working.
      break;
  }
}

// A page that reconnects gets the reports that came while it was away. One that stays away is closed,
// and the helpers it asked for are stopped, since nobody is waiting for them.
function ownerConnected(tabId) {
  clearTimeout(ownerTimers.get(tabId));
  ownerTimers.delete(tabId);
  const messages = waitingForOwner.get(tabId);
  waitingForOwner.delete(tabId);
  for (const message of messages || []) for (const port of portsOfTab(tabId)) port.postMessage(message);
  // A page that was reloaded gets its list of helpers back, and a tab opened to look at one learns what it is.
  pushAgents(tabId);
  if (viewerTabs.has(tabId)) for (const port of portsOfTab(tabId)) port.postMessage({ type: 'agent-viewer' });
}

function ownerDisconnected(tabId) {
  if (tabId === undefined || portsOfTab(tabId).length) return;
  clearTimeout(ownerTimers.get(tabId));
  ownerTimers.set(tabId, setTimeout(() => {
    ownerTimers.delete(tabId);
    if (portsOfTab(tabId).length) return;
    waitingForOwner.delete(tabId);
    helperPool.cancelOwnedBy(tabId);
    helperRegistry.removeOwner(tabId);
  }, OWNER_GRACE_MS));
}

function handleTabMessage(port, message) {
  if (typeof message.type === 'string' && message.type.startsWith('agent-')) {
    handleHelperMessage(port, message);
    return;
  }
  switch (message.type) {
    case 'reload-state':
      if (reloadQuery) reloadQuery.answer(port, message.busy !== false);
      break;
    case 'check-update':
      checkForUpdate(message.force === true)
        .then((status) => port.postMessage({ type: 'update-status', forced: message.force === true, ...status }))
        // A forced lookup always gets an answer, so the command that asked is not left waiting.
        .catch(() => port.postMessage({ type: 'update-status', forced: message.force === true, available: false, failed: true }));
      break;
    case 'connect-host':
      connectHost();
      port.postMessage(hostStatus());
      break;
    case 'exec':
      connectHost();
      if (!nativePort) {
        port.postMessage({ type: 'exit', id: message.id, status: 'spawn_error', code: null, durationMs: 0, error: hostError });
        return;
      }
      jobOwners.set(message.id, port);
      logDiagnostic('exec', message.id);
      nativePort.postMessage(message);
      break;
    case 'pick-folder':
      connectHost();
      if (!nativePort) {
        port.postMessage({ type: 'folder-picked', id: message.id, path: null, error: hostError });
        return;
      }
      jobOwners.set(message.id, port);
      nativePort.postMessage(message);
      break;
    case 'read-instructions':
      connectHost();
      if (!nativePort) {
        port.postMessage({ type: 'instructions', id: message.id, text: '', files: [], error: hostError || 'The shell host is not connected.' });
        return;
      }
      jobOwners.set(message.id, port);
      nativePort.postMessage({ type: 'read-instructions', id: message.id, cwd: message.cwd });
      break;
    case 'mcp-list':
      connectHost();
      if (!nativePort) {
        port.postMessage({ type: 'mcp-servers', id: message.id, done: true, files: [], errors: [{ path: 'shell host', message: hostError || 'The shell host is not connected.' }], text: '[]', part: 0, parts: 1 });
        return;
      }
      nativePort.postMessage({ type: 'mcp-list', id: message.id, cwd: message.cwd });
      break;
    case 'kill':
      if (nativePort) nativePort.postMessage(message);
      break;
    case 'kill-job':
      // Stopping a background job from its card has no call waiting for an answer.
      if (nativePort) nativePort.postMessage({ type: 'killJob', job: message.job });
      break;
    default:
      break;
  }
}

chrome.runtime.onConnect.addListener((port) => {
  const sender = port.sender;
  const trusted = sender && sender.id === chrome.runtime.id && sender.origin === ALLOWED_ORIGIN;
  if (port.name !== 'dsx-tab' || !trusted) {
    logDiagnostic('port-rejected', { name: port.name, origin: sender && sender.origin, url: sender && sender.url });
    port.disconnect();
    return;
  }

  logDiagnostic('tab-connected', sender.origin);
  tabPorts.add(port);
  if (tabIdOf(port) !== undefined) ownerConnected(tabIdOf(port));
  port.onMessage.addListener((message) => handleTabMessage(port, message));
  port.onDisconnect.addListener(() => {
    tabPorts.delete(port);
    ownerDisconnected(tabIdOf(port));
    // Closing the tab stops whatever it started.
    for (const [id, owner] of jobOwners) {
      if (owner === port) {
        if (nativePort) nativePort.postMessage({ type: 'kill', id });
        jobOwners.delete(id);
      }
    }
  });
});
