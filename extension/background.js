// Bridges DeepSeek tabs and the native host, and routes command output back to the tab that asked.
'use strict';

importScripts('lib/update-check.js');

const HOST_NAME = 'com.dsx.shell_host';
const ALLOWED_ORIGIN = 'https://chat.deepseek.com';
const MAX_DIAGNOSTICS = 30;
// The release is looked up at most once an hour, a failed try included. GitHub allows 60 requests an
// hour per address without logging in, so this stays far below it.
const UPDATE_CHECK_EVERY_MS = 60 * 60 * 1000;
const UPDATE_FETCH_TIMEOUT_MS = 8000;
const MAX_ETAG_CHARS = 200;

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
      return;
    }
    const owner = jobOwners.get(message.id);
    if (owner) owner.postMessage(message);
    if (message.type === 'exit' || message.type === 'folder-picked') jobOwners.delete(message.id);
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

async function lookUpLatestTag() {
  const { updateCheck } = await chrome.storage.local.get({ updateCheck: null });
  const age = updateCheck ? Date.now() - updateCheck.checkedAt : Infinity;
  if (age < UPDATE_CHECK_EVERY_MS) return updateCheck.tag;

  let entry;
  try {
    entry = { checkedAt: Date.now(), ...(await fetchLatestTag(updateCheck)), failed: false };
  } catch (error) {
    logDiagnostic('update-check-failed', error.message);
    // The last known release stays, so a short outage does not hide an update already found.
    entry = { checkedAt: Date.now(), tag: updateCheck ? updateCheck.tag : null, etag: updateCheck ? updateCheck.etag : null, failed: true };
  }
  await chrome.storage.local.set({ updateCheck: entry });
  return entry.tag;
}

async function checkForUpdate() {
  const { checkForUpdates } = await chrome.storage.local.get({ checkForUpdates: true });
  if (checkForUpdates === false) return { available: false };
  // Several tabs can ask at once, and they share one lookup.
  updateLookup = updateLookup || lookUpLatestTag().finally(() => { updateLookup = null; });
  const tag = await updateLookup;
  return DsxUpdateCheck.status(chrome.runtime.getManifest().version, tag);
}

function handleTabMessage(port, message) {
  switch (message.type) {
    case 'check-update':
      checkForUpdate()
        .then((status) => port.postMessage({ type: 'update-status', ...status }))
        .catch(() => {});
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
  port.onMessage.addListener((message) => handleTabMessage(port, message));
  port.onDisconnect.addListener(() => {
    tabPorts.delete(port);
    // Closing the tab stops whatever it started.
    for (const [id, owner] of jobOwners) {
      if (owner === port) {
        if (nativePort) nativePort.postMessage({ type: 'kill', id });
        jobOwners.delete(id);
      }
    }
  });
});
