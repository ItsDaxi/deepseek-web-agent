// Renders tool calls as cards that follow DeepSeek's theme tokens.
// The shadow root is closed so page scripts cannot rewrite the command shown for approval, and
// actions only fire on real user clicks.
(function (root) {
  'use strict';

  const ICONS = {
    terminal: '<path d="M8 9l3 3l-3 3"/><path d="M13 15h3"/><path d="M3 6a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2z"/>',
    alert: '<path d="M12 9v4"/><path d="M10.363 3.591l-8.106 13.534a1.914 1.914 0 0 0 1.636 2.871h16.214a1.914 1.914 0 0 0 1.636 -2.87l-8.106 -13.536a1.914 1.914 0 0 0 -3.274 0z"/><path d="M12 16h.01"/>',
    check: '<path d="M5 12l5 5l10 -10"/>',
    x: '<path d="M18 6l-12 12"/><path d="M6 6l12 12"/>',
    clock: '<path d="M20.926 13.15a9 9 0 1 0 -7.835 7.784"/><path d="M12 7v5l2 2"/><path d="M22 22l-5 -5"/><path d="M17 22l5 -5"/>',
    stop: '<path d="M5 7a2 2 0 0 1 2 -2h10a2 2 0 0 1 2 2v10a2 2 0 0 1 -2 2h-10a2 2 0 0 1 -2 -2z"/>',
    ban: '<path d="M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0"/><path d="M5.7 5.7l12.6 12.6"/>',
    plug: '<path d="M16.123 16.123l-.123 .123a6 6 0 0 1 -8.485 0a6 6 0 0 1 0 -8.485l.123 -.123"/><path d="M3 21l2.5 -2.5"/><path d="M18.5 5.5l2.5 -2.5"/><path d="M10 11l-2 2"/><path d="M13 14l-2 2"/><path d="M3 3l18 18"/>',
    chevronRight: '<path d="M9 6l6 6l-6 6"/>',
    chevronDown: '<path d="M6 9l6 6l6 -6"/>',
    copy: '<path d="M7 9.667a2.667 2.667 0 0 1 2.667 -2.667h8.666a2.667 2.667 0 0 1 2.667 2.667v8.666a2.667 2.667 0 0 1 -2.667 2.667h-8.666a2.667 2.667 0 0 1 -2.667 -2.667z"/><path d="M4.012 16.737a2 2 0 0 1 -1.012 -1.737v-10c0 -1.1 .9 -2 2 -2h10c.75 0 1.158 .385 1.5 1"/>',
    spinner: '<path d="M12 3a9 9 0 1 0 9 9"/>',
    file: '<path d="M14 3v4a1 1 0 0 0 1 1h4"/><path d="M17 21h-10a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2z"/>',
    pencil: '<path d="M4 20h4l10.5 -10.5a2.828 2.828 0 1 0 -4 -4l-10.5 10.5v4"/><path d="M13.5 6.5l4 4"/>',
    search: '<path d="M3 10a7 7 0 1 0 14 0a7 7 0 1 0 -14 0"/><path d="M21 21l-6 -6"/>',
  };

  const TOOL_INFO = {
    shell: { question: 'Run this command?', icon: 'terminal', action: 'Run' },
    read: { question: 'Read this file?', icon: 'file', action: 'Allow', verb: 'Read' },
    write: { question: 'Write this file?', icon: 'pencil', action: 'Allow', verb: 'Write' },
    edit: { question: 'Edit this file?', icon: 'pencil', action: 'Allow', verb: 'Edit' },
    glob: { question: 'Search these file names?', icon: 'search', action: 'Allow', verb: 'Find' },
    grep: { question: 'Search inside these files?', icon: 'search', action: 'Allow', verb: 'Search' },
    poll: { question: 'Read this background job?', icon: 'clock', action: 'Allow', verb: 'Poll' },
    kill: { question: 'Stop this background job?', icon: 'stop', action: 'Stop', verb: 'Stop' },
    mcp: { question: 'Call this MCP tool?', icon: 'plug', action: 'Allow' },
    // A helper starts by itself, so its question only shows for a call replayed from an old chat.
    agent: { question: 'Start a helper for this task?', icon: 'search', action: 'Start' },
  };

  const STYLES = `
    :host { display: block; margin: 10px 0; font: var(--dsw-font-markdown-small, 14px/22px system-ui, sans-serif); color: var(--dsw-alias-label-primary, #f9fafb); }
    * { box-sizing: border-box; }
    .card { border: 1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.12)); border-radius: 12px; overflow: hidden; background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.04)); }
    .card.danger { border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary, #f25a5a) 55%, transparent); }
    .head { display: flex; align-items: center; gap: 8px; min-height: 38px; padding: 8px 12px; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-secondary, #cfd3d6); }
    .head.toggle { cursor: pointer; }
    .head.toggle:hover { color: var(--dsw-alias-label-primary, #f9fafb); }
    .title { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
    .title.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12.5px; }
    .title.struck { text-decoration: line-through; color: var(--dsw-alias-label-tertiary, #adb2b8); }
    .meta { display: flex; flex: none; align-items: center; gap: 8px; font-size: 12px; color: var(--dsw-alias-label-caption, #81858c); }
    svg { width: 16px; height: 16px; flex: none; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
    pre { margin: 0; padding: 10px 12px; font: 12.5px/20px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: pre-wrap; overflow-wrap: anywhere; border-top: 1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.06)); }
    pre.output { color: var(--dsw-alias-label-tertiary, #adb2b8); max-height: 320px; overflow-y: auto; overscroll-behavior: contain; }
    pre.diff, pre.content { max-height: 320px; overflow-y: auto; overscroll-behavior: contain; }
    .del, .add { display: block; }
    .del { color: var(--dsw-alias-state-error-primary, #f25a5a); }
    .add { color: var(--dsw-alias-state-success-primary, #22c55e); }
    .note { padding: 6px 12px; font-size: 12px; color: var(--dsw-alias-label-caption, #81858c); border-top: 1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.06)); }
    .actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 8px 12px; border-top: 1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.06)); }
    button { font: inherit; font-size: 13px; line-height: 20px; padding: 4px 12px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l3, rgba(255,255,255,.16)); background: none; color: var(--dsw-alias-label-secondary, #cfd3d6); cursor: pointer; }
    button:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.08)); }
    button:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #5686fe); outline-offset: 1px; }
    button.primary { background: var(--dsw-alias-brand-primary, #5686fe); border-color: transparent; color: #fff; }
    button.primary:hover { filter: brightness(1.08); }
    button.destructive { background: var(--dsw-alias-state-error-primary, #f25a5a); border-color: transparent; color: #fff; }
    button.destructive:hover { filter: brightness(1.08); }
    button.quiet { margin-left: auto; border-color: transparent; font-size: 12px; color: var(--dsw-alias-label-caption, #81858c); padding: 4px 6px; }
    button.small { padding: 2px 10px; font-size: 12px; }
    button.icon { display: inline-flex; padding: 2px; border: 0; color: inherit; }
    .ok { color: var(--dsw-alias-state-success-primary, #22c55e); }
    .err { color: var(--dsw-alias-state-error-primary, #f25a5a); }
    .warn { color: #e5a13a; }
    .brand { color: var(--dsw-alias-brand-text, #679efe); }
    .muted { color: var(--dsw-alias-label-caption, #81858c); }
    .spin { animation: spin 1s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { .spin { animation: none; } }
  `;

  // Best-effort labels for the approval card. They never replace reading the command.
  const DANGER_RULES = [
    [/\b(rm\s+(-\w*[rf]\w*\s+)+|rmdir\s+\/s|del\s+\/[sfq]|rd\s+\/s|remove-item\b.*-(recurse|force))/i, 'Deletes files'],
    [/\b(format(\.com)?\s+[a-z]:|diskpart|mkfs|dd\s+if=)/i, 'Can erase a disk'],
    [/(curl|wget|invoke-webrequest|iwr|irm)\b.*\|\s*(sudo\s+)?(sh|bash|zsh|iex|invoke-expression|python)/i, 'Runs code downloaded from the internet'],
    [/\b(shutdown|restart-computer|stop-computer|reboot)\b/i, 'Shuts down or restarts the computer'],
    [/\b(reg\s+(add|delete)|set-itemproperty\s+.*hk(lm|cu)|set-executionpolicy|sudo\s)/i, 'Changes system settings'],
    [/\bgit\s+(push\s+.*--force|reset\s+--hard|clean\s+-\w*f)/i, 'Can discard git work'],
  ];

  function dangerLabel(command) {
    const rule = DANGER_RULES.find(([pattern]) => pattern.test(command));
    return rule ? rule[1] : null;
  }

  function icon(name, className) {
    const wrapper = document.createElement('span');
    wrapper.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"${className ? ` class="${className}"` : ''}>${ICONS[name]}</svg>`;
    return wrapper.firstChild;
  }

  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (key === 'className') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key === 'dataset') Object.assign(node.dataset, value);
      else node.setAttribute(key, value);
    }
    for (const child of children) if (child) node.append(child);
    return node;
  }

  function formatDuration(ms) {
    if (ms < 1000) return `${Math.round(ms)} ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
    const minutes = Math.floor(ms / 60000);
    return `${minutes} min ${Math.round((ms % 60000) / 1000)} s`;
  }

  function firstLine(command) {
    return (command || '').split('\n')[0];
  }

  function toolInfo(tool) {
    return TOOL_INFO[tool.kind] || TOOL_INFO.shell;
  }

  // The one-line summary of a tool call.
  function toolTitle(tool) {
    if (tool.kind === 'agent') return `Helper: ${tool.attributes?.description || firstLine(tool.command) || 'working'}`;
    if (tool.kind === 'mcp') return `MCP ${tool.attributes?.server || '?'}: ${tool.attributes?.tool || '?'}`;
    const { verb } = toolInfo(tool);
    if (!verb) return firstLine(tool.command);
    const subject = tool.kind === 'glob' || tool.kind === 'grep' ? firstLine(tool.command) : tool.path;
    return subject ? `${verb} ${subject}` : verb;
  }

  function diffLines(prefix, className, text) {
    return text.split('\n').map((line) => el('span', { className, text: `${prefix} ${line}` }));
  }

  // The full request, as shown for approval and in an expanded card.
  function toolDetail(tool) {
    const location = tool.path ? `in ${tool.path}` : '';
    if (tool.kind === 'poll' || tool.kind === 'kill') {
      const job = tool.attributes?.id || tool.job || '';
      const wait = tool.kind === 'poll' && tool.attributes?.wait ? `, waiting up to ${tool.attributes.wait}s for new output` : '';
      return el('pre', { text: `${tool.kind === 'poll' ? 'Read' : 'Stop'} background job ${job || '(unknown)'}${wait}` });
    }
    if (tool.kind === 'shell' && tool.attributes?.background === 'true') {
      return el('pre', { text: `${tool.command}\n\n[background]` });
    }
    switch (tool.kind) {
      case 'mcp': {
        // The arguments, laid out so they can be read before the call is approved.
        let shown = tool.command || '';
        try {
          if (shown.trim()) shown = JSON.stringify(JSON.parse(shown), null, 2);
        } catch {
          // Not valid JSON: the host will say so, and the text is shown as it is.
        }
        return el('pre', { text: `${tool.attributes?.server || '?'} › ${tool.attributes?.tool || '?'}\n${shown || '(no arguments)'}` });
      }
      case 'write':
        return el('pre', { className: 'content', text: tool.command });
      case 'edit': {
        const match = /<dsx:old>([\s\S]*?)<\/dsx:old>\s*<dsx:new>([\s\S]*?)<\/dsx:new>/.exec(tool.command);
        if (!match) return el('pre', { text: tool.command });
        return el('pre', { className: 'diff' }, ...diffLines('-', 'del', match[1]), ...diffLines('+', 'add', match[2]));
      }
      case 'read':
        return el('pre', { text: tool.path });
      case 'glob':
      case 'grep':
        return el('pre', { text: [tool.command, location].filter(Boolean).join('\n') });
      default:
        return el('pre', { text: tool.command });
    }
  }

  // Builds the parts of a finished card that depend on how the command ended.
  const OUTCOMES = {
    ok: (t) => ({
      iconName: 'check',
      iconClass: 'ok',
      meta: t.kind === 'shell' && t.attributes?.background === 'true'
        ? [el('span', { text: t.job ? `background ${t.job}` : 'running in background' })]
        : t.kind === 'poll'
          ? [el('span', { text: t.jobRunning ? 'job still running' : 'job finished' })]
          : t.kind === 'shell'
            ? [el('span', { text: 'exit 0' })]
            : [],
    }),
    running: () => ({ iconName: 'spinner', iconClass: 'spin brand', meta: [el('span', { text: 'still running' })] }),
    failed: (t) => ({ iconName: 'x', iconClass: 'err', meta: [el('span', { className: 'err', text: t.kind === 'shell' ? `exit ${t.code}` : 'failed' })] }),
    timeout: () => ({ iconName: 'clock', iconClass: 'warn', meta: [el('span', { className: 'warn', text: 'timed out' })] }),
    stopped: () => ({ iconName: 'stop', iconClass: 'muted', meta: [el('span', { text: 'stopped' })] }),
    spawn_error: () => ({ iconName: 'x', iconClass: 'err', meta: [el('span', { className: 'err', text: "couldn't start" })] }),
    rejected: () => ({ iconName: 'ban', iconClass: 'muted', struck: true, meta: [el('span', { text: 'rejected' })] }),
    interrupted: () => ({ iconName: 'x', iconClass: 'muted', meta: [el('span', { text: 'interrupted' })] }),
    cancelled: () => ({ iconName: 'ban', iconClass: 'muted', meta: [el('span', { text: 'cancelled' })] }),
  };

  function createCardStore({ onAction }) {
    const tools = new Map();
    const hosts = new Map();
    let ticker = null;

    function act(action, id, event) {
      // Page scripts can only produce untrusted events.
      if (!event.isTrusted) return;
      onAction(action, id);
    }

    function button(label, action, id, className) {
      const node = el('button', { type: 'button', text: label, className: className || '', dataset: { action } });
      node.addEventListener('click', (event) => {
        event.stopPropagation();
        act(action, id, event);
      });
      return node;
    }

    function renderWriting(tool) {
      const isShell = tool.kind === 'shell';
      return el(
        'div',
        { className: 'card' },
        el('div', { className: 'head' }, icon('spinner', 'spin brand'), el('span', { className: 'title', text: isShell ? 'Writing command…' : tool.kind === 'mcp' ? 'Writing MCP call…' : `${toolInfo(tool).verb} ${tool.path}…`.replace(/ …$/, '…') })),
        (isShell || tool.kind === 'write') && tool.command ? el('pre', { className: 'content', text: tool.command, dataset: { follow: '1' } }) : null,
      );
    }

    function renderApproval(tool) {
      const info = toolInfo(tool);
      const danger = tool.kind === 'shell' ? dangerLabel(tool.command) : null;
      const location = tool.kind === 'shell' ? [tool.shell, tool.cwd].filter(Boolean).join(' · ') : tool.cwd;
      return el(
        'div',
        { className: danger ? 'card danger' : 'card' },
        el(
          'div',
          { className: 'head' },
          danger ? icon('alert', 'err') : icon(info.icon, 'brand'),
          el('span', { className: 'title', text: danger || info.question }),
          location ? el('span', { className: 'meta', text: location }) : null,
        ),
        toolDetail(tool),
        tool.pausedReason ? el('div', { className: 'note', text: tool.pausedReason }) : null,
        el(
          'div',
          { className: 'actions' },
          button(danger ? 'Run anyway' : info.action, 'run', tool.id, danger ? 'destructive' : 'primary'),
          button('Reject', 'reject', tool.id),
          danger ? null : button('Always allow in this chat', 'allow-chat', tool.id, 'quiet'),
        ),
      );
    }

    // Waiting its turn behind an earlier call in the same reply. No buttons: nothing is being
    // asked of the user here, it just has not started yet.
    function renderQueued(tool) {
      return el(
        'div',
        { className: 'card' },
        el(
          'div',
          { className: 'head' },
          icon('spinner', 'spin muted'),
          el('span', { className: 'title mono', text: toolTitle(tool) }),
          el('span', { className: 'meta', text: 'queued' }),
        ),
      );
    }

    function renderRunning(tool) {
      const elapsed = el('span', { text: formatDuration(Date.now() - tool.startedAt), dataset: { elapsed: '' } });
      const output = el('pre', { className: 'output', text: tool.output || '', dataset: { live: '' } });
      output.hidden = !tool.output;
      return el(
        'div',
        { className: 'card' },
        el(
          'div',
          { className: 'head' },
          icon('spinner', 'spin brand'),
          el('span', { className: 'title mono', text: toolTitle(tool) }),
          el('span', { className: 'meta' }, tool.autoRun ? el('span', { text: 'auto' }) : null, elapsed, button('Stop', 'stop', tool.id, 'small')),
        ),
        output,
      );
    }

    function renderNoHost(tool) {
      const needsReload = tool.hostProblem === 'reload';
      return el(
        'div',
        { className: 'card' },
        el(
          'div',
          { className: 'head' },
          needsReload ? icon('plug', 'warn') : icon('spinner', 'spin warn'),
          el('span', { className: 'title', text: needsReload ? 'Reload this page to run this command' : 'Connecting to the shell host…' }),
          el('span', { className: 'meta' }, needsReload ? null : button('Retry', 'retry', tool.id, 'small'), button('Reject', 'reject', tool.id, 'small')),
        ),
        toolDetail(tool),
        el('div', {
          className: 'note',
          text: needsReload
            ? 'The extension was updated, so this page lost its connection to it.'
            : 'It runs as soon as the host connects. If this stays here, run node host/install.js and restart your browser.',
        }),
      );
    }

    function renderFinished(tool) {
      const outcome = (OUTCOMES[tool.status] || OUTCOMES.interrupted)(tool);
      const copy = el('button', { type: 'button', className: 'icon', 'aria-label': 'Copy output', dataset: { action: 'copy' } }, icon('copy'));
      copy.addEventListener('click', (event) => {
        event.stopPropagation();
        if (event.isTrusted) navigator.clipboard.writeText(tool.output || tool.command).catch(() => {});
      });
      const head = el(
        'div',
        { className: 'head toggle', role: 'button', tabindex: '0', 'aria-expanded': String(Boolean(tool.expanded)), dataset: { action: 'toggle' } },
        icon(outcome.iconName, outcome.iconClass),
        el('span', { className: `title mono${outcome.struck ? ' struck' : ''}`, text: toolTitle(tool) }),
        el(
          'span',
          { className: 'meta' },
          ...outcome.meta,
          tool.autoRun ? el('span', { text: 'auto' }) : null,
          tool.durationMs ? el('span', { text: formatDuration(tool.durationMs) }) : null,
          tool.expanded ? copy : null,
          icon(tool.expanded ? 'chevronDown' : 'chevronRight'),
        ),
      );
      const toggle = () => {
        tool.expanded = !tool.expanded;
        refresh(tool.id);
      };
      head.addEventListener('click', toggle);
      head.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          toggle();
        }
      });
      const card = el('div', { className: 'card' }, head);
      if (tool.expanded) {
        if (tool.kind === 'write' || tool.kind === 'edit' || tool.kind === 'mcp') {
          card.append(toolDetail(tool));
        } else if (tool.kind === 'shell' && (tool.command.includes('\n') || tool.cwd)) {
          card.append(el('pre', { text: tool.cwd ? `# ${tool.cwd}\n${tool.command}` : tool.command }));
        } else if (tool.kind === 'agent' && tool.command) {
          card.append(el('pre', { text: `Task:\n${tool.command}` }));
        }
        const body = tool.error || tool.output;
        if (body) card.append(el('pre', { className: 'output', text: body }));
        else card.append(el('div', { className: 'note', text: tool.status === 'rejected' ? 'This command did not run.' : tool.kind === 'agent' ? 'The helper left no report.' : 'No output.' }));
        if (tool.truncated) card.append(el('div', { className: 'note', text: 'Long output: the model received a shortened version.' }));
      }
      if (tool.sendFailed) {
        card.append(
          el(
            'div',
            { className: 'actions' },
            el('span', { className: 'muted', text: "Couldn't send this result to the model." }),
            button('Send again', 'resend', tool.id, 'small'),
          ),
        );
      }
      return card;
    }

    function render(tool) {
      if (!tool) return el('div', { className: 'card' }, el('div', { className: 'head' }, icon('terminal', 'muted'), el('span', { className: 'title', text: 'Shell command' })));
      switch (tool.status) {
        case 'writing':
          return renderWriting(tool);
        case 'awaiting':
          return renderApproval(tool);
        case 'queued':
          return renderQueued(tool);
        case 'running':
          return renderRunning(tool);
        case 'no-host':
          return renderNoHost(tool);
        default:
          return renderFinished(tool);
      }
    }

    // Every scrollable box in a card, in the order they are drawn.
    const SCROLLERS = 'pre.output, pre.content, pre.diff';

    // The card is rebuilt whenever it changes, and a rebuilt box starts at its top. While a file is
    // being written that happened on every token, so the box could never be scrolled. Each box keeps
    // the place it was left at, and one that was at the end keeps following the end.
    function paint(id, shadow) {
      const before = [...shadow.querySelectorAll(SCROLLERS)].map((box) => ({
        atBottom: box.scrollHeight - box.scrollTop - box.clientHeight < 24,
        top: box.scrollTop,
      }));
      shadow.querySelector('.card')?.remove();
      shadow.append(render(tools.get(id)));
      shadow.querySelectorAll(SCROLLERS).forEach((box, index) => {
        const was = before[index];
        // A box seen for the first time shows its end while it is still being filled.
        const follow = was ? was.atBottom : box.hasAttribute('data-live') || box.dataset.follow === '1';
        box.scrollTop = follow ? box.scrollHeight : (was ? was.top : 0);
      });
    }

    // What a card visibly depends on. Rebuilding only when this changes keeps buttons in place: a
    // button replaced between mouse down and mouse up would silently lose the click.
    function renderKey(tool) {
      if (!tool) return '';
      const running = tool.status === 'running';
      return JSON.stringify([
        tool.status,
        tool.kind,
        tool.path,
        // While a call is being written its text grows by the token. That is added in place (see
        // syncWriting), because rebuilding the card under the mouse breaks scrolling it.
        tool.status === 'writing' ? Boolean(tool.command) : tool.command,
        tool.code,
        tool.durationMs,
        tool.expanded,
        tool.pausedReason,
        tool.sendFailed,
        tool.truncated,
        tool.autoRun,
        tool.error,
        tool.hostProblem,
        tool.job,
        tool.jobRunning,
        running ? null : [tool.output, tool.shell, tool.cwd],
        // A helper has no stream of output; what its card says while it works is a note, so a new one repaints.
        running && tool.kind === 'agent' ? tool.output : null,
      ]);
    }

    // Adds the newly written text to the box that is already on screen, leaving the scroll alone
    // unless the box was showing its end.
    function syncWriting(tool, shadow) {
      const box = shadow.querySelector('pre.content');
      const text = tool.command || '';
      if (!box || box.textContent === text) return;
      const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 24;
      const top = box.scrollTop;
      const shown = box.textContent;
      if (box.firstChild && text.startsWith(shown)) box.firstChild.appendData(text.slice(shown.length));
      else box.textContent = text;
      box.scrollTop = atBottom ? box.scrollHeight : top;
    }

    function refresh(id) {
      const tool = tools.get(id);
      const key = renderKey(tool);
      for (const entry of hosts.get(id) || []) {
        if (!entry.host.isConnected) continue;
        if (entry.key !== key) {
          paint(id, entry.shadow);
          entry.key = key;
        } else if (tool && tool.status === 'writing') {
          syncWriting(tool, entry.shadow);
        }
      }
      updateTicker();
    }

    function updateTicker() {
      const anyRunning = [...tools.values()].some((tool) => tool.status === 'running');
      if (anyRunning && !ticker) {
        ticker = setInterval(() => {
          for (const tool of tools.values()) {
            if (tool.status !== 'running') continue;
            for (const entry of hosts.get(tool.id) || []) {
              const label = entry.shadow.querySelector('[data-elapsed]');
              if (label) label.textContent = formatDuration(Date.now() - tool.startedAt);
            }
          }
        }, 200);
      } else if (!anyRunning && ticker) {
        clearInterval(ticker);
        ticker = null;
      }
    }

    // Virtual scrolling destroys message DOM, so a card can be mounted many times for one tool.
    function mount(block, id) {
      const host = document.createElement('dsx-card');
      const shadow = host.attachShadow({ mode: 'closed' });
      const style = document.createElement('style');
      style.textContent = STYLES;
      shadow.append(style);
      paint(id, shadow);
      block.append(host);
      const entries = (hosts.get(id) || []).filter((entry) => entry.host.isConnected);
      entries.push({ host, shadow, key: renderKey(tools.get(id)) });
      hosts.set(id, entries);
    }

    return {
      get: (id) => tools.get(id),
      list: () => [...tools.values()],
      set(id, fields) {
        const tool = { id, ...(tools.get(id) || {}), ...fields };
        tools.set(id, tool);
        refresh(id);
        return tool;
      },
      appendOutput(id, data) {
        const tool = tools.get(id);
        if (!tool) return;
        tool.output = (tool.output || '') + data;
        for (const entry of hosts.get(id) || []) {
          const live = entry.shadow.querySelector('[data-live]');
          if (!live) continue;
          const atBottom = live.scrollHeight - live.scrollTop - live.clientHeight < 24;
          live.hidden = false;
          live.append(data);
          if (atBottom) live.scrollTop = live.scrollHeight;
        }
      },
      mount,
      refreshAll() {
        for (const id of tools.keys()) refresh(id);
      },
    };
  }

  root.DsxCards = { createCardStore, dangerLabel };
})(globalThis);
