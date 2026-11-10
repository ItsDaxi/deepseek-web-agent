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
  const { createChatStats, formatStats } = globalThis.DsxChatStats;
  const { createTerminal } = globalThis.DsxTerminal;

  // mode is the permission preset: 'ask' (Read Only), 'workspace' (Workspace Write) or 'bypass' (Full access).
  // workspaces are the folders the user chose before, listed in the workspace menu; cwd is the current one.
  // thinking is the Effort switch, which drives DeepSeek's DeepThink. Search is always on.
  // dismissedUpdate is the release tag whose notice the user closed.
  const DEFAULT_SETTINGS = { mode: 'ask', cwd: '', workspaces: [], thinking: true, maxAutoTurns: 25, collapseThinking: true, dismissedUpdate: '', terminalOpen: false, terminalWidth: 440, helperRetryMs: 0 };
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
  // What the context meter counts against. The limit in DeepSeek's model settings (about 890K) is the
  // most the page accepts in one message, not the size of the model's window, which is taken as 1M. If the
  // settings ever name a bigger limit, that one is used.
  const CONTEXT_WINDOW_TOKENS = 1000000;

  // ---- Helpers (sub-agents) ------------------------------------------------------------------
  // A helper is a DeepSeek chat the extension opens in a tab of its own for one task. The tab runs this same
  // script, which then works as a helper: it sends the task, runs the tool calls the model writes (only what
  // needs no approval, since nobody is there to give it), and hands the final answer back to the chat that
  // asked. DeepSeek lets an account generate in two chats at once, so the background script keeps at most
  // two helpers working (lib/agent-pool.js); the main chat waits for them with nothing generating.
  const HELPER_KEY = 'dsx-helper';
  const HELPER_HASH = /[#&]dsx-agent=([\w.-]+)/;
  // The model requests a helper may make before it is stopped, so a helper that loops cannot go on forever.
  const MAX_HELPER_STEPS = 40;
  const MAX_HELPER_RETRIES = 4;
  // How long to wait before trying again after DeepSeek refuses a message, by the reason it gives.
  const HELPER_RETRY_MS = { parallel_chat_limit: 20000, rate_limit_reached: 45000 };
  const HELPER_RETRY_DEFAULT_MS = 15000;
  const HELPER_PING_MS = 20000;
  const HELPER_NOTE = 'A helper cannot ask the user for approval, so this was not run. If you need it, say so in your report.';

  // Set in a helper's tab: { id, sent, replied, steps, retries }. Null in every other tab. It is kept in
  // sessionStorage, which lives as long as the tab, so a reload of the page does not make it forget.
  const helper = readHelper();
  let helperHelloDone = false;
  let helperFinished = false;
  let helperRetryTimer = null;
  let helperError = null;
  let helperFinal = null;

  function readHelper() {
    let state = null;
    try {
      state = JSON.parse(sessionStorage.getItem(HELPER_KEY) || 'null');
    } catch {
      state = null;
    }
    const named = HELPER_HASH.exec(location.hash);
    if (named && (!state || state.id !== named[1])) state = { id: named[1], sent: false, replied: false, steps: 0, retries: 0 };
    if (state) saveHelper(state);
    return state;
  }

  function saveHelper(state = helper) {
    try {
      sessionStorage.setItem(HELPER_KEY, JSON.stringify(state));
    } catch {
      // Storage can be blocked; the helper then loses its count when the page reloads.
    }
  }

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
  // and in the history of a chat. Nothing is counted here. contextLimit is what the meter counts against.
  const chatTokens = new Map();
  let contextLimit = CONTEXT_WINDOW_TOKENS;
  let shownContext = '';
  const WAITING = 'Waiting for the commands before it to finish.';

  // The figures of the stats line, kept for the life of the tab so a reload of the page does not lose them.
  const STATS_KEY = 'dsx-chat-stats';
  const SESSION_IN_PATH = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  const chatStats = createChatStats({
    store: {
      read: () => JSON.parse(sessionStorage.getItem(STATS_KEY) || 'null'),
      write: (value) => sessionStorage.setItem(STATS_KEY, JSON.stringify(value)),
    },
  });
  let shownStats = null;

  // The side terminal: the user's own commands, through the same native host. See terminal.js.
  const terminal = createTerminal({
    host: () => hostInfo,
    workspace: () => settings.cwd,
    send: (message) => {
      if (!port || !hostInfo) return false;
      port.postMessage(message);
      return true;
    },
    onState: ({ open, width }) => {
      controls.setTerminalOpen(open);
      if (settings.terminalOpen !== open || settings.terminalWidth !== width) saveSettings({ terminalOpen: open, terminalWidth: width });
    },
  });

  const store = createCardStore({ onAction: handleAction });
  // DeepSeek has no setting to keep its "Thought for N seconds" blocks collapsed, so the extension does it.
  const thinkCounter = createThinkCounter({ format: globalThis.DsxFormatTokens.formatTokens });
  const thinkCollapser = createThinkCollapser({ enabled: () => settings.collapseThinking !== false });

  // ---- Settings and page configuration -------------------------------------------------------

  function postToPage(message) {
    window.postMessage({ source: 'dsx-content', ...message }, location.origin);
  }

  function pushConfig() {
    // A helper cannot ask the user to approve a call, so it is never told about the MCP tools.
    const mcp = helper ? [] : mcpServers.filter((server) => server.status === 'ready' && server.tools.length);
    const env = hostInfo ? { ...hostInfo, cwd: settings.cwd, extra: buildExtra(), mcp } : null;
    postToPage({ type: 'config', env, thinking: settings.thinking !== false, agent: Boolean(helper) });
  }

  // AGENTS.md and CLAUDE.md, in the user's folder and in the working folder and above it, as the host
  // read them: { text, files }. They go to the model with everything else the user keeps for it.
  let instructions = { text: '', files: [] };
  let instructionsSeq = 0;
  let pendingInstructions = null;

  // All the text added to the hidden prompt: the instruction files.
  function buildExtra() {
    return instructions.text;
  }
  const PROMPT_ANSWER_MS = 5000;

  // Asks the host for the instruction files of the current working folder. An older host that cannot
  // read them, or one that does not answer, simply gives none.
  function readInstructionFiles() {
    return new Promise((resolve) => {
      if (pendingInstructions) pendingInstructions.done({ text: '', files: [], stale: true });
      if (!port || !hostInfo || !(hostInfo.features || []).includes('read-instructions')) {
        resolve({ text: '', files: [] });
        return;
      }
      const id = `instructions-${Date.now()}`;
      const timer = setTimeout(() => {
        pendingInstructions = null;
        resolve({ text: '', files: [], error: 'The shell host did not answer.' });
      }, PROMPT_ANSWER_MS);
      pendingInstructions = { id, pieces: [], done: (answer) => { clearTimeout(timer); resolve(answer); } };
      port.postMessage({ type: 'read-instructions', id, cwd: settings.cwd || hostInfo.home || '' });
    });
  }

  // Reads them again: when the host connects and each time the working folder changes. Only the newest
  // answer is kept, so a slow one cannot undo a later one.
  async function loadInstructions() {
    instructionsSeq += 1;
    const seq = instructionsSeq;
    const answer = await readInstructionFiles();
    if (seq !== instructionsSeq || answer.stale) return;
    instructions = { text: answer.text || '', files: answer.files || [] };
    pushConfig();
  }

  // The MCP servers of the user's Claude Code and Codex setups, as the host reports them: one entry per
  // server with its state and its tools. The host sends the whole list each time something changes, in
  // numbered pieces that are joined here.
  let mcpServers = [];
  let mcpInfo = { files: [], errors: [], done: false, asked: false };
  let mcpPieces = [];

  // Asks the host to read the MCP config for the working folder and start the servers. Only the main
  // chat does it: a helper does not use them. An older host does not know the request.
  function loadMcp() {
    if (helper || !port || !hostInfo || !(hostInfo.features || []).includes('mcp')) return;
    mcpInfo = { ...mcpInfo, asked: true, done: false };
    port.postMessage({ type: 'mcp-list', id: `mcp-${Date.now()}`, cwd: settings.cwd || hostInfo.home || '' });
  }

  function receiveMcpServers(message) {
    if (!(message.part > 0)) mcpPieces = [];
    mcpPieces.push(message.text || '');
    if (message.part < message.parts - 1) return;
    let servers = [];
    try {
      servers = JSON.parse(mcpPieces.join(''));
    } catch {
      servers = [];
    }
    mcpPieces = [];
    mcpServers = Array.isArray(servers) ? servers : [];
    mcpInfo = { files: message.files || [], errors: message.errors || [], done: Boolean(message.done), asked: true };
    pushConfig();
  }

  chrome.storage.local.get(DEFAULT_SETTINGS).then((stored) => {
    settings = stored;
    pushConfig();
    renderControls();
    thinkCollapser.scan();
    // The terminal comes back as the user left it.
    if (settings.terminalOpen) terminal.open(settings.terminalWidth);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (Object.keys(changes).every((key) => !(key in DEFAULT_SETTINGS))) return;
    for (const [key, change] of Object.entries(changes)) settings[key] = change.newValue;
    if (changes.cwd) terminal.setWorkspace(settings.cwd);
    if (changes.cwd && hostInfo) {
      loadInstructions();
      loadMcp();
    }
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
    sendHelperFinal();
  }

  // A lost connection also loses the command's exit message, so its card must not spin forever.
  function failRunningCommands() {
    terminal.connectionLost();
    for (const tool of store.list()) {
      // A helper keeps working in its own tab, and its answer waits for this tab to reconnect.
      if (tool.status !== 'running' || tool.kind === 'agent') continue;
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
    // The host's answers to a command typed in the terminal belong to the terminal and to no card.
    if (typeof message.id === 'string' && message.id.startsWith('term-')) {
      terminal.handleMessage(message);
      return;
    }
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
      case 'instructions':
        if (pendingInstructions && message.id === pendingInstructions.id) {
          pendingInstructions.pieces.push(message.text || '');
          if (!(message.part < message.parts - 1)) {
            const done = pendingInstructions.done;
            const text = pendingInstructions.pieces.join('');
            pendingInstructions = null;
            done({ text: message.error ? '' : text, files: message.files || [], error: message.error || null });
          }
        }
        break;
      case 'host-status':
        hostInfo = message.connected ? message.info : null;
        terminal.hostChanged();
        hostError = message.connected ? null : message.error;
        pushConfig();
        renderControls();
        if (hostInfo) runApprovedCommands();
        if (hostInfo) loadInstructions();
        if (hostInfo) loadMcp();
        helperHello();
        break;
      case 'mcp-servers':
        receiveMcpServers(message);
        break;
      case 'agent-task':
        if (helper && message.agentId === helper.id && !helper.sent) {
          postToPage({ type: 'send-prompt', task: message.task });
        }
        break;
      case 'agents':
        agentList = Array.isArray(message.list) ? message.list : [];
        renderAgents();
        break;
      case 'agent-viewer':
        controls.setBack(true);
        break;
      case 'agent-update':
        // A helper waiting for a free place says so on its card.
        if (store.get(message.id)?.status === 'running') store.set(message.id, { output: message.note || '' });
        break;
      case 'agent-result':
        finishAgent(message);
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
    // Only one call runs at a time, and a call still being written must not be overtaken. A helper that is
    // working does not count: it touches nothing here, so the calls of the reply go on beside it.
    if (states.some(([id, status]) => ['running', 'no-host', 'writing'].includes(status) && !isWorkingHelper(id))) return;
    // Only a queued call may start by itself. One that is awaiting a decision from the user
    // keeps waiting for it, or the order of the reply would skip the question.
    const pending = states.find(([, status]) => status === QUEUED);
    if (!pending) return;
    const [id] = pending;
    store.set(id, { status: 'awaiting', pausedReason: null });
    decide(id);
  }

  // A helper that is working on its task.
  function isWorkingHelper(id) {
    const tool = store.get(id);
    return Boolean(tool && tool.kind === 'agent' && tool.status === 'running');
  }

  // Where a call goes once the ones before it are out of the way: it still has to earn its run.
  // In a helper's tab nobody can be asked, so what would wait for the user is refused instead.
  function decide(id) {
    const tool = store.get(id);
    if (!tool) return;
    if (helper && tool.kind === 'agent') {
      refuseCommand(id, 'A helper cannot start other helpers. Do the work yourself, or say in your report what is left.');
      return;
    }
    if (isSafeRead(tool)) {
      runCommand(id);
      return;
    }
    if (!isBypassed(tool) && !isWorkspaceWrite(tool)) {
      if (helper) refuseCommand(id, HELPER_NOTE);
      return;
    }

    if (READ_ONLY_TOOLS.has(tool.kind)) {
      runCommand(id, { autoRun: true });
      return;
    }
    if (autoTurns >= settings.maxAutoTurns) {
      if (helper) refuseCommand(id, `${HELPER_NOTE} (${settings.maxAutoTurns} automatic changes in a row is the limit.)`);
      else store.set(id, { pausedReason: `Paused after ${settings.maxAutoTurns} automatic changes in a row.` });
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
    // A helper starts at once, beside the other calls of the reply, so that several helpers in one reply
    // work at the same time. The background script decides how many may.
    if (tool.kind === 'agent' && !helper) {
      startAgent(event.id);
      return;
    }
    // Anything still running or waiting holds this call back, so it does not race the ones
    // before it over the same files. A helper that is working holds nothing back.
    if (active.ids.some((id) => id !== event.id && PENDING.has(store.get(id)?.status) && !isWorkingHelper(id))) {
      store.set(event.id, { status: QUEUED, pausedReason: WAITING });
      return;
    }

    decide(event.id);
  }

  // Hands the task to the background script, which opens the helper's chat when a place is free.
  function startAgent(id) {
    const tool = store.get(id);
    if (!tool) return;
    if (!extensionAlive()) {
      store.set(id, { status: 'no-host', hostProblem: 'reload', pendingRun: false });
      renderControls();
      return;
    }
    if (!port || !hostInfo) {
      if (port) port.postMessage({ type: 'connect-host' });
      store.set(id, { status: 'no-host', hostProblem: null, pendingRun: true, autoRun: true });
      return;
    }
    markExecuted(id);
    store.set(id, { status: 'running', startedAt: Date.now(), output: '', autoRun: true, expanded: false, pausedReason: null, pendingRun: false, hostProblem: null });
    port.postMessage({ type: 'agent-start', id, task: tool.command, description: tool.attributes?.description || '' });
  }

  // The helper's report, or the reason it ended without one, goes back to the model like any other result.
  function finishAgent(message) {
    const tool = store.get(message.id);
    if (!tool || tool.status !== 'running') return;
    const status = ['ok', 'stopped', 'timeout'].includes(message.status) ? message.status : 'failed';
    const output = message.text || '';
    const durationMs = Date.now() - (tool.startedAt || Date.now());
    const updated = store.set(message.id, {
      status,
      durationMs,
      output,
      code: null,
      truncated: output.length > MODEL_OUTPUT_LIMIT_CHARS,
      expanded: status !== 'ok',
    });
    sendResult(updated, {
      status,
      code: null,
      durationMs,
      output,
      tool: 'agent',
      command: tool.attributes?.description || firstLineOf(tool.command),
    });
  }

  // "server.tool", how an MCP call is named in a result.
  function mcpName(tool) {
    return `${tool.attributes?.server || '?'}.${tool.attributes?.tool || '?'}`;
  }

  function firstLineOf(text) {
    return String(text || '').split('\n')[0].slice(0, 120);
  }

  function runCommand(id, { autoRun = false } = {}) {
    const tool = store.get(id);
    if (!tool) return;
    // A helper is not a command: it is started through the background script, not the shell host.
    if (tool.kind === 'agent') {
      if (helper) refuseCommand(id, 'A helper cannot start other helpers.');
      else startAgent(id);
      return;
    }
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
      // The tag's own `tool` attribute is the MCP tool; the message's `tool` says it is an MCP call. Without a
      // timeout from the model, the host uses the one in the server's config.
      ...(tool.kind === 'mcp' ? { mcpTool: attributes.tool || '', timeoutMs: Number(attributes.timeout) > 0 ? Number(attributes.timeout) * 1000 : undefined } : {}),
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
      command: tool.kind === 'shell' ? tool.command : tool.kind === 'mcp' ? mcpName(tool) : tool.path || tool.command,
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

  function refuseCommand(id, note) {
    const tool = store.set(id, { status: 'rejected', expanded: false });
    sendResult(tool, { status: 'rejected', code: null, durationMs: 0, output: '', note });
  }

  function rejectCommand(id) {
    refuseCommand(id, 'The user rejected this. It did not run.');
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
        // Stopping a helper closes its chat; its card then ends with what it had.
        if (tool.kind === 'agent') {
          if (port) port.postMessage({ type: 'agent-cancel', id });
          break;
        }
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

  // ---- A helper's own tab ----------------------------------------------------------------------

  // Asks the background script for the task. It is asked once for each load of the page; the answer is
  // only used while the task has not been sent, so a reconnection never sends it twice.
  function helperHello() {
    if (!helper || helperHelloDone || helperFinished || !port) return;
    helperHelloDone = true;
    port.postMessage({ type: 'agent-hello', agentId: helper.id });
  }

  // Tells the background script which chat this helper is in and how many tokens it has used, for the Agents
  // menu of the chat that asked. The figures are the same ones the stats line under the composer shows.
  function helperProgress(sessionId) {
    if (!helper || helperFinished || !port || !sessionId) return;
    const summary = chatStats.summary(sessionId);
    port.postMessage({
      type: 'agent-progress',
      agentId: helper.id,
      sessionId,
      steps: summary ? summary.steps : helper.steps,
      output: summary ? summary.output : 0,
      input: summary ? summary.input : null,
    });
  }

  function helperStreamStart(sessionId) {
    if (!helper || helperFinished) return;
    helperError = null;
    helper.sent = true;
    helper.steps += 1;
    saveHelper();
    helperProgress(sessionId);
    if (helper.steps > MAX_HELPER_STEPS) {
      helperFinish('failed', `The helper was stopped after ${MAX_HELPER_STEPS} requests without finishing its report.`);
    }
  }

  // The reply is over. One that holds a tool call is not the end: the calls run and their results make the
  // next request. One that holds none is the report. One that DeepSeek refused is tried again later.
  function helperReplyEnd(message) {
    if (!helper || helperFinished || message.live !== true) return;
    if (message.failed || helperError) {
      helperRetry(helperError || 'error');
      return;
    }
    helper.replied = true;
    saveHelper();
    if (message.toolCalled) return;
    const report = String(message.answer || '').trim();
    if (!report) {
      helperRetry('empty');
      return;
    }
    helperFinish('ok', report);
  }

  // DeepSeek says no with a 200 answer: "parallel_chat_limit" when a third chat generates at once, and
  // "rate_limit_reached" when messages come too fast. Both pass, so the message is sent again after a wait.
  // The opening message cannot simply be sent again, because its chat is empty and the page would no longer
  // treat the message as the first, so the tab starts over from the home page instead.
  function helperRetry(reason) {
    if (!helper || helperFinished || helperRetryTimer) return;
    helper.retries += 1;
    saveHelper();
    if (helper.retries > MAX_HELPER_RETRIES) {
      helperFinish('failed', `DeepSeek kept refusing the helper's messages (${reason}), so it gave up.`);
      return;
    }
    // helperRetryMs is for the tests, which cannot wait the better part of a minute.
    const wait = Number(settings.helperRetryMs) || HELPER_RETRY_MS[reason] || HELPER_RETRY_DEFAULT_MS;
    helperRetryTimer = setTimeout(() => {
      helperRetryTimer = null;
      helperError = null;
      if (helper.replied) {
        postToPage({ type: 'resend-last' });
        return;
      }
      helper.sent = false;
      saveHelper();
      if (location.pathname === '/') location.reload();
      else location.href = `${location.origin}/#dsx-agent=${helper.id}`;
    }, wait);
  }

  // Hands the report to the background script, which closes this tab and answers the chat that asked.
  function helperFinish(status, text) {
    if (!helper || helperFinished) return;
    helperFinished = true;
    clearTimeout(helperRetryTimer);
    helperFinal = { type: 'agent-done', agentId: helper.id, status, text };
    sendHelperFinal();
  }

  // A report that cannot go out now, because the connection is being restored, goes out when it is back.
  function sendHelperFinal() {
    if (!helperFinal || !port) return;
    port.postMessage(helperFinal);
    helperFinal = null;
  }

  if (helper) {
    // A service worker that is not spoken to goes to sleep, and with it the count of helpers.
    setInterval(() => {
      if (port) port.postMessage({ type: 'agent-ping' });
    }, HELPER_PING_MS);
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
        chatStats.userTurn(message.sessionId, message.first === true);
        break;
      case 'stream-start':
        chatStats.streamStart(message.sessionId, message.at);
        helperStreamStart(message.sessionId);
        break;
      case 'stream-error':
        // DeepSeek refused the message inside a normal answer (see stream-filter.js).
        if (helper && message.live !== false) helperError = message.reason || 'error';
        break;
      case 'prompt-failed':
        if (helper) helperRetry('prompt');
        break;
      case 'first-token':
        chatStats.firstToken(message.sessionId, message.at);
        break;
      case 'reply-end':
        chatStats.replyEnd(message.sessionId, message.at, message.tokens, message.live === true);
        renderStats();
        helperProgress(message.sessionId);
        helperReplyEnd(message);
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
          chatStats.usage(message.sessionId, message.tokens);
          renderContext();
          renderStats();
        }
        break;
      case 'think-tokens':
        thinkCounter.update(message);
        break;
      case 'usage':
        chatTokens.set(message.sessionId, message.tokens);
        chatStats.usage(message.sessionId, message.tokens);
        renderContext();
        renderStats();
        helperProgress(message.sessionId);
        break;
      case 'context-limit':
        contextLimit = Math.max(message.tokens, CONTEXT_WINDOW_TOKENS);
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
    renderStats();
    renderAgents();
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

  // The stats line under the composer, for the chat that is open. A new chat has no id in its address
  // and no line: it shows the glow instead.
  function renderStats() {
    const match = SESSION_IN_PATH.exec(location.pathname);
    const text = match ? formatStats(chatStats.summary(match[0]), globalThis.DsxFormatTokens.formatTokens) : '';
    if (text === shownStats) return;
    shownStats = text;
    controls.setStats(text);
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
    onToggleTerminal: () => terminal.toggle(),
    // A row of the Agents menu: the helper's tab comes to the front, or its chat opens in a new one.
    onOpenAgent: (id) => { if (port) port.postMessage({ type: 'agent-open', id }); },
    // The X on a finished helper, and "Clear finished": they only take helpers off the list.
    onDismissAgent: (id) => { if (port) port.postMessage({ type: 'agent-dismiss', id }); },
    onClearAgents: () => { if (port) port.postMessage({ type: 'agent-clear' }); },
    // The way back from a helper's tab, or from the chat of a helper that ended, to the main chat.
    onBack: () => { if (port) port.postMessage({ type: 'agent-back' }); },
  });

  // ---- Agents menu -----------------------------------------------------------------------------
  // The background script keeps the list of helpers for this tab. The page shows the ones of the chat that
  // is open, so another chat in the same tab does not list them.
  let agentList = [];

  function renderAgents() {
    const match = SESSION_IN_PATH.exec(location.pathname);
    controls.setAgents(globalThis.DsxAgentView.visibleAgents(helper ? [] : agentList, match ? match[0] : null));
  }

  // A helper's tab and a tab opened to look at a helper's chat both offer the way back.
  if (helper) controls.setBack(true);

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

  // For /status: which instruction files the model was given, one path to a line.
  function describeInstructions() {
    if (!instructions.files.length) return ['Instruction files (AGENTS.md, CLAUDE.md): none found'];
    return [
      `Instruction files (AGENTS.md, CLAUDE.md): ${instructions.files.length} found, ${instructions.text.length} characters`,
      ...instructions.files.map((file) => `  ${file.path}${file.cut ? ' (cut)' : ''}`),
    ];
  }

  // For /status: the MCP servers found in the user's Claude Code and Codex setups, and what each one gives.
  function describeMcp() {
    if (!hostInfo || !(hostInfo.features || []).includes('mcp')) {
      return ['MCP servers: the installed shell host is older than this extension. Run the setup again, or node host/install.js, then restart the browser'];
    }
    const lines = mcpServers.map((server) => {
      const state = server.status === 'ready'
        ? `${server.tools.length + (server.moreTools || 0)} tools`
        : server.status === 'failed' ? `failed: ${server.error}` : server.status;
      return `  ${server.name} (${server.source}, ${server.transport}): ${state}`;
    });
    for (const problem of mcpInfo.errors) lines.push(`  ${problem.path}: ${problem.message}`);
    if (!lines.length) return [`MCP servers: ${mcpInfo.asked ? 'none set up in Claude Code, Codex or ~/.dsx/mcp.json' : 'not asked yet'}`];
    return [`MCP servers${mcpInfo.done ? '' : ' (still starting)'}:`, ...lines];
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
      name: 'terminal',
      group: 'Commands',
      icon: 'terminal',
      description: 'Open or close the side terminal',
      run: () => {
        terminal.toggle();
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
          ...describeInstructions(),
          ...describeMcp(),
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
