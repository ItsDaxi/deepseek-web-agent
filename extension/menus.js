// The pop-up menus of the composer: the workspace list, the permission presets and the model panel.
// They are drawn in DeepSeek's own dropdown style (the same tokens as slash-commands.js), inside a
// closed shadow root, and only react to real clicks and key presses, so a page script cannot change
// the permission mode by faking one.
(function (root) {
  'use strict';

  const MODEL_NAME = 'DeepSeek-V4.1-Flash';
  // The presets, from the safest to the most open. The ids are what is stored in settings.mode:
  // 'ask' is the original manual mode, and 'bypass' the original bypass mode.
  const MODES = [
    { id: 'ask', label: 'Read Only' },
    { id: 'workspace', label: 'Workspace Write' },
    { id: 'bypass', label: 'Full access' },
  ];
  const DEFAULT_WORKSPACE = 'Default workspace';
  const GAP_PX = 8;
  const MARGIN_PX = 8;

  const STYLES = `
    :host { position: fixed; left: 0; top: 0; width: 0; height: 0; z-index: 2147483000; }
    * { box-sizing: border-box; }
    .panel {
      position: fixed; min-width: 180px; padding: 4px; border-radius: 12px; outline: none;
      font-size: var(--ds-font-size-m, 14px); line-height: 24px;
      color: var(--dsw-alias-label-primary, #f9fafb);
      background-color: var(--dsw-specific-menu, var(--dsw-alias-bg-layer-3, #2b2c2f));
      border: 1px solid var(--dsw-alias-border-l1, rgba(255, 255, 255, .06));
      box-shadow: 0 0 1px rgba(0, 0, 0, .2), 0 0 4px rgba(0, 0, 0, .02), 0 12px 32px rgba(0, 0, 0, .08);
    }
    .panel[hidden] { display: none; }
    .panel.model { width: 270px; }
    .list { max-height: 304px; overflow-y: auto; scrollbar-width: thin; }
    .item {
      display: flex; align-items: center; gap: 10px; min-height: 24px; padding: 8px 10px; border-radius: 8px;
      cursor: pointer; user-select: none; overflow: hidden; white-space: nowrap;
      transition: background-color var(--ds-transition-duration, .2s) var(--ds-ease-in-out, cubic-bezier(.4, 0, .2, 1));
    }
    .item:hover, .item[aria-selected="true"] { background-color: var(--dsw-alias-interactive-bg-hover, rgba(255, 255, 255, .08)); }
    .item .label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
    .item .value { display: inline-flex; align-items: center; gap: 4px; color: var(--dsw-alias-label-tertiary, #adb2b8); }
    .bar { height: 3px; margin: -4px 10px 8px; border-radius: 2px; background: var(--dsw-alias-border-l2, rgba(255, 255, 255, .12)); overflow: hidden; }
    .bar i { display: block; height: 100%; border-radius: 2px; background: var(--dsw-alias-brand-text, #679efe); transition: width .3s ease; }
    .bar.warn i { background: #e5a13a; }
    .bar.full i { background: var(--dsw-alias-state-error-primary, #f25a5a); }
    .item.static { cursor: default; }
    .item.static:hover { background: none; }
    .sep { height: 1px; margin: 4px 6px; background: var(--dsw-alias-border-l2, rgba(255, 255, 255, .12)); }
    .search {
      display: block; width: 100%; padding: 8px 10px; border: 0; outline: 0; background: none; color: inherit;
      font: inherit; font-size: var(--ds-font-size-m, 14px); line-height: 24px;
    }
    .search::placeholder { color: var(--dsw-alias-label-caption, #81858c); }
    .empty { padding: 8px 10px; color: var(--dsw-alias-label-tertiary, #adb2b8); }
    svg { width: 16px; height: 16px; flex: none; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
    .panel.agents { width: 360px; }
    .item.agent { gap: 10px; }
    .item.agent .stack { display: flex; flex: 1; flex-direction: column; min-width: 0; }
    .item.agent .stack .label { flex: none; line-height: 22px; }
    .item.agent .meta { overflow: hidden; text-overflow: ellipsis; font-size: 12px; line-height: 18px; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-tertiary, #adb2b8); }
    .item.agent .state { width: 16px; height: 16px; }
    .item.agent .state.running { color: var(--dsw-alias-brand-text, #679efe); animation: spin 1s linear infinite; }
    .item.agent .state.ok { color: var(--dsw-alias-state-success-primary, #22c55e); }
    .item.agent .state.failed, .item.agent .state.timeout { color: var(--dsw-alias-state-error-primary, #f25a5a); }
    .item.agent .state.queued, .item.agent .state.stopped { color: var(--dsw-alias-label-caption, #81858c); }
    .item.agent.static { cursor: default; }
    .item.agent.static:hover { background: none; }
    .item.agent .dismiss {
      display: inline-flex; flex: none; align-items: center; justify-content: center; width: 24px; height: 24px; margin: -4px -4px -4px 0;
      border-radius: 6px; cursor: pointer; opacity: .55; color: var(--dsw-alias-label-tertiary, #adb2b8);
      transition: background-color var(--ds-transition-duration, .2s) var(--ds-ease-in-out, cubic-bezier(.4, 0, .2, 1)), opacity .2s ease;
    }
    .item.agent .dismiss svg { width: 14px; height: 14px; }
    .item.agent:hover .dismiss, .item.agent[aria-selected="true"] .dismiss { opacity: 1; }
    .item.agent .dismiss:hover { background-color: var(--dsw-alias-interactive-bg-hover, rgba(255, 255, 255, .08)); color: var(--dsw-alias-label-primary, #f9fafb); }
    .item.agent .chev + .dismiss { margin-left: 0; }
    .caption { padding: 6px 10px 4px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-caption, #81858c); }
    @keyframes spin { to { transform: rotate(360deg); } }
    .tick, .chev { margin-left: auto; }
    .value .chev { margin-left: 0; width: 14px; height: 14px; }
    .tick { width: 15px; height: 15px; }
    @media (prefers-reduced-motion: reduce) { .item { transition: none; } .item.agent .state.running { animation: none; } }
  `;

  function basename(path) {
    const parts = String(path).split(/[\\/]+/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : String(path);
  }

  function samePath(a, b) {
    return String(a).replace(/[\\/]+$/, '').toLowerCase() === String(b).replace(/[\\/]+$/, '').toLowerCase();
  }

  function modeLabel(id) {
    const mode = MODES.find((entry) => entry.id === id);
    return mode ? mode.label : MODES[0].label;
  }

  // `icon(name)` returns svg markup, `tooltip` is the shared one of page-controls.js, `getState()`
  // returns { mode, cwd, workspaces, thinking }, and `actions` carries out what the user picks.
  function createMenus({ icon, tooltip, getState, actions }) {
    const host = document.createElement('dsx-menus');
    const shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = STYLES;
    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.tabIndex = -1;
    panel.hidden = true;
    shadow.append(style, panel);

    // { kind, anchor, box, onClose, selected, query, view }
    let active = null;

    function el(tag, className, text) {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    }

    function svgNode(name, className) {
      const holder = document.createElement('template');
      holder.innerHTML = icon(name);
      const svg = holder.content.firstElementChild;
      if (className) svg.setAttribute('class', className);
      return svg;
    }

    // A row. `pick` runs on a real click or Enter and is what the row does.
    function item(label, { iconName, tick, title, pick, valueText, chevron, action, nav = true }) {
      const node = el('div', 'item');
      if (action) node.dataset.action = action;
      node.setAttribute('role', 'menuitem');
      if (title) node.title = title;
      if (iconName) node.append(svgNode(iconName));
      node.append(el('span', 'label', label));
      if (valueText !== undefined) {
        const value = el('span', 'value', valueText);
        if (chevron) value.append(svgNode('chevronRight', 'chev'));
        node.append(value);
      }
      if (tick) node.append(svgNode('check', 'tick'));
      if (nav) wireNav(node, pick);
      return node;
    }

    // Makes a row something the arrow keys and the mouse can pick.
    function wireNav(node, pick) {
      node.dataset.nav = '';
      node.pick = pick;
      node.addEventListener('mousedown', (event) => event.preventDefault());
      node.addEventListener('mousemove', () => select(node));
      node.addEventListener('click', (event) => {
        if (event.isTrusted) pick();
      });
    }

    function navigable() {
      return [...panel.querySelectorAll('[data-nav]')];
    }

    function select(target) {
      const nodes = navigable();
      active.selected = Math.max(nodes.indexOf(target), 0);
      nodes.forEach((node, index) => node.setAttribute('aria-selected', String(index === active.selected)));
    }

    function highlight() {
      const nodes = navigable();
      if (!nodes.length) return;
      active.selected = Math.min(Math.max(active.selected, 0), nodes.length - 1);
      nodes.forEach((node, index) => {
        const selected = index === active.selected;
        node.setAttribute('aria-selected', String(selected));
        if (selected) node.scrollIntoView({ block: 'nearest' });
      });
    }

    // Closes the menu first and then does what was picked, so the focus is already back by then.
    function pickThen(action) {
      return () => {
        close('pick');
        action();
      };
    }

    function renderWorkspace() {
      const state = getState();
      const known = state.cwd && !state.workspaces.some((path) => samePath(path, state.cwd)) ? [state.cwd, ...state.workspaces] : state.workspaces;
      panel.replaceChildren(
        item(DEFAULT_WORKSPACE, { action: 'workspace-default', iconName: 'folder', tick: !state.cwd, pick: pickThen(() => actions.selectWorkspace('')) }),
        ...known.map((path) => item(basename(path), {
          action: 'workspace-saved', iconName: 'folder', tick: samePath(path, state.cwd), title: path, pick: pickThen(() => actions.selectWorkspace(path)),
        })),
        el('div', 'sep'),
        item('Add workspace...', { action: 'add-workspace', iconName: 'plus', pick: pickThen(() => actions.addWorkspace()) }),
      );
    }

    const STATE_ICONS = { running: 'spinner', queued: 'clock', ok: 'check', failed: 'x', timeout: 'x', stopped: 'ban' };
    const WORKING_STATES = new Set(['queued', 'running']);

    // How the figures of a helper are written, shared by the first draw and by the ticks.
    function describe(entry) {
      const formatTokens = root.DsxFormatTokens ? root.DsxFormatTokens.formatTokens : (value) => String(Math.round(value));
      const formatDuration = root.DsxChatStats.formatDuration;
      return root.DsxAgentView.describeAgent(entry, Date.now(), { formatTokens, formatDuration });
    }

    // One helper: its state, its name, and under it the tokens and the time. A row that has a chat to go to
    // opens it; one that is still waiting for a place is only shown.
    function agentRow(entry) {
      const row = describe(entry);
      const node = el('div', 'item agent');
      node.dataset.action = 'agent-open';
      node.dataset.id = entry.id;
      node.setAttribute('role', 'menuitem');
      node.append(svgNode(STATE_ICONS[entry.state] || 'clock', `state ${entry.state}`));
      const stack = el('div', 'stack');
      stack.append(el('span', 'label', row.title), el('span', 'meta', row.meta));
      node.append(stack);
      if (row.clickable) {
        node.append(svgNode('chevronRight', 'chev'));
        wireNav(node, pickThen(() => actions.openAgent(entry.id)));
      } else {
        node.classList.add('static');
      }
      // A helper that has ended can be taken off the list. This only removes it from here: its chat stays in
      // DeepSeek's history. The menu stays open, so several can be removed in a row.
      if (!WORKING_STATES.has(entry.state)) {
        const remove = el('span', 'dismiss');
        remove.dataset.action = 'agent-dismiss';
        remove.setAttribute('role', 'button');
        remove.setAttribute('aria-label', `Remove ${row.title} from the list`);
        remove.title = 'Remove from the list';
        remove.append(svgNode('x'));
        remove.addEventListener('mousedown', (event) => event.preventDefault());
        remove.addEventListener('click', (event) => {
          event.stopPropagation();
          if (event.isTrusted) actions.dismissAgent(entry.id);
        });
        node.append(remove);
        node.dismiss = () => actions.dismissAgent(entry.id);
      }
      return node;
    }

    function renderAgents() {
      const state = getState();
      const entries = state.agents || [];
      const list = el('div', 'list');
      list.setAttribute('role', 'menu');
      list.append(...entries.map(agentRow));
      const parts = [list, el('div', 'sep')];
      if (entries.some((entry) => !WORKING_STATES.has(entry.state))) {
        parts.push(item('Clear finished', { action: 'agents-clear', iconName: 'x', pick: () => actions.clearAgents() }));
      }
      parts.push(el('div', 'caption', 'Up to 2 helpers work at the same time.'));
      panel.replaceChildren(...parts);
    }

    // Keeps the times of the working helpers running, one second at a time, without drawing the list again,
    // which would throw the scroll and the highlighted row back to the start.
    function tick() {
      if (!active || active.kind !== 'agents') return;
      const entries = new Map((getState().agents || []).map((entry) => [entry.id, entry]));
      for (const node of panel.querySelectorAll('.item.agent')) {
        const entry = entries.get(node.dataset.id);
        if (!entry || (entry.state !== 'running' && entry.state !== 'queued')) continue;
        const meta = node.querySelector('.meta');
        const text = describe(entry).meta;
        if (meta && meta.textContent !== text) meta.textContent = text;
      }
    }

    function permissionRows(list) {
      const state = getState();
      const query = active.query.trim().toLowerCase();
      const shown = MODES.filter((mode) => mode.label.toLowerCase().includes(query));
      if (!shown.length) {
        list.replaceChildren(el('div', 'empty', 'No matching option'));
        return;
      }
      list.replaceChildren(...shown.map((mode) => item(mode.label, {
        action: `mode-${mode.id}`, tick: mode.id === state.mode, pick: pickThen(() => actions.selectMode(mode.id)),
      })));
    }

    function renderPermission() {
      const search = el('input', 'search');
      search.type = 'text';
      search.placeholder = 'Search...';
      search.setAttribute('aria-label', 'Search');
      search.autocomplete = 'off';
      search.spellcheck = false;
      search.value = active.query;
      const list = el('div', 'list');
      list.setAttribute('role', 'menu');
      search.addEventListener('input', () => {
        active.query = search.value;
        active.selected = 0;
        permissionRows(list);
        highlight();
      });
      panel.replaceChildren(search, list);
      permissionRows(list);
    }

    function renderModel() {
      const state = getState();
      if (active.view === 'effort') {
        const back = item('Effort', { action: 'effort-back', iconName: 'chevronLeft', pick: () => { active.view = 'main'; active.selected = 0; render(); } });
        panel.replaceChildren(
          back,
          el('div', 'sep'),
          item('On', { action: 'effort-on', tick: state.thinking, pick: () => { actions.setThinking(true); active.view = 'main'; active.selected = 0; render(); } }),
          item('Off', { action: 'effort-off', tick: !state.thinking, pick: () => { actions.setThinking(false); active.view = 'main'; active.selected = 0; render(); } }),
        );
        return;
      }

      // The model is fixed: its row only shows it and cannot be opened.
      const modelRow = item('Model', { valueText: MODEL_NAME, nav: false });
      modelRow.classList.add('static');

      // How much of the model's context window the open chat has used, as DeepSeek counts it.
      const context = state.context || { used: 0, limit: null };
      const format = root.DsxFormatTokens ? root.DsxFormatTokens.formatTokens : (value) => String(Math.round(value));
      const known = context.limit > 0;
      const ratio = known ? Math.min(context.used / context.limit, 1) : 0;
      const contextRow = item('Context', {
        valueText: known ? `${format(context.used)} / ${format(context.limit)}` : format(context.used),
        title: known ? `${Math.round(context.used).toLocaleString('en-US')} of ${Math.round(context.limit).toLocaleString('en-US')} tokens` : '',
        nav: false,
      });
      contextRow.classList.add('static');
      const bar = el('div', `bar${ratio >= 0.95 ? ' full' : ratio >= 0.8 ? ' warn' : ''}`);
      const fill = document.createElement('i');
      fill.style.width = `${(ratio * 100).toFixed(1)}%`;
      bar.append(fill);
      const effortRow = item('Effort', {
        action: 'effort-row', valueText: state.thinking ? 'On' : 'Off', chevron: true,
        pick: () => { active.view = 'effort'; active.selected = getState().thinking ? 1 : 2; render(); },
      });

      panel.replaceChildren(modelRow, contextRow, ...(known ? [bar] : []), effortRow);
    }

    function render() {
      if (!active) return;
      tooltip.hide();
      // A list that is drawn again keeps the place it was scrolled to.
      const scrolled = panel.querySelector('.list');
      const scrollTop = scrolled ? scrolled.scrollTop : 0;
      panel.className = `panel ${active.kind}`;
      if (active.kind === 'workspace') renderWorkspace();
      else if (active.kind === 'agents') renderAgents();
      else if (active.kind === 'permission') renderPermission();
      else renderModel();
      position();
      const list = panel.querySelector('.list');
      if (list && active.kind === 'agents') list.scrollTop = scrollTop;
      highlight();
      const search = panel.querySelector('.search');
      if (search) search.focus({ preventScroll: true });
      else panel.focus({ preventScroll: true });
    }

    function position() {
      const anchorRect = active.anchor.getBoundingClientRect();
      const boxRect = active.box ? active.box.getBoundingClientRect() : anchorRect;
      panel.style.left = '0px';
      panel.style.top = '0px';
      panel.style.width = active.kind === 'permission' ? `${Math.round(boxRect.width)}px` : '';
      panel.hidden = false;
      const size = panel.getBoundingClientRect();
      let left;
      let top;
      if (active.kind === 'workspace' || active.kind === 'agents') {
        // Under the button, or above it when the page ends before the list does.
        left = anchorRect.left;
        top = anchorRect.bottom + GAP_PX / 2;
        if (top + size.height > window.innerHeight - MARGIN_PX) top = anchorRect.top - GAP_PX / 2 - size.height;
      } else if (active.kind === 'model') {
        left = anchorRect.right - size.width;
        top = anchorRect.top - GAP_PX - size.height;
        if (top < MARGIN_PX) top = anchorRect.bottom + GAP_PX;
      } else {
        // Across the composer, sitting on its top edge.
        left = boxRect.left;
        top = boxRect.top - GAP_PX - size.height;
        if (top < MARGIN_PX) top = boxRect.bottom + GAP_PX;
      }
      left = Math.min(Math.max(left, MARGIN_PX), Math.max(window.innerWidth - size.width - MARGIN_PX, MARGIN_PX));
      panel.style.left = `${Math.round(left)}px`;
      panel.style.top = `${Math.round(top)}px`;
    }

    // `reason` is 'pick', 'escape', 'outside' or 'toggle', so the caller knows whether to take the focus back.
    function close(reason) {
      if (!active) return;
      const { onClose } = active;
      active = null;
      tooltip.hide();
      panel.hidden = true;
      panel.replaceChildren();
      if (onClose) onClose(reason);
    }

    function open(kind, { anchor, box, onClose }) {
      if (active) close('toggle');
      if (!document.body) return;
      if (!host.isConnected) document.body.append(host);
      const mode = getState().mode;
      active = { kind, anchor, box, onClose, query: '', view: 'main', selected: kind === 'permission' ? Math.max(MODES.findIndex((entry) => entry.id === mode), 0) : 0 };
      render();
    }

    panel.addEventListener('keydown', (event) => {
      if (!active || !event.isTrusted || event.isComposing) return;
      const nodes = navigable();
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close('escape');
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (!nodes.length) return;
        active.selected = (active.selected + (event.key === 'ArrowDown' ? 1 : -1) + nodes.length) % nodes.length;
        highlight();
      } else if (event.key === 'Enter') {
        event.preventDefault();
        const node = nodes[active.selected];
        if (node && node.pick) node.pick();
      } else if ((event.key === 'Delete' || event.key === 'Backspace') && active.kind === 'agents') {
        // Takes the highlighted helper off the list, when it has ended.
        const node = nodes[active.selected];
        if (node && node.dismiss) {
          event.preventDefault();
          node.dismiss();
        }
      } else if (event.key === 'Tab') {
        // The panel is a small world of its own: Tab does not wander off into the page behind it.
        event.preventDefault();
      }
    });

    document.addEventListener('mousedown', (event) => {
      if (!active || !event.isTrusted) return;
      const path = event.composedPath();
      if (path.includes(host) || path.includes(active.anchor)) return;
      close('outside');
    }, true);
    window.addEventListener('resize', () => close('outside'));

    return {
      host,
      open,
      close,
      isOpen: (kind) => Boolean(active) && (!kind || active.kind === kind),
      refresh: () => { if (active) render(); },
      tick,
    };
  }

  root.DsxMenus = { createMenus, MODES, MODEL_NAME, DEFAULT_WORKSPACE, basename, samePath, modeLabel };
})(globalThis);
