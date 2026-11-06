// Slash commands in DeepSeek's composer: a suggestion menu while you type "/", Tab to complete, and
// Enter to run. It draws the menu in DeepSeek's own dropdown style and handles the keys. What the
// commands do is decided by the caller, and what the text means by lib/slash-match.js.
//
// Tab never moves focus out of the composer, so it can only complete. The menu and the keys react
// only to real key presses: a page script cannot run a command by faking an Enter.
(function (root) {
  'use strict';

  const { plan } = root.DsxSlashMatch;

  // Copied from DeepSeek's .ds-dropdown-menu and .ds-dropdown-menu-option, using the same tokens, so
  // the menu follows its light and dark themes.
  const STYLES = `
    :host { position: fixed; left: 0; top: 0; width: 0; height: 0; z-index: 2147483000; }
    * { box-sizing: border-box; }
    .panel {
      position: fixed; min-width: 240px; max-width: min(480px, calc(100vw - 16px)); padding: 4px; border-radius: 12px;
      font-size: var(--ds-font-size-m, 14px); line-height: 24px;
      color: var(--dsw-alias-label-primary, #f9fafb);
      background-color: var(--dsw-specific-menu, var(--dsw-alias-bg-layer-3, #2b2c2f));
      box-shadow: 0 0 1px rgba(0, 0, 0, .2), 0 0 4px rgba(0, 0, 0, .02), 0 12px 32px rgba(0, 0, 0, .08);
    }
    .panel[hidden] { display: none; }
    .options { max-height: 304px; overflow-y: auto; scrollbar-width: thin; }
    .option {
      display: flex; align-items: center; gap: 12px; min-height: 24px; padding: 8px 10px; border-radius: 8px;
      cursor: pointer; user-select: none; overflow: hidden;
      transition: background-color var(--ds-transition-duration, .2s) var(--ds-ease-in-out, cubic-bezier(.4, 0, .2, 1));
    }
    .option:hover, .option[aria-selected="true"] { background-color: var(--dsw-alias-interactive-bg-hover, rgba(255, 255, 255, .08)); }
    .name { flex: none; min-width: 88px; font-weight: 500; white-space: nowrap; }
    .desc { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-tertiary, #adb2b8); }
    .empty { padding: 8px 10px; color: var(--dsw-alias-label-tertiary, #adb2b8); }
    .hint {
      margin-top: 4px; padding: 6px 10px 4px; font-size: var(--ds-font-size-s, 12px); line-height: 18px;
      color: var(--dsw-alias-label-caption, #81858c); border-top: 1px solid var(--dsw-alias-border-l2, rgba(255, 255, 255, .12));
    }
    .message { padding: 6px 10px; cursor: pointer; }
    .message div { white-space: pre-wrap; overflow-wrap: anywhere; }
    .message.error { color: var(--dsw-alias-state-error-primary, #f25a5a); }
    .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
    @media (prefers-reduced-motion: reduce) { .option { transition: none; } }
  `;
  const HINT = '↑↓ to move · Tab to complete · Enter to run · Esc to close';
  const GAP_PX = 8;
  const MESSAGE_MS = 6000;

  // `commands` is the list lib/slash-match.js understands. `run(name, argument)` carries a command out
  // and may return { lines, error }, which is shown above the composer. `findBox(textarea)` returns
  // the rounded box around the composer, which the menu sits on top of.
  function createSlashCommands({ commands, run, findBox }) {
    const host = document.createElement('dsx-commands');
    const shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = STYLES;
    const menu = document.createElement('div');
    menu.className = 'panel';
    menu.setAttribute('role', 'listbox');
    menu.hidden = true;
    const options = document.createElement('div');
    options.className = 'options';
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = HINT;
    menu.append(options, hint);
    const message = document.createElement('div');
    message.className = 'panel message';
    message.setAttribute('role', 'status');
    message.hidden = true;
    const announcer = document.createElement('div');
    announcer.className = 'sr';
    announcer.setAttribute('aria-live', 'polite');
    shadow.append(style, menu, message, announcer);

    let index = 0;
    // The text the user closed the menu on with Escape. It stays closed until the text changes.
    let dismissedText = null;
    let current = null;
    let messageTimer = null;

    function composer() {
      const areas = [...document.querySelectorAll('textarea')].filter((area) => area.getClientRects().length > 0);
      return areas[areas.length - 1] || null;
    }

    // The page's own code sets the composer while it sends a result, and none of that is a command.
    function isBusySending(area) {
      return area.hasAttribute('data-dsx-sending');
    }

    function setText(area, value) {
      area.value = value;
      area.dispatchEvent(new Event('input', { bubbles: true }));
      area.setSelectionRange(value.length, value.length);
    }

    function place(panel, area) {
      const box = (findBox && findBox(area)) || area;
      const rect = box.getBoundingClientRect();
      panel.style.left = `${Math.max(rect.left, GAP_PX)}px`;
      panel.style.bottom = `${Math.max(window.innerHeight - rect.top + GAP_PX, GAP_PX)}px`;
      panel.style.width = `${Math.min(rect.width, 480)}px`;
    }

    function mount() {
      if (document.body && !host.isConnected) document.body.append(host);
    }

    function menuIsOpen() {
      return !menu.hidden;
    }

    // A hidden menu holds no text, so nothing of it is left in the page.
    function hideMenu() {
      menu.hidden = true;
      current = null;
      options.replaceChildren();
      announcer.textContent = '';
    }

    function hideMessage() {
      clearTimeout(messageTimer);
      message.hidden = true;
      message.replaceChildren();
    }

    function select(newIndex) {
      if (!current || !current.items.length) return;
      index = (newIndex + current.items.length) % current.items.length;
      // What Tab and Enter do depends on the highlighted suggestion, so it is worked out again.
      const area = composer();
      if (area) current = plan(commands, area.value, index) || current;
      [...options.children].forEach((node, position) => {
        const selected = position === index;
        node.setAttribute('aria-selected', String(selected));
        if (selected) node.scrollIntoView({ block: 'nearest' });
      });
      const item = current.items[index];
      announcer.textContent = `${item.name ? `/${item.name}` : item.value}, ${item.description}`;
    }

    function optionNode(item, position) {
      const node = document.createElement('div');
      node.className = 'option';
      node.setAttribute('role', 'option');
      node.setAttribute('aria-selected', String(position === index));
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = item.name ? `/${item.name}` : item.value;
      const description = document.createElement('span');
      description.className = 'desc';
      description.textContent = item.description || '';
      node.append(name, description);
      // Keeps the focus in the composer, so a click does not close the menu by blurring it.
      node.addEventListener('mousedown', (event) => event.preventDefault());
      node.addEventListener('mousemove', () => {
        if (index !== position) select(position);
      });
      node.addEventListener('click', (event) => {
        if (!event.isTrusted) return;
        select(position);
        accept();
      });
      return node;
    }

    function render() {
      const area = composer();
      if (!area || isBusySending(area) || document.activeElement !== area || area.value === dismissedText) {
        hideMenu();
        return;
      }
      current = plan(commands, area.value, index);
      if (!current) {
        hideMenu();
        return;
      }
      index = Math.min(index, Math.max(current.items.length - 1, 0));
      mount();
      hideMessage();
      options.replaceChildren();
      if (current.items.length) {
        current.items.forEach((item, position) => options.append(optionNode(item, position)));
      } else {
        const none = document.createElement('div');
        none.className = 'empty';
        none.textContent = 'No matching option';
        options.append(none);
      }
      menu.hidden = false;
      place(menu, area);
      select(index);
    }

    function showMessage(lines, error) {
      const area = composer();
      if (!area) return;
      mount();
      hideMenu();
      message.replaceChildren(...lines.map((line) => {
        const row = document.createElement('div');
        row.textContent = line;
        return row;
      }));
      message.classList.toggle('error', Boolean(error));
      message.hidden = false;
      place(message, area);
      clearTimeout(messageTimer);
      messageTimer = setTimeout(hideMessage, MESSAGE_MS);
    }

    async function execute({ name, arg }) {
      const area = composer();
      if (area) setText(area, '');
      hideMenu();
      try {
        const result = await run(name, arg);
        if (result && result.lines && result.lines.length) showMessage(result.lines, result.error);
      } catch (error) {
        showMessage([error && error.message ? error.message : 'The command failed.'], true);
      }
    }

    // Tab: puts the highlighted suggestion in the composer.
    function complete() {
      const area = composer();
      if (area && current && current.completion) setText(area, current.completion);
    }

    // Enter, or a click: runs the highlighted command, or completes it when it needs an argument.
    function accept() {
      if (!current) return;
      if (current.run) execute(current.run);
      else complete();
    }

    function block(event) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }

    function onKeyDown(event) {
      if (!event.isTrusted || event.isComposing) return;
      const area = composer();
      if (!area || event.target !== area || isBusySending(area)) return;

      if (event.key === 'Tab' && !event.ctrlKey && !event.altKey && !event.metaKey) {
        // Focus stays in the composer, so Tab is free to complete.
        block(event);
        if (menuIsOpen()) {
          if (event.shiftKey) select(index - 1);
          else complete();
        }
        return;
      }
      if (!menuIsOpen()) return;

      if (event.key === 'ArrowDown') {
        block(event);
        select(index + 1);
      } else if (event.key === 'ArrowUp') {
        block(event);
        select(index - 1);
      } else if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
        block(event);
        accept();
      } else if (event.key === 'Escape') {
        block(event);
        dismissedText = area.value;
        hideMenu();
      }
    }

    function onInput(event) {
      if (event.target !== composer()) return;
      dismissedText = null;
      index = 0;
      hideMessage();
      render();
    }

    function start() {
      window.addEventListener('keydown', onKeyDown, true);
      document.addEventListener('input', onInput, true);
      document.addEventListener('focusin', render, true);
      document.addEventListener('focusout', () => setTimeout(render, 0), true);
      window.addEventListener('resize', render);
      message.addEventListener('click', (event) => {
        if (event.isTrusted) hideMessage();
      });
    }

    return { start, showMessage };
  }

  root.DsxSlashCommands = { createSlashCommands };
})(globalThis);
