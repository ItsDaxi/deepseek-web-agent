// Runs in the extension's isolated world. It owns the approval decision: nothing reaches the
// native host unless this script sends it.
(function () {
  'use strict';

  const { createCardStore } = globalThis.DsxCards;
  const { createPageControls, findComposerBox } = globalThis.DsxPageControls;
  const { createThinkCollapser } = globalThis.DsxThinkCollapse;
  const { createSlashCommands } = globalThis.DsxSlashCommands;

  // dismissedUpdate is the release tag whose notice the user closed.
  // evilOn: the user's own instructions, read from evil.txt, are added to the hidden prompt.
  const DEFAULT_SETTINGS = { mode: 'ask', cwd: '', maxAutoTurns: 25, collapseThinking: true, dismissedUpdate: '', evilOn: false };
  // Used only when the model leaves out the timeout it is asked to choose.
  const FALLBACK_TIMEOUT_SECONDS = 120;
  const READ_ONLY_TOOLS = new Set(['read', 'glob', 'grep']);
  // A poll only reports on a job the user already approved, and a kill only stops one.
  const JOB_TOOLS = new Set(['poll', 'kill']);
  // Always asks first in Manual mode, even inside the working directory. Paths arrive with forward slashes.
  const SENSITIVE_PATH = /(^|\/)(\.env(\.[^/]*)?|\.netrc|\.npmrc|\.pypirc|id_(rsa|dsa|ecdsa|ed25519)|credentials(\.[^/]*)?|[^/]*\.(pem|key|pfx|p12))$|(^|\/)(\.ssh|\.aws|\.gnupg)(\/|$)/i;
  const EXECUTED_KEY = 'dsx-executed-ids';
  // These match SENTINEL_PREFIX, RESULT_MARKER_PREFIX and MAX_MODEL_OUTPUT_CHARS in lib/protocol.js,
  // which only loads in the page world.
  const SENTINEL_PREFIX = 'dsx-tool:';
  const RESULT_MARKER = /^\s*dsx-result:\S+\s*$/;
  const MODEL_OUTPUT_LIMIT_CHARS = 20000;
  const RECONNECT_MS = 1000;
  const HOST_RETRY_MS = 5000;
  const OUTPUT_LIMIT_CHARS = 512 * 1024;

  let settings = { ...DEFAULT_SETTINGS };
  let hostInfo = null;
  let hostError = null;
  // The newer release the background script found, or null.
  let updateInfo = null;
  // Set while /update waits for the answer of the lookup it asked for.
  let pendingUpdateAnswer = null;
  let folderRequest = null;
  let folderError = null;
  let port = null;
  let autoTurns = 0;
  // The calls of the reply being read. They run one at a time, in the order the model wrote
  // them, and every result goes back together in one message once the whole turn is settled.
  let turn = null;
  const allowedChats = new Set();
  // The context meter. DeepSeek counts the tokens of each chat and says so at the end of every reply
  // and in the history of a chat. Nothing is counted here. contextLimit is the most a chat can hold.
  const chatTokens = new Map();
  let contextLimit = null;
  let shownContext = '';
  const WAITING = 'Waiting for the commands before it to finish.';

  const store = createCardStore({ onAction: handleAction });
  // DeepSeek has no setting to keep its "Thought for N seconds" blocks collapsed, so the extension does it.
  const thinkCollapser = createThinkCollapser({ enabled: () => settings.collapseThinking !== false });

  // ---- Settings and page configuration -------------------------------------------------------

  function postToPage(message) {
    window.postMessage({ source: 'dsx-content', ...message }, location.origin);
  }

  function pushConfig() {
    const env = hostInfo ? { ...hostInfo, cwd: settings.cwd, extra: settings.evilOn && extraPrompt ? extraPrompt.text : '' } : null;
    postToPage({ type: 'config', env });
  }

  // The user's own instructions, read from evil.txt by the host. Null until they are read.
  let extraPrompt = null;
  let pendingPromptFile = null;
  const PROMPT_ANSWER_MS = 5000;

  // Asks the host for the file. Resolves with its answer, or with an error if it never comes.
  function readPromptFile() {
    return new Promise((resolve) => {
      if (!port || !hostInfo) {
        resolve({ text: null, error: 'The shell host is not connected.' });
        return;
      }
      // An older host ignores the request and never answers, so it is named instead of waited for.
      if (!(hostInfo.features || []).includes('read-prompt')) {
        resolve({
          text: null,
          error: 'The installed shell host is older than this extension and cannot read evil.txt. Run the setup again, or node host/install.js in the project folder, then restart the browser.',
        });
        return;
      }
      const id = `prompt-${Date.now()}`;
      const timer = setTimeout(() => {
        pendingPromptFile = null;
        resolve({ text: null, error: 'The shell host did not answer.' });
      }, PROMPT_ANSWER_MS);
      pendingPromptFile = { id, pieces: [], done: (answer) => { clearTimeout(timer); resolve(answer); } };
      port.postMessage({ type: 'read-prompt', id });
    });
  }

  async function loadExtraPrompt() {
    const answer = await readPromptFile();
    extraPrompt = answer.text ? answer : null;
    pushConfig();
    return answer;
  }

  chrome.storage.local.get(DEFAULT_SETTINGS).then((stored) => {
    settings = stored;
    pushConfig();
    renderControls();
    thinkCollapser.scan();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (Object.keys(changes).every((key) => !(key in DEFAULT_SETTINGS))) return;
    for (const [key, change] of Object.entries(changes)) settings[key] = change.newValue;
    pushConfig();
    renderControls();
    thinkCollapser.scan();
  });

  // ---- Background connection -----------------------------------------------------------------

  // After the extension is reloaded, scripts already in a page can no longer reach it.
  function extensionAlive() {
    try {
      return Boolean(chrome.runtime && chrome.runtime.id);
    } catch {
      return false;
    }
  }

  function connect() {
    if (!extensionAlive()) {
      hostInfo = null;
      renderControls();
      return;
    }
    port = chrome.runtime.connect({ name: 'dsx-tab' });
    port.onMessage.addListener(handleBackgroundMessage);
    port.onDisconnect.addListener(() => {
      port = null;
      folderRequest = null;
      failRunningCommands();
      renderControls();
      setTimeout(connect, RECONNECT_MS);
    });
    port.postMessage({ type: 'connect-host' });
    port.postMessage({ type: 'check-update' });
  }

  // A lost connection also loses the command's exit message, so its card must not spin forever.
  function failRunningCommands() {
    for (const tool of store.list()) {
      if (tool.status !== 'running') continue;
      finishCommand({
        id: tool.id,
        status: 'spawn_error',
        code: null,
        durationMs: Date.now() - tool.startedAt,
        error: 'The connection to the shell host was lost, so the command may have stopped early.',
      });
    }
  }

  function handleBackgroundMessage(message) {
    switch (message.type) {
      case 'prepare-reload':
        // The extension is about to reload itself after an update. This page can follow it with a
        // reload only if that loses nothing.
        port.postMessage({ type: 'reload-state', busy: hasWorkInProgress() });
        break;
      case 'update-status':
        updateInfo = message.available ? { tag: message.tag, url: message.url } : null;
        renderControls();
        // A lookup the user asked for with /update is waiting for this answer.
        if (message.forced && pendingUpdateAnswer) {
          pendingUpdateAnswer(message);
          pendingUpdateAnswer = null;
        }
        break;
      case 'prompt-file':
        if (pendingPromptFile && message.id === pendingPromptFile.id) {
          // The text arrives in numbered pieces, and the answer is complete with the last one. A host
          // that sends it whole has no part numbers and is a single piece.
          pendingPromptFile.pieces.push(message.text || '');
          if (!(message.part < message.parts - 1)) {
            const done = pendingPromptFile.done;
            const text = pendingPromptFile.pieces.join('');
            pendingPromptFile = null;
            done({ ...message, text: message.error ? null : text });
          }
        }
        break;
      case 'host-status':
        hostInfo = message.connected ? message.info : null;
        hostError = message.connected ? null : message.error;
        pushConfig();
        renderControls();
        if (hostInfo) runApprovedCommands();
        // The file is read again each time the host connects, so an edit takes effect on a reload.
        if (hostInfo && settings.evilOn && !extraPrompt) loadExtraPrompt();
        break;
      case 'started':
        store.set(message.id, { shell: message.shell, cwd: message.cwd });
        break;
      case 'output':
        appendOutput(message.id, message.data);
        break;
      case 'folder-picked':
        finishFolderPick(message);
        break;
      case 'exit':
        finishCommand(message);
        break;
      default:
        break;
    }
  }

  // Something a reload of the page would lose: a call that is waiting, asking or running, a result
  // that has not been sent yet, or text the user has typed in the composer.
  function hasWorkInProgress() {
    const pending = store.list().some((tool) => PENDING.has(tool.status));
    const unsent = Boolean(turn && turn.results.length);
    const draft = [...document.querySelectorAll('textarea')].some((area) => area.value.trim() !== '');
    return pending || unsent || draft;
  }

  function appendOutput(id, data) {
    const tool = store.get(id);
    if (!tool) return;
    if ((tool.output || '').length >= OUTPUT_LIMIT_CHARS) {
      store.set(id, { truncated: true });
      return;
    }
    store.appendOutput(id, data);
  }

  // ---- Tool lifecycle ------------------------------------------------------------------------

  function executedIds() {
    try {
      return new Set(JSON.parse(sessionStorage.getItem(EXECUTED_KEY) || '[]'));
    } catch {
      return new Set();
    }
  }

  function markExecuted(id) {
    const ids = executedIds();
    ids.add(id);
    try {
      sessionStorage.setItem(EXECUTED_KEY, JSON.stringify([...ids]));
    } catch {
      // Storage can be blocked; the check only guards against re-running after a reload.
    }
  }

  function isBypassed(tool) {
    return settings.mode === 'bypass' || allowedChats.has(tool.sessionId);
  }

  // ---- One reply, several calls ----------------------------------------------------------------
  // The calls of the reply being read run one at a time, because they may touch the same files,
  // and their results go back together in one message once none is left pending.

  // A call in the reply that has to wait for the ones before it. It is deliberately *not*
  // 'awaiting': that status means the user is being asked, and a queued call must never look
  // like a question, especially in bypass mode where nothing should ever be asked.
  const QUEUED = 'queued';
  const PENDING = new Set(['writing', QUEUED, 'awaiting', 'running', 'no-host']);

  function currentTurn() {
    if (!turn) turn = { ids: [], results: [], closed: false };
    return turn;
  }

  function turnOf(id) {
    return currentTurn().ids.includes(id);
  }

  function recordResult(tool, result) {
    if (!turnOf(tool.id)) return false;
    const active = currentTurn();
    if (!active.results.some((entry) => entry.id === tool.id)) active.results.push({ id: tool.id, ...result });
    return true;
  }

  // Runs the next call in the reply, if the one before it has already finished. A call the model
  // is still writing holds everything after it, so the order the model wrote is what runs.
  function nextInTurn() {
    const active = currentTurn();
    const states = active.ids.map((id) => [id, store.get(id)?.status]);
    // Only one call runs at a time, and a call still being written must not be overtaken.
    if (states.some(([, status]) => ['running', 'no-host', 'writing'].includes(status))) return;
    // Only a queued call may start by itself. One that is awaiting a decision from the user
    // keeps waiting for it, or the order of the reply would skip the question.
    const pending = states.find(([, status]) => status === QUEUED);
    if (!pending) return;
    const [id] = pending;
    store.set(id, { status: 'awaiting', pausedReason: null });
    decide(id);
  }

  // Where a call goes once the ones before it are out of the way: it still has to earn its run.
  function decide(id) {
    const tool = store.get(id);
    if (!tool) return;
    if (isSafeRead(tool)) {
      runCommand(id);
      return;
    }
    if (!isBypassed(tool)) return;

    if (READ_ONLY_TOOLS.has(tool.kind)) {
      runCommand(id, { autoRun: true });
      return;
    }
    if (autoTurns >= settings.maxAutoTurns) {
      store.set(id, { pausedReason: `Paused after ${settings.maxAutoTurns} automatic changes in a row.` });
      return;
    }
    autoTurns += 1;
    runCommand(id, { autoRun: true });
  }

  // Sends the whole reply back at once, as soon as every call in it is done.
  function flushTurn() {
    const active = currentTurn();
    if (!active.results.length) return;
    if (active.ids.some((id) => store.get(id) && PENDING.has(store.get(id).status))) return;
    const { results } = active;
    turn = null;
    // One call arrives as one result, exactly as it always did.
    postToPage({ type: 'send-results', results, sessionId: store.get(results[0].id)?.sessionId });
  }

  // Reading sends file contents to DeepSeek, so it only runs unasked inside a folder the user chose.
  function isSafeRead(tool) {
    if (!READ_ONLY_TOOLS.has(tool.kind) || !settings.cwd) return false;
    const target = tool.path || '';
    const normalize = (value) => {
      const clean = value.replace(/[\\/]+/g, '/').replace(/\/$/, '');
      return hostInfo && hostInfo.platform === 'win32' ? clean.toLowerCase() : clean;
    };
    const path = normalize(target);
    if (SENSITIVE_PATH.test(path) || path.split('/').includes('..')) return false;
    if (!/^([a-z]:)?\//i.test(path)) return true;
    const base = normalize(settings.cwd);
    return path === base || path.startsWith(`${base}/`);
  }

  function handleToolCall(event) {
    const known = store.get(event.id);
    if (known && !['writing', undefined].includes(known.status)) return;

    const attributes = event.attributes || {};
    const tool = store.set(event.id, {
      kind: event.tool || 'shell',
      sessionId: event.sessionId,
      command: event.command,
      path: attributes.path || '',
      attributes,
      shell: attributes.shell || (hostInfo && hostInfo.defaultShell) || '',
      cwd: attributes.cwd || settings.cwd || '',
      timeoutSeconds: Number(attributes.timeout) || FALLBACK_TIMEOUT_SECONDS,
      status: 'awaiting',
      pausedReason: null,
    });

    if (executedIds().has(event.id)) {
      store.set(event.id, { status: 'interrupted' });
      return;
    }
    // Replayed streams always need a fresh decision, whatever the mode.
    if (!event.live) return;

    // A call that arrives after its reply was dealt with gets a turn of its own.
    if (currentTurn().closed) turn = null;
    const active = currentTurn();
    if (!active.ids.includes(event.id)) active.ids.push(event.id);
    // Anything still running or waiting holds this call back, so it does not race the ones
    // before it over the same files.
    if (active.ids.some((id) => id !== event.id && PENDING.has(store.get(id)?.status))) {
      store.set(event.id, { status: QUEUED, pausedReason: WAITING });
      return;
    }

    decide(event.id);
  }

  function runCommand(id, { autoRun = false } = {}) {
    const tool = store.get(id);
    if (!tool) return;
    if (!extensionAlive()) {
      store.set(id, { status: 'no-host', hostProblem: 'reload', pendingRun: false });
      renderControls();
      return;
    }
    if (!port || !hostInfo) {
      // The decision is already made, so the command starts as soon as the host is back.
      if (port) port.postMessage({ type: 'connect-host' });
      store.set(id, { status: 'no-host', hostProblem: null, pendingRun: true, autoRun });
      return;
    }
    markExecuted(id);
    store.set(id, { status: 'running', startedAt: Date.now(), output: '', autoRun, expanded: false, pausedReason: null, pendingRun: false, hostProblem: null });
    const attributes = tool.attributes;
    port.postMessage({
      ...attributes,
      type: 'exec',
      id,
      tool: tool.kind,
      command: tool.command,
      body: tool.command,
      shell: tool.shell || undefined,
      cwd: tool.cwd || undefined,
      timeoutMs: tool.timeoutSeconds * 1000,
      background: attributes.background === 'true',
      ...(tool.kind === 'poll' ? { waitMs: Number(attributes.wait) * 1000 || 0 } : {}),
    });
  }

  function runApprovedCommands() {
    for (const tool of store.list()) {
      if (tool.pendingRun) runCommand(tool.id, { autoRun: Boolean(tool.autoRun) });
    }
  }

  function finishCommand(message) {
    const tool = store.get(message.id);
    if (!tool) return;
    const output = message.error ? `${tool.output || ''}${message.error}` : tool.output || '';
    const truncated = message.truncated || tool.truncated || output.length > MODEL_OUTPUT_LIMIT_CHARS;
    // A background command answers at once with its job id, and the job runs on without the card.
    const started = message.started && message.job
      ? `Started as ${message.job}. It keeps running on its own; read it with a poll.`
      : null;
    const updated = store.set(message.id, {
      // A poll of a job that is still up ended fine; the job is what keeps running.
      status: message.running && tool.kind === 'poll' ? 'ok' : message.status,
      jobRunning: Boolean(message.running),
      code: message.code,
      durationMs: message.durationMs,
      job: message.job || tool.job || null,
      output: started || output,
      error: message.error || null,
      truncated,
      // Failures open by default because the output is what the user wants to see next.
      expanded: message.status === 'failed' || message.status === 'spawn_error',
    });
    const result = {
      status: message.status,
      code: message.code,
      durationMs: message.durationMs,
      output,
      // Inside a batch these two are what tie an output to the call that produced it.
      tool: tool.kind,
      command: tool.kind === 'shell' ? tool.command : tool.path || tool.command,
    };
    if (message.job) result.job = message.job;
    if (started) result.note = `The command keeps running as background job ${message.job}. Read it with poll id="${message.job}".`;
    sendResult(updated, result);
  }

  function sendResult(tool, result) {
    if (recordResult(tool, result)) {
      // The turn settles now rather than on the next stream event, so nothing waits for one.
      setTimeout(() => {
        nextInTurn();
        flushTurn();
      }, 0);
      return;
    }
    postToPage({ type: 'send-result', id: tool.id, sessionId: tool.sessionId, result });
  }

  function rejectCommand(id) {
    const tool = store.set(id, { status: 'rejected', expanded: false });
    sendResult(tool, { status: 'rejected', code: null, durationMs: 0, output: '', note: 'The user rejected this. It did not run.' });
  }

  function handleAction(action, id) {
    const tool = store.get(id);
    if (!tool) return;
    switch (action) {
      case 'run':
      case 'retry':
        autoTurns = 0;
        runCommand(id);
        break;
      case 'allow-chat':
        allowedChats.add(tool.sessionId);
        autoTurns = 0;
        runCommand(id);
        break;
      case 'reject':
        rejectCommand(id);
        break;
      case 'stop':
        // A background shell's card must end the job itself, not just the call that started it.
        if (tool.kind === 'shell' && tool.attributes?.background === 'true' && tool.job) {
          port?.postMessage({ type: 'kill-job', job: tool.job });
        } else if (port) port.postMessage({ type: 'kill', id });
        break;
      case 'resend':
        store.set(id, { sendFailed: false });
        sendResult(tool, { status: tool.status, code: tool.code, durationMs: tool.durationMs, output: tool.output || '' });
        break;
      default:
        break;
    }
  }

  // ---- Events from the page hook -------------------------------------------------------------

  function applyHistory({ tools, results }) {
    // A message that answered several calls reports one result per call.
    const flat = results.flatMap((result) => (Array.isArray(result) ? result : [result]));
    const resultById = new Map(flat.map((result) => [result.id, result]));
    for (const entry of tools) {
      if (store.get(entry.id)) continue;
      const result = resultById.get(entry.id);
      const attributes = entry.attributes || {};
      store.set(entry.id, {
        kind: entry.tool || 'shell',
        sessionId: entry.sessionId,
        command: entry.command,
        path: attributes.path || '',
        attributes,
        shell: attributes.shell || '',
        cwd: attributes.cwd || '',
        status: result ? (result.status === 'running' ? 'ok' : result.status) : entry.incomplete ? 'cancelled' : 'interrupted',
        code: result ? result.code : null,
        durationMs: result ? result.durationMs : 0,
        output: result ? result.output : '',
        truncated: result ? result.truncated : false,
      });
    }
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data || event.data.source !== 'dsx-page') return;
    const message = event.data;
    switch (message.type) {
      case 'tool-open':
        if (!store.get(message.id)) {
          store.set(message.id, { kind: message.tool || 'shell', sessionId: message.sessionId, command: '', status: 'writing' });
        }
        break;
      case 'tool-partial':
        if (store.get(message.id)?.status === 'writing') {
          store.set(message.id, { command: message.command, path: (message.attributes && message.attributes.path) || '' });
        }
        break;
      case 'tool-call':
        handleToolCall(message);
        break;
      case 'tool-incomplete':
        store.set(message.id, {
          kind: message.tool || 'shell',
          sessionId: message.sessionId,
          command: message.command,
          path: (message.attributes && message.attributes.path) || '',
          status: 'cancelled',
        });
        break;
      case 'user-turn':
        autoTurns = 0;
        turn = null;
        break;
      case 'stream-end':
        // Nothing more arrives for this reply. The calls still queued behind one another stay
        // queued and keep going in order; only the reply itself is closed to new calls.
        if (turn) turn.closed = true;
        break;
      case 'history':
        applyHistory(message);
        if (message.tokens && message.sessionId) {
          chatTokens.set(message.sessionId, message.tokens);
          renderContext();
        }
        break;
      case 'usage':
        chatTokens.set(message.sessionId, message.tokens);
        renderContext();
        break;
      case 'context-limit':
        contextLimit = message.tokens;
        renderContext();
        break;
      case 'result-failed':
        store.set(message.id, { sendFailed: true });
        break;
      default:
        break;
    }
  });

  // ---- DOM decoration ------------------------------------------------------------------------

  function decorateCodeBlocks() {
    for (const pre of document.querySelectorAll('pre')) {
      const text = (pre.textContent || '').trim();
      if (!text.startsWith(SENTINEL_PREFIX)) continue;
      const id = text.slice(SENTINEL_PREFIX.length);
      const block = pre.closest('.md-code-block') || pre.parentElement;
      if (!block) continue;
      block.classList.add('dsx-block');
      const existing = block.querySelector(':scope > dsx-card');
      if (existing && existing.dataset.toolId === id) continue;
      if (existing) existing.remove();
      store.mount(block, id);
      block.querySelector(':scope > dsx-card').dataset.toolId = id;
    }
  }

  function hideResultMessages() {
    for (const message of document.querySelectorAll('.ds-message, [data-virtual-list-item-key]')) {
      if (message.classList.contains('dsx-hidden') || !RESULT_MARKER.test(message.textContent || '')) continue;
      // Hide the whole list row (with its edit and copy buttons) when it holds only this message.
      const row = message.closest('[data-virtual-list-item-key]');
      const target = row && row.querySelectorAll('.ds-message').length === 1 ? row : message;
      target.classList.add('dsx-hidden');
    }
  }

  // Mutation callbacks run before the next paint, so raw markers are never drawn.
  new MutationObserver(() => {
    decorateCodeBlocks();
    hideResultMessages();
    controls.mount();
    renderContext();
  }).observe(document, { childList: true, subtree: true, characterData: true });

  // The meter shows the chat that is open. A new chat has no id in its address yet, so it shows 0.
  function renderContext() {
    let used = 0;
    for (const [sessionId, tokens] of chatTokens) {
      if (location.pathname.includes(sessionId)) {
        used = tokens;
        break;
      }
    }
    const key = `${used}/${contextLimit}`;
    if (key === shownContext) return;
    shownContext = key;
    controls.setContext({ used, limit: contextLimit });
  }

  // ---- Status pill ---------------------------------------------------------------------------

  function saveSettings(patch) {
    try {
      chrome.storage.local.set(patch);
    } catch {
      // The extension was reloaded; the pill already asks for a page reload.
    }
  }

  function startFolderPick() {
    if (folderRequest) return;
    if (!port || !hostInfo) {
      folderError = 'the shell host is not connected.';
      renderControls();
      return;
    }
    folderRequest = `pick-${Date.now()}`;
    folderError = null;
    port.postMessage({ type: 'pick-folder', id: folderRequest, start: settings.cwd || hostInfo.home });
    renderControls();
  }

  function finishFolderPick(message) {
    if (message.id !== folderRequest) return;
    folderRequest = null;
    folderError = message.error;
    if (message.path) saveSettings({ cwd: message.path });
    renderControls();
  }

  const controls = createPageControls({
    onPickFolder: startFolderPick,
    onChangeMode: (mode) => saveSettings({ mode }),
    onDismissUpdate: (tag) => saveSettings({ dismissedUpdate: tag }),
  });

  function renderControls() {
    controls.update({
      alive: extensionAlive(),
      settings,
      hostInfo,
      hostError,
      picking: Boolean(folderRequest),
      pickError: folderError,
      update: updateInfo,
    });
  }

  renderControls();

  thinkCollapser.start();

  // ---- Slash commands --------------------------------------------------------------------------
  // The menu only runs these after a real key press or click, so a script on the page cannot change
  // the permission mode by faking one. A command answers with { lines, error }, shown above the composer.
  const UPDATE_ANSWER_MS = 10000;

  function describeUpdate(answer) {
    if (answer.failed && !answer.latest) return { error: true, lines: ['GitHub could not be reached. Try again later.'] };
    const lines = [];
    if (answer.available) {
      // The pill comes back even if the user had closed it for this release.
      saveSettings({ dismissedUpdate: '' });
      lines.push(`Update available: ${answer.tag}.`, 'Click the blue pill at the top right to open the release page.');
    } else {
      lines.push(`You have the latest version (v${answer.current}).`);
    }
    if (answer.failed) lines.push('GitHub could not be reached just now, so this may be out of date.');
    return { lines };
  }

  // What to tell the user when evil.txt cannot be used.
  function describePromptProblem(answer) {
    if (answer.error === 'missing') return ['There is no evil.txt yet. Create it here and put your instructions in it:', answer.path];
    if (answer.error === 'empty') return ['evil.txt is empty. Put your instructions in it:', answer.path];
    return [answer.error || 'evil.txt could not be read.'];
  }

  // The file has no limit here. DeepSeek has one of its own, which is not known, so a very long text
  // only gets a warning.
  const LONG_PROMPT_CHARS = 100000;

  function describePromptSize(text) {
    const size = `${text.length} characters`;
    return text.length > LONG_PROMPT_CHARS ? `${size}, which is very long: DeepSeek may refuse a message this size` : size;
  }

  const PREVIEW_LINES = 6;
  const PREVIEW_LINE_CHARS = 110;

  const SLASH_COMMANDS = [
    {
      name: 'help',
      description: 'Show the available commands',
      run: () => ({
        lines: SLASH_COMMANDS.map((command) => {
          const options = command.args ? ` ${command.args.map((arg) => arg.value).join('|')}` : '';
          return `/${command.name}${options}: ${command.description}`;
        }),
      }),
    },
    {
      name: 'mode',
      description: 'Switch between manual and bypass',
      // Manual comes first, so a careless Enter right after "/mode " picks the safe one.
      args: [
        { value: 'manual', description: 'Ask before every command' },
        { value: 'bypass', description: 'Run commands without asking' },
      ],
      run: (arg) => {
        if (arg !== 'manual' && arg !== 'bypass') return { error: true, lines: ['Use /mode manual or /mode bypass.'] };
        const next = arg === 'bypass' ? 'bypass' : 'ask';
        if (settings.mode === next) return { lines: [`Already in ${arg} mode.`] };
        controls.playModeWave(next);
        saveSettings({ mode: next });
        return { lines: [next === 'bypass' ? 'Bypass: commands now run without asking.' : 'Manual: commands now ask before running.'] };
      },
    },
    {
      name: 'cd',
      description: 'Choose the working folder',
      run: () => {
        if (!port || !hostInfo) return { error: true, lines: ['The shell host is not connected.'] };
        startFolderPick();
        return { lines: ['Choose a folder in the dialog that opened.'] };
      },
    },
    {
      name: 'thinking',
      description: 'Keep the thinking blocks collapsed or not',
      args: [
        { value: 'collapse', description: 'Keep them collapsed' },
        { value: 'default', description: 'Leave them as DeepSeek shows them' },
      ],
      run: (arg) => {
        if (arg !== 'collapse' && arg !== 'default') return { error: true, lines: ['Use /thinking collapse or /thinking default.'] };
        saveSettings({ collapseThinking: arg === 'collapse' });
        return { lines: [arg === 'collapse' ? 'Thinking blocks are kept collapsed.' : 'Thinking blocks are left as DeepSeek shows them.'] };
      },
    },
    {
      name: 'status',
      description: 'Show the connection, mode and folder',
      run: () => ({
        lines: [
          `Extension: v${chrome.runtime.getManifest().version}${updateInfo ? ` (${updateInfo.tag} is available)` : ''}`,
          `Shell host: ${hostInfo ? `connected, ${hostInfo.defaultShell}` : 'not connected'}`,
          `Mode: ${settings.mode === 'bypass' ? 'bypass' : 'manual'}`,
          `Folder: ${settings.cwd || (hostInfo && hostInfo.home) || 'not set'}`,
          `Thinking blocks: ${settings.collapseThinking === false ? 'left as DeepSeek shows them' : 'kept collapsed'}`,
          `Your instructions (evil.txt): ${settings.evilOn ? (extraPrompt ? `on, ${extraPrompt.text.length} characters` : 'on, not read yet') : 'off'}`,
        ],
      }),
    },
    {
      name: 'evil',
      description: 'Add your own instructions from evil.txt to the hidden prompt',
      // Showing comes first, so a careless Enter right after "/evil " only reads.
      args: [
        { value: 'show', description: 'Show the file, and whether it is on' },
        { value: 'on', description: 'Add it to your next message in each chat' },
        { value: 'off', description: 'Stop adding it' },
        { value: 'reload', description: 'Read the file again after editing it' },
      ],
      run: async (arg) => {
        if (arg === 'off') {
          saveSettings({ evilOn: false });
          extraPrompt = null;
          pushConfig();
          return { lines: ['Your instructions are off. A chat that already has them is told to ignore them.'] };
        }
        if (arg === 'show') {
          const answer = await readPromptFile();
          const state = `State: ${settings.evilOn ? 'on' : 'off'}`;
          if (!answer.text) return { error: true, lines: [state, ...describePromptProblem(answer)] };
          const preview = answer.text.split('\n').filter((line) => line.trim()).slice(0, PREVIEW_LINES)
            .map((line) => (line.length > PREVIEW_LINE_CHARS ? `${line.slice(0, PREVIEW_LINE_CHARS)}…` : line));
          return { lines: [state, `File: ${answer.path}`, `Size: ${describePromptSize(answer.text)}`, '', ...preview] };
        }
        if (arg === 'on' || arg === 'reload') {
          const answer = await loadExtraPrompt();
          if (!answer.text) return { error: true, lines: describePromptProblem(answer) };
          const size = describePromptSize(answer.text);
          if (arg === 'reload') {
            return { lines: [settings.evilOn ? `Reloaded: ${size}.` : `The file reads fine (${size}), but it is off. Use /evil on.`] };
          }
          saveSettings({ evilOn: true });
          return { lines: [`On: ${size} from evil.txt.`, 'They go with your next message in each chat.'] };
        }
        return { error: true, lines: ['Use /evil show, on, off or reload.'] };
      },
    },
    {
      name: 'update',
      description: 'Look for a new version now',
      run: () => new Promise((resolve) => {
        if (!port) {
          resolve({ error: true, lines: ['The extension is not connected.'] });
          return;
        }
        // An answer that never comes must not leave the command waiting.
        const timer = setTimeout(() => {
          pendingUpdateAnswer = null;
          resolve({ error: true, lines: ['GitHub did not answer in time.'] });
        }, UPDATE_ANSWER_MS);
        pendingUpdateAnswer = (answer) => {
          clearTimeout(timer);
          resolve(describeUpdate(answer));
        };
        port.postMessage({ type: 'check-update', force: true });
      }),
    },
  ];

  createSlashCommands({
    commands: SLASH_COMMANDS,
    run: (name, arg) => SLASH_COMMANDS.find((command) => command.name === name).run(arg),
    findBox: findComposerBox,
  }).start();

  connect();

  // Picks up a host installed or fixed after the page loaded, with no reload needed.
  setInterval(() => {
    if (!extensionAlive()) renderControls();
    else if (port && !hostInfo) port.postMessage({ type: 'connect-host' });
  }, HOST_RETRY_MS);
})();
