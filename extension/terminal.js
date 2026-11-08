// The side terminal: a panel docked on the right of the DeepSeek page, where the user types commands and
// reads what they print. It runs them through the same native host as the model's commands, one process
// for each, so variables do not carry over; the working folder does, because a lone `cd` is followed
// here (see lib/terminal-core.js).
//
// Only the user's own keys and clicks do anything: the panel sits in a closed shadow root and every
// handler ignores untrusted events, so a script on the page cannot type into it. What it runs is never
// shown to the model, and nothing the model writes can reach it.
(function (root) {
  'use strict';

  const { parseCd, expandTarget, cdCommand, folderFrom, formatPrompt, pushHistory, stepHistory } = root.DsxTerminalCore;

  const DEFAULT_WIDTH = 440;
  const MIN_WIDTH = 320;
  const MAX_WIDTH_RATIO = 0.8;
  const EXPANDED_RATIO = 0.65;
  const EXPANDED_MAX = 1100;
  const MAX_OUTPUT_CHARS = 400000;
  const COMMAND_TIMEOUT_MS = 600000;
  const CD_TIMEOUT_MS = 15000;
  const INPUT_MAX_HEIGHT = 140;
  const HISTORY_KEY = 'dsx-terminal-history';

  const ICONS = {
    terminal: '<path d="M5 7l5 5l-5 5"/><path d="M12 17h7"/>',
    expand: '<path d="M4 9V4h5"/><path d="M20 9V4h-5"/><path d="M4 15v5h5"/><path d="M20 15v5h-5"/>',
    collapse: '<path d="M9 4v5H4"/><path d="M15 4v5h5"/><path d="M9 20v-5H4"/><path d="M15 20v-5h5"/>',
    close: '<path d="M6 6l12 12"/><path d="M18 6L6 18"/>',
    stop: '<rect x="7" y="7" width="10" height="10" rx="1.5"/>',
    clear: '<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/>',
  };

  const STYLES = `
    :host {
      position: fixed; top: 0; right: 0; bottom: 0; z-index: 2147482000; display: block;
      --mono: var(--ds-font-family-code, ui-monospace, "Cascadia Code", Consolas, Menlo, monospace);
    }
    * { box-sizing: border-box; }
    .panel {
      position: relative; display: flex; flex-direction: column; height: 100%; width: 100%;
      color: var(--dsw-alias-label-primary, #f9fafb);
      background: var(--dsw-specific-sidebar-fill, var(--dsw-alias-bg-layer-1, #1b1c1e));
      border-left: 1px solid var(--dsw-alias-border-l1, rgba(255, 255, 255, .06));
      font: 14px/24px Inter, system-ui, -apple-system, "Segoe UI", sans-serif;
    }
    .grip { position: absolute; left: -3px; top: 0; bottom: 0; width: 7px; cursor: col-resize; z-index: 2; }
    .grip:hover, .grip.dragging { background: color-mix(in srgb, var(--dsw-alias-brand-primary, #5686fe) 45%, transparent); }
    header { flex: none; display: flex; align-items: center; gap: 2px; height: 52px; padding: 0 10px 0 18px; }
    .title { font-weight: 600; }
    .shell { margin-left: 10px; color: var(--dsw-alias-label-tertiary, #adb2b8); font-size: 12px; }
    .spacer { flex: 1; }
    .running { display: none; align-items: center; gap: 6px; margin-right: 6px; color: var(--dsw-alias-label-tertiary, #adb2b8); font-size: 12px; }
    .running i { width: 7px; height: 7px; border-radius: 50%; background: var(--dsw-alias-brand-text, #679efe); animation: pulse 1s ease-in-out infinite; }
    .panel.busy .running { display: inline-flex; }
    button {
      display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; padding: 0; border: 0; border-radius: 8px;
      background: none; color: var(--dsw-alias-label-secondary, #cfd3d6); cursor: pointer; outline: none;
      transition: background-color .2s var(--ds-ease-in-out, cubic-bezier(.4, 0, .2, 1));
    }
    button:hover { background-color: var(--dsw-specific-sidebar-nav-item-hover, var(--dsw-alias-interactive-bg-hover, rgba(255, 255, 255, .08))); color: var(--dsw-alias-label-primary, #f9fafb); }
    button:focus-visible { box-shadow: 0 0 0 2px var(--dsw-alias-brand-primary, #5686fe); }
    button[hidden] { display: none; }
    button.stop { color: var(--dsw-alias-state-error-primary, #f25a5a); }
    svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
    .out { flex: 1; min-height: 0; overflow-y: auto; padding: 4px 18px 18px; overscroll-behavior: contain; scrollbar-width: thin; cursor: text; }
    pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font: 13px/20px var(--mono); user-select: text; }
    .echo { color: var(--dsw-alias-label-primary, #f9fafb); }
    .echo .prompt { color: var(--dsw-alias-brand-text, #679efe); }
    .text { color: var(--dsw-alias-label-secondary, #cfd3d6); }
    .note { color: var(--dsw-alias-label-tertiary, #adb2b8); }
    .error { color: var(--dsw-alias-state-error-primary, #f25a5a); }
    .live { display: flex; flex-wrap: wrap; align-items: flex-start; }
    .panel.busy .prompt-label { display: none; }
    .prompt-label { flex: 0 1 auto; max-width: 100%; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--dsw-alias-brand-text, #679efe); font: 13px/20px var(--mono); }
    textarea {
      flex: 1 1 14ch; min-width: 14ch; resize: none; border: 0; outline: 0; padding: 0; margin: 0; background: none; overflow: hidden;
      color: var(--dsw-alias-label-primary, #f9fafb); font: 13px/20px var(--mono); caret-color: var(--dsw-alias-label-primary, #f9fafb); caret-shape: block;
    }
    @keyframes pulse { 50% { opacity: .3; } }
    @media (prefers-reduced-motion: reduce) { .running i { animation: none; } button { transition: none; } }
  `;

  function svg(name) {
    const holder = document.createElement('template');
    holder.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;
    return holder.content.firstElementChild;
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // `host()` gives what the shell host reported ({ platform, defaultShell, home }) or null; `workspace()`
  // the folder the user picked; `send(message)` posts to the native host and says whether it could.
  // `onState({ open, width })` is told when the panel opens, closes or is resized, to be remembered.
  function createTerminal({ host, workspace, send, onState }) {
    const container = document.createElement('dsx-terminal');
    const shadow = container.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = STYLES;

    const panel = element('div', 'panel');
    const grip = element('div', 'grip');
    const header = element('header');
    const shellLabel = element('span', 'shell');
    const running = element('span', 'running');
    running.append(element('i'), element('span', '', 'Running'));
    const stopButton = element('button', 'stop');
    const clearButton = element('button');
    const expandButton = element('button');
    const closeButton = element('button');
    const output = element('div', 'out');
    const live = element('div', 'live');
    const promptLabel = element('span', 'prompt-label');
    const input = element('textarea');
    for (const [node, action, label, icon] of [
      [stopButton, 'terminal-stop', 'Stop the command (Ctrl+C)', 'stop'],
      [clearButton, 'terminal-clear', 'Clear (Ctrl+L)', 'clear'],
      [expandButton, 'terminal-expand', 'Expand', 'expand'],
      [closeButton, 'terminal-close', 'Close the terminal', 'close'],
    ]) {
      node.type = 'button';
      node.dataset.action = action;
      node.setAttribute('aria-label', label);
      node.title = label;
      node.append(svg(icon));
    }
    stopButton.hidden = true;
    input.dataset.action = 'terminal-input';
    input.rows = 1;
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.setAttribute('autocapitalize', 'off');
    input.setAttribute('aria-label', 'Terminal command');
    header.append(element('span', 'title', 'Terminal'), shellLabel, element('span', 'spacer'), running, stopButton, clearButton, expandButton, closeButton);
    live.append(promptLabel, input);
    output.append(live);
    panel.append(grip, header, output);
    shadow.append(style, panel);

    let isOpen = false;
    let expanded = false;
    let width = DEFAULT_WIDTH;
    let cwd = '';
    let previousCwd = '';
    let current = null;
    let counter = 0;
    let history = [];
    let historyIndex = 0;
    let draft = '';
    let outputChars = 0;
    let greeted = false;

    try {
      const saved = JSON.parse(sessionStorage.getItem(HISTORY_KEY) || '[]');
      if (Array.isArray(saved)) history = saved.filter((line) => typeof line === 'string').slice(-100);
    } catch {
      // Storage can be blocked; the history then lasts until the page reloads.
    }
    historyIndex = history.length;

    function saveHistory() {
      try {
        sessionStorage.setItem(HISTORY_KEY, JSON.stringify(history));
      } catch {
        // See above.
      }
    }

    const info = () => host() || null;
    const isWindows = () => Boolean(info() && info().platform === 'win32');
    const shellName = () => (info() && info().defaultShell) || 'shell';

    function promptText() {
      return formatPrompt(cwd || '…', shellName(), info() && info().home, isWindows());
    }

    function refreshPrompt() {
      promptLabel.textContent = promptText();
      promptLabel.title = cwd;
      shellLabel.textContent = info() ? shellName() : 'not connected';
    }

    // ---- Layout -------------------------------------------------------------------------------

    function pixelWidth() {
      const limit = Math.max(MIN_WIDTH, Math.floor(window.innerWidth * MAX_WIDTH_RATIO));
      if (expanded) return Math.min(Math.round(window.innerWidth * EXPANDED_RATIO), EXPANDED_MAX, limit);
      return Math.min(Math.max(width, MIN_WIDTH), limit);
    }

    // The page makes room by itself: page.css gives <body> a right margin of this width.
    function applyLayout() {
      if (!isOpen) return;
      const px = `${pixelWidth()}px`;
      container.style.width = px;
      document.documentElement.style.setProperty('--dsx-terminal-width', px);
    }

    function setExpanded(next) {
      expanded = next;
      expandButton.replaceChildren(svg(next ? 'collapse' : 'expand'));
      const label = next ? 'Shrink' : 'Expand';
      expandButton.setAttribute('aria-label', label);
      expandButton.title = label;
      expandButton.setAttribute('aria-pressed', String(next));
      applyLayout();
    }

    window.addEventListener('resize', applyLayout);

    // ---- Output -------------------------------------------------------------------------------

    function nearBottom() {
      return output.scrollHeight - output.scrollTop - output.clientHeight < 40;
    }

    function trimOutput() {
      while (outputChars > MAX_OUTPUT_CHARS && output.childElementCount > 1) {
        outputChars -= output.firstElementChild.textContent.length;
        output.firstElementChild.remove();
      }
    }

    // Adds a line of the given kind and returns its text node, which streamed output keeps growing.
    function addLine(kind, text) {
      const stick = nearBottom();
      const pre = element('pre', kind);
      const node = document.createTextNode(text);
      pre.append(node);
      output.insertBefore(pre, live);
      outputChars += text.length;
      trimOutput();
      if (stick) output.scrollTop = output.scrollHeight;
      return node;
    }

    function addEcho(command) {
      const stick = nearBottom();
      const pre = element('pre', 'echo');
      pre.append(element('span', 'prompt', `${promptText()} `), document.createTextNode(command));
      output.insertBefore(pre, live);
      outputChars += command.length + 8;
      if (stick) output.scrollTop = output.scrollHeight;
    }

    function appendTo(node, text) {
      const stick = nearBottom();
      node.appendData(text);
      outputChars += text.length;
      if (stick) output.scrollTop = output.scrollHeight;
    }

    function clearScreen() {
      output.replaceChildren(live);
      outputChars = 0;
    }

    function greet() {
      if (greeted) return;
      greeted = true;
      addLine('note', `${shellName()} · each command runs on its own, so only cd carries over to the next one.`);
    }

    // ---- Running commands ---------------------------------------------------------------------

    function setBusy(busy) {
      panel.classList.toggle('busy', busy);
      stopButton.hidden = !busy;
    }

    function ensureFolder() {
      if (cwd) return true;
      cwd = workspace() || (info() && info().home) || '';
      refreshPrompt();
      return Boolean(cwd);
    }

    function start(kind, command, timeoutMs) {
      counter += 1;
      const id = `term-${counter}-${Date.now()}`;
      current = { id, kind, node: null, text: '', started: false, stopRequested: false };
      setBusy(kind === 'command');
      if (kind === 'command') input.focus();
      const sent = send({ type: 'exec', id, tool: 'shell', command, body: command, cwd, timeoutMs });
      if (!sent) {
        current = null;
        setBusy(false);
        addLine('error', 'The shell host is not connected.');
      }
      return sent;
    }

    function changeDirectory(target) {
      const where = target === '-' ? previousCwd : expandTarget(target, info().home);
      if (!where) {
        addLine('error', 'There is no previous folder.');
        return;
      }
      start('cd', cdCommand(shellName(), where), CD_TIMEOUT_MS);
    }

    function submit(raw) {
      const command = raw.replace(/\s+$/, '');
      if (current) return;
      if (!command.trim()) {
        addEcho('');
        return;
      }
      history = pushHistory(history, command);
      historyIndex = history.length;
      saveHistory();
      greet();
      if (!info()) {
        addEcho(command);
        addLine('error', 'The shell host is not connected. Run node host/install.js (or the setup), then restart the browser.');
        return;
      }
      ensureFolder();
      addEcho(command);

      const word = command.trim().toLowerCase();
      if (word === 'clear' || word === 'cls' || word === 'clear-host') {
        clearScreen();
        return;
      }
      if (word === 'exit') {
        api.close();
        return;
      }
      const cd = parseCd(command);
      if (cd) {
        changeDirectory(cd.target);
        return;
      }
      start('command', command, COMMAND_TIMEOUT_MS);
    }

    function finish(message) {
      const done = current;
      current = null;
      setBusy(false);
      if (done.kind === 'cd') {
        const folder = message.status === 'ok' ? folderFrom(done.text) : '';
        if (folder) {
          previousCwd = cwd;
          cwd = folder;
          refreshPrompt();
        } else {
          addLine('error', (done.text.trim() || message.error || 'The folder could not be reached.').trim());
        }
      } else {
        if (done.node && !/\n$/.test(done.text)) appendTo(done.node, '\n');
        if (message.status === 'stopped') addLine('note', '[stopped]');
        else if (message.status === 'timeout') addLine('error', '[timed out after 10 minutes]');
        else if (message.status === 'spawn_error') addLine('error', message.error || 'The command could not start.');
        else if (message.status === 'failed' && message.code !== null && message.code !== undefined) addLine('note', `[exit ${message.code}]`);
        if (message.truncated) addLine('note', '[the output was cut]');
      }
      if (isOpen) input.focus();
    }

    // The host's answers to a command started here. Returns true when the message was ours.
    function handleMessage(message) {
      if (!current || message.id !== current.id) return false;
      if (message.type === 'started') {
        current.started = true;
        if (current.stopRequested) send({ type: 'kill', id: current.id });
      } else if (message.type === 'output') {
        const text = String(message.data || '');
        current.text += text;
        if (current.kind === 'command') {
          if (!current.node) current.node = addLine('text', text);
          else appendTo(current.node, text);
        }
      } else if (message.type === 'exit') {
        finish(message);
      }
      return true;
    }

    // The host only knows a command once it has started it, so a stop asked for before that waits for it.
    function stop() {
      if (!current || current.kind !== 'command') return;
      if (current.started) send({ type: 'kill', id: current.id });
      else current.stopRequested = true;
    }

    // The host went away: a command that was running will not report back.
    function connectionLost() {
      if (!current) return;
      finish({ status: 'spawn_error', error: 'The connection to the shell host was lost.' });
    }

    // ---- The input line -----------------------------------------------------------------------

    function resizeInput() {
      input.style.height = 'auto';
      input.style.height = `${Math.min(input.scrollHeight, INPUT_MAX_HEIGHT)}px`;
    }

    function recall(direction) {
      if (historyIndex === history.length) draft = input.value;
      const step = stepHistory(history, historyIndex, direction);
      historyIndex = step.index;
      input.value = step.text === null ? draft : step.text;
      resizeInput();
      input.setSelectionRange(input.value.length, input.value.length);
    }

    input.addEventListener('input', resizeInput);
    input.addEventListener('keydown', (event) => {
      if (!event.isTrusted) return;
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        const text = input.value;
        if (current) return;
        input.value = '';
        draft = '';
        resizeInput();
        submit(text);
      } else if (event.ctrlKey && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'c' && input.selectionStart === input.selectionEnd) {
        // With no text selected, Ctrl+C stops the command, like in any terminal.
        event.preventDefault();
        if (current) stop();
        else if (input.value) {
          addEcho(`${input.value}^C`);
          input.value = '';
          resizeInput();
        }
      } else if (event.ctrlKey && event.key.toLowerCase() === 'l') {
        event.preventDefault();
        clearScreen();
      } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        // In a line of one row the arrows walk the history. In a longer text they move inside it, and
        // only walk the history from its very first or last position.
        if (!history.length) return;
        const multiline = input.value.includes('\n');
        const atStart = input.selectionStart === 0 && input.selectionEnd === 0;
        const atEnd = input.selectionStart === input.value.length && input.selectionEnd === input.value.length;
        const up = event.key === 'ArrowUp';
        if (!multiline || (up && atStart) || (!up && atEnd && historyIndex < history.length)) {
          event.preventDefault();
          recall(up ? -1 : 1);
        }
      }
    });

    // Ctrl+C stops a running command wherever the focus is inside the panel, as in a terminal.
    panel.addEventListener('keydown', (event) => {
      if (!event.isTrusted || event.defaultPrevented || !current) return;
      if (event.ctrlKey && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'c') {
        event.preventDefault();
        stop();
      }
    });

    // The page has its own shortcuts, so keys typed here stay here.
    for (const type of ['keydown', 'keyup', 'keypress']) container.addEventListener(type, (event) => event.stopPropagation());

    const trusted = (handler) => (event) => {
      if (event.isTrusted) handler(event);
    };
    stopButton.addEventListener('click', trusted(stop));
    clearButton.addEventListener('click', trusted(() => {
      clearScreen();
      input.focus();
    }));
    expandButton.addEventListener('click', trusted(() => {
      setExpanded(!expanded);
      input.focus();
    }));
    closeButton.addEventListener('click', trusted(() => api.close()));
    // A click on the output focuses the input, unless the user is selecting text to copy.
    output.addEventListener('mouseup', trusted(() => {
      const selection = shadow.getSelection ? shadow.getSelection() : window.getSelection();
      if (!String(selection || '')) input.focus();
    }));

    // Dragging the left edge sets the width.
    grip.addEventListener('mousedown', trusted((event) => {
      event.preventDefault();
      grip.classList.add('dragging');
      const move = (moveEvent) => {
        expanded = false;
        expandButton.replaceChildren(svg('expand'));
        width = Math.round(window.innerWidth - moveEvent.clientX);
        applyLayout();
      };
      const up = () => {
        grip.classList.remove('dragging');
        window.removeEventListener('mousemove', move, true);
        window.removeEventListener('mouseup', up, true);
        width = pixelWidth();
        onState({ open: true, width });
      };
      window.addEventListener('mousemove', move, true);
      window.addEventListener('mouseup', up, true);
    }));

    // ---- Opening and closing ------------------------------------------------------------------

    const api = {
      isOpen: () => isOpen,
      open(savedWidth) {
        if (savedWidth) width = savedWidth;
        if (!isOpen) {
          isOpen = true;
          (document.body || document.documentElement).append(container);
          document.documentElement.setAttribute('data-dsx-terminal', '');
          ensureFolder();
          greet();
        }
        refreshPrompt();
        applyLayout();
        onState({ open: true, width });
        input.focus();
      },
      close() {
        if (!isOpen) return;
        isOpen = false;
        container.remove();
        document.documentElement.removeAttribute('data-dsx-terminal');
        document.documentElement.style.removeProperty('--dsx-terminal-width');
        onState({ open: false, width });
      },
      toggle() {
        if (isOpen) api.close();
        else api.open();
      },
      // The folder the user picked changed: the terminal follows it, unless a command is running.
      setWorkspace(folder) {
        if (current) return;
        const next = folder || (info() && info().home) || '';
        if (!next || next === cwd) return;
        previousCwd = cwd;
        cwd = next;
        refreshPrompt();
        if (isOpen) addLine('note', `Workspace: ${next}`);
      },
      // The host connected or went away: the label and the prompt follow.
      hostChanged() {
        if (!info()) connectionLost();
        if (!cwd && info()) ensureFolder();
        refreshPrompt();
      },
      handleMessage,
      connectionLost,
    };

    refreshPrompt();
    return api;
  }

  root.DsxTerminal = { createTerminal, DEFAULT_WIDTH, ICONS };
})(globalThis);
