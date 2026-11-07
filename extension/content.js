// Runs in the extension's isolated world. It owns the approval decision: nothing reaches the
// native host unless this script sends it.
(function () {
  'use strict';

  const { createCardStore } = globalThis.DsxCards;
  const { createPageControls, findComposerBox } = globalThis.DsxPageControls;
  const { createThinkCollapser } = globalThis.DsxThinkCollapse;
  const { createThinkCounter } = globalThis.DsxThinkTokens;
  const { createSlashCommands } = globalThis.DsxSlashCommands;
  const { modeLabel } = globalThis.DsxMenus;

  // mode is the permission preset: 'ask' (Read Only), 'workspace' (Workspace Write) or 'bypass' (Full access).
  // workspaces are the folders the user chose before, listed in the workspace menu; cwd is the current one.
  // thinking is the Effort switch, which drives DeepSeek's DeepThink. Search is always on.
  // dismissedUpdate is the release tag whose notice the user closed.
  // evilOn: the user's own instructions, read from evil.txt, are added to the hidden prompt.
  const DEFAULT_SETTINGS = { mode: 'ask', cwd: '', workspaces: [], thinking: true, maxAutoTurns: 25, collapseThinking: true, dismissedUpdate: '', evilOn: false };
  const MAX_WORKSPACES = 8;
  // Used only when the model leaves out the timeout it is asked to choose.
  const FALLBACK_TIMEOUT_SECONDS = 120;
  const READ_ONLY_TOOLS = new Set(['read', 'glob', 'grep']);
  // What Workspace Write lets through by itself, when the file is inside the workspace.
  const WORKSPACE_WRITE_TOOLS = new Set(['write', 'edit']);
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
  const thinkCounter = createThinkCounter({ format: globalThis.DsxFormatTokens.formatTokens });
  const thinkCollapser = createThinkCollapser({ enabled: () => settings.collapseThinking !== false });

  // ---- Settings and page configuration -------------------------------------------------------

  function postToPage(message) {
    window.postMessage({ source: 'dsx-content', ...message }, location.origin);
  }

  function pushConfig() {
    const env = hostInfo ? { ...hostInfo, cwd: settings.cwd, extra: settings.evilOn && extraPrompt ? extraPrompt.text : '' } : null;
    postToPage({ type: 'config', env, thinking: settings.thinking !== false });
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

  // The red theme and the evil logos (evil.css, logos.css) show only while /evil is on, so turning it
  // off brings the originals back. Turning it on or off plays the awakening animation, which switches
  // the look at the right moment (syncEvilLook); the library is optional so a missing file only skips it.
  // The tougher greetings on an empty chat (evil-greeting.js) come and go with the look.
  const greeting = globalThis.DsxEvilGreeting
    ? globalThis.DsxEvilGreeting.createEvilGreeting()
    : { start() {}, stop() {} };

  // Puts the page in the look the setting asks for. The animation calls this under its glitch, so it
  // reads the setting at that moment and works the same way for turning the look on and off.
  function syncEvilLook() {
    document.documentElement.toggleAttribute('data-dsx-evil', Boolean(settings.evilOn));
    if (settings.evilOn) greeting.start();
    else greeting.stop();
  }

  const awakening = globalThis.DsxEvilAwakening
    ? globalThis.DsxEvilAwakening.createEvilAwakening({ onActivate: syncEvilLook })
    : { play: syncEvilLook, isPlaying: () => false };

  // While the animation plays it decides when the look changes, so a settings change in between waits.
  function applyEvilLook() {
    if (awakening.isPlaying()) return;
    syncEvilLook();
  }

  chrome.storage.local.get(DEFAULT_SETTINGS).then((stored) => {
    settings = stored;
    applyEvilLook();
    pushConfig();
    renderControls();
    thinkCollapser.scan();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (Object.keys(changes).every((key) => !(key in DEFAULT_SETTINGS))) return;
    for (const [key, change] of Object.entries(changes)) settings[key] = change.newValue;
    applyEvilLook();
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
        // A page that just loaded has no text yet, so a reload reads evil.txt again.
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
    if (!isBypassed(tool) && !isWorkspaceWrite(tool)) return;

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

  // Sends the whole reply back at once, once the reply has ended and every call in it is done.
  // Until the reply has ended the model may still be writing another call, so a call that finishes
  // early cannot tell whether it is the last: sending then split one reply into several messages,
  // and the model answered each of them.
  function flushTurn() {
    const active = currentTurn();
    if (!active.closed) return;
    if (!active.results.length) return;
    if (active.ids.some((id) => store.get(id) && PENDING.has(store.get(id).status))) return;
    const { results } = active;
    turn = null;
    // One call arrives as one result, exactly as it always did.
    postToPage({ type: 'send-results', results, sessionId: store.get(results[0].id)?.sessionId });
  }

  // Reading sends file contents to DeepSeek, so it only runs unasked inside a folder the user chose.
  function isSafeRead(tool) {
    return READ_ONLY_TOOLS.has(tool.kind) && insideWorkspace(tool);
  }

  // Workspace Write: writes and edits inside the chosen folder run by themselves. Commands never do,
  // because a command can reach anywhere, and sensitive files always ask.
  function isWorkspaceWrite(tool) {
    return settings.mode === 'workspace' && WORKSPACE_WRITE_TOOLS.has(tool.kind) && insideWorkspace(tool);
  }

  // The tool's path is inside the folder the user chose, and is not a sensitive file.
  function insideWorkspace(tool) {
    if (!settings.cwd) return false;
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
        if (turn) {
          turn.closed = true;
          // Calls that finished while the reply was still coming in were waiting for this.
          nextInTurn();
          flushTurn();
        }
        break;
      case 'history':
        applyHistory(message);
        if (message.tokens && message.sessionId) {
          chatTokens.set(message.sessionId, message.tokens);
          renderContext();
        }
        break;
      case 'think-tokens':
        thinkCounter.update(message);
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

  // The blocks inside `root` (the whole page when it is left out), plus the one that holds it.
  function blocksIn(root) {
    if (!root) return document.querySelectorAll('pre');
    const found = new Set(root.querySelectorAll ? root.querySelectorAll('pre') : []);
    const holder = root.closest ? root.closest('pre') : null;
    if (holder) found.add(holder);
    if (root.matches && root.matches('pre')) found.add(root);
    return found;
  }

  function decorateCodeBlocks(root) {
    for (const pre of blocksIn(root)) {
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

  const MESSAGE_SELECTOR = '.ds-message, [data-virtual-list-item-key]';

  function hideResultMessages(root) {
    let messages = document.querySelectorAll(MESSAGE_SELECTOR);
    if (root) {
      const near = new Set(root.querySelectorAll ? root.querySelectorAll(MESSAGE_SELECTOR) : []);
      const holder = root.closest ? root.closest(MESSAGE_SELECTOR) : null;
      if (holder) near.add(holder);
      if (root.matches && root.matches(MESSAGE_SELECTOR)) near.add(root);
      messages = near;
    }
    for (const message of messages) {
      if (message.classList.contains('dsx-hidden') || !RESULT_MARKER.test(message.textContent || '')) continue;
      // Hide the whole list row (with its edit and copy buttons) when it holds only this message.
      const row = message.closest('[data-virtual-list-item-key]');
      const target = row && row.querySelectorAll('.ds-message').length === 1 ? row : message;
      target.classList.add('dsx-hidden');
    }
  }

  // Mutation callbacks run before the next paint, so raw markers are never drawn.
  // A token streaming into a long chat touches one small node, so only what changed is looked at.
  // Going over every block and message of the page on each mutation made scrolling stutter, because
  // the page's own list changes the DOM all the way while it is scrolled.
  new MutationObserver((records) => {
    const roots = new Set();
    for (const record of records) {
      const nodes = record.type === 'childList' ? record.addedNodes : [record.target];
      for (const node of nodes) {
        const element = node.nodeType === 1 ? node : node.parentElement;
        if (element) roots.add(element);
      }
    }
    for (const root of roots) {
      decorateCodeBlocks(root);
      hideResultMessages(root);
    }
    controls.mount();
    renderContext();
    thinkCounter.schedule();
  }).observe(document, { childList: true, subtree: true, characterData: true });

  // A full pass now and then catches anything the targeted ones could not tie to a changed node.
  const FULL_SCAN_MS = 1500;
  decorateCodeBlocks();
  hideResultMessages();
  setInterval(() => {
    decorateCodeBlocks();
    hideResultMessages();
  }, FULL_SCAN_MS);

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
    if (message.path) {
      // The newest folder goes first in the workspace list, once.
      const others = (settings.workspaces || []).filter((path) => !globalThis.DsxMenus.samePath(path, message.path));
      saveSettings({ cwd: message.path, workspaces: [message.path, ...others].slice(0, MAX_WORKSPACES) });
    }
    renderControls();
  }

  const controls = createPageControls({
    onPickFolder: startFolderPick,
    onChangeMode: (mode) => saveSettings({ mode }),
    onSelectWorkspace: (cwd) => saveSettings({ cwd }),
    onSetThinking: (thinking) => saveSettings({ thinking }),
    onDismissUpdate: (tag) => saveSettings({ dismissedUpdate: tag }),
    onToggleEvil: toggleEvilFromButton,
  });

  // The Evil Mode button in the sidebar does what /evil does and answers in the same small panel.
  let evilBusy = false;

  async function toggleEvilFromButton() {
    if (evilBusy) return;
    evilBusy = true;
    renderControls();
    try {
      const answer = await toggleEvil();
      if (answer && answer.lines && answer.lines.length) slashCommands.showMessage(answer.lines, answer.error);
    } catch (error) {
      slashCommands.showMessage([error && error.message ? error.message : 'Evil Mode failed.'], true);
    } finally {
      evilBusy = false;
      renderControls();
    }
  }

  function renderControls() {
    controls.update({
      alive: extensionAlive(),
      settings,
      hostInfo,
      hostError,
      picking: Boolean(folderRequest),
      pickError: folderError,
      update: updateInfo,
      evilBusy,
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

  // Turns the user's own instructions on or off. The /evil command and the Evil Mode button both do this.
  async function toggleEvil() {
    if (settings.evilOn) {
      saveSettings({ evilOn: false });
      settings.evilOn = false;
      extraPrompt = null;
      pushConfig();
      // The same animation as turning it on: it brings the original look back under its glitch.
      awakening.play();
      // Turning it off says nothing: the button and the original look already show it.
      return { lines: [] };
    }
    const answer = await loadExtraPrompt();
    if (!answer.text) return { error: true, lines: describePromptProblem(answer) };
    saveSettings({ evilOn: true });
    // Settings reach this script a moment later, so the look is switched on by the animation.
    settings.evilOn = true;
    awakening.play();
    // Turning it on says nothing either, except when the text is so long that DeepSeek may refuse it.
    return { lines: answer.text.length > LONG_PROMPT_CHARS ? [`On: ${describePromptSize(answer.text)} from evil.txt.`] : [] };
  }

  // The menu: three groups. Only commands that work are listed.
  const FEEDBACK_URL = 'https://github.com/ItsDaxi/deepseek-web-agent/issues/new';

  const SLASH_COMMANDS = [
    {
      name: 'file',
      group: 'Add',
      icon: 'paperclip',
      description: '',
      run: () => {
        controls.openFileDialog();
        return { lines: [] };
      },
    },
    {
      name: 'feedback',
      group: 'Add',
      icon: 'send',
      description: 'Record feedback about this session',
      run: () => {
        // Opens the issue page of the project in a new tab. Nothing is sent from here.
        window.open(FEEDBACK_URL, '_blank', 'noopener,noreferrer');
        return { lines: [] };
      },
    },
    {
      name: 'permission',
      group: 'Commands',
      icon: 'shield',
      description: 'Switch the permission preset (sandbox mode + approval policy)',
      keepText: true,
      run: () => {
        controls.openPermission(() => slashCommands.clearCommandText());
        return { lines: [] };
      },
    },
    {
      name: 'model',
      group: 'Commands',
      icon: 'database',
      description: 'Select the model for this conversation',
      keepText: true,
      run: () => {
        controls.openModel(() => slashCommands.clearCommandText());
        return { lines: [] };
      },
    },
    {
      name: 'status',
      group: 'Skills',
      icon: 'info',
      description: 'Show the connection, permissions and workspace',
      run: () => ({
        lines: [
          `Extension: v${chrome.runtime.getManifest().version}${updateInfo ? ` (${updateInfo.tag} is available)` : ''}`,
          `Shell host: ${hostInfo ? `connected, ${hostInfo.defaultShell}` : 'not connected'}`,
          `Permissions: ${modeLabel(settings.mode)}`,
          `Workspace: ${settings.cwd || (hostInfo && hostInfo.home) || 'not set'}`,
          `Effort: ${settings.thinking === false ? 'off' : 'on'}`,
          `Thinking blocks: ${settings.collapseThinking === false ? 'left as DeepSeek shows them' : 'kept collapsed'}`,
          `Your instructions (evil.txt): ${settings.evilOn ? (extraPrompt ? `on, ${extraPrompt.text.length} characters` : 'on, not read yet') : 'off'}`,
        ],
      }),
    },
    {
      name: 'thinking',
      group: 'Skills',
      icon: 'bolt',
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
      name: 'evil',
      group: 'Skills',
      icon: 'flame',
      description: 'Turn your own instructions from evil.txt on or off',
      // One command, no arguments: it switches. The file is read when it is turned on and again every
      // time the page loads, so an edit takes effect after a reload. Its text is never printed back.
      run: toggleEvil,
    },
    {
      name: 'update',
      group: 'Skills',
      icon: 'arrowUp',
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
    {
      name: 'help',
      group: 'Skills',
      icon: 'help',
      description: 'Show the available commands',
      run: () => ({
        lines: SLASH_COMMANDS.map((command) => {
          const options = command.args ? ` ${command.args.map((arg) => arg.value).join('|')}` : '';
          return `/${command.name}${options}${command.description ? `: ${command.description}` : ''}`;
        }),
      }),
    },
  ];

  const slashCommands = createSlashCommands({
    commands: SLASH_COMMANDS,
    run: (name, arg) => SLASH_COMMANDS.find((command) => command.name === name).run(arg),
    findBox: findComposerBox,
    icon: controls.icon,
  });
  slashCommands.start();

  connect();

  // Picks up a host installed or fixed after the page loaded, with no reload needed.
  setInterval(() => {
    if (!extensionAlive()) renderControls();
    else if (port && !hostInfo) port.postMessage({ type: 'connect-host' });
  }, HOST_RETRY_MS);
})();
