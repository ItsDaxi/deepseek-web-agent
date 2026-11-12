// The projects section of DeepSeek's sidebar: one group per folder, with that folder's chats under it and a
// "+" that starts a new chat in it. The list of the sidebar belongs to React, so nothing of it is moved: the
// section is one extra element put at the top of the list, and the chats that it shows are hidden from the
// list below with an attribute, which page.css turns into display: none.
//
// A right click on a chat or on a project opens a menu to delete it. A project is dragged by its name to a new
// place, with all its chats: a chat on its own cannot be moved to another project.
(function (root) {
  'use strict';

  const ICONS = {
    chevron: '<path d="M9 6l6 6l-6 6"/>',
    plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
    x: '<path d="M18 6l-12 12"/><path d="M6 6l12 12"/>',
    trash: '<path d="M4 7h16"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2 -2l1 -12"/><path d="M9 7v-3a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v3"/>',
  };
  const CHAT_LINK = 'a[href*="/a/chat/s/"]';
  const IN_PROJECT = 'data-dsx-in-project';
  // A project shows its newest chats and a row to show the rest, so one busy folder cannot push the others away.
  const MAX_SHOWN = 6;

  const FONT = 'Inter, system-ui, -apple-system, "Segoe UI", sans-serif';
  const STYLES = `
    :host { display: block; margin: 0 0 12px; }
    * { box-sizing: border-box; }
    .group { border-radius: 8px; transition: opacity .12s ease; }
    .group + .group { margin-top: 6px; }
    .group.dragging { opacity: .4; }
    .group.drop-before { box-shadow: 0 -3px 0 -1px var(--dsw-alias-brand-primary, #5686fe); }
    .group.drop-after { box-shadow: 0 3px 0 -1px var(--dsw-alias-brand-primary, #5686fe); }
    .label {
      display: flex; align-items: center; height: 26px; padding: 0 8px 0 4px; border-radius: 8px; cursor: grab;
      font: 500 12px/18px ${FONT}; user-select: none;
      color: var(--dsw-alias-label-tertiary, #adb2b8);
    }
    .label:hover { color: var(--dsw-alias-label-primary, #f9fafb); }
    button { font: inherit; color: inherit; background: none; border: 0; padding: 0; cursor: pointer; outline: none; }
    button:focus-visible, .row:focus-visible { box-shadow: inset 0 0 0 2px var(--dsw-alias-brand-primary, #5686fe); }
    .toggle { flex: 1; min-width: 0; display: flex; align-items: center; gap: 4px; height: 26px; text-align: left; border-radius: 8px; cursor: inherit; }
    .toggle:focus-visible { box-shadow: inset 0 0 0 2px var(--dsw-alias-brand-primary, #5686fe); outline: none; }
    .toggle .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .toggle svg { width: 12px; height: 12px; transition: transform .12s ease; }
    .group:not(.folded) .toggle svg { transform: rotate(90deg); }
    .plus {
      width: 22px; height: 22px; flex: none; display: inline-flex; align-items: center; justify-content: center;
      border-radius: 6px; opacity: 0; color: var(--dsw-alias-label-secondary, #d1d5db);
    }
    .label:hover .plus, .plus:focus-visible { opacity: 1; }
    .plus:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.1)); color: var(--dsw-alias-label-primary, #f9fafb); }
    .plus svg { width: 14px; height: 14px; }
    .row {
      display: flex; align-items: center; gap: 4px; height: 40px; padding: 9px 6px 9px 10px; border-radius: 12px; cursor: pointer;
      font: 14px/22px ${FONT}; color: var(--dsw-alias-label-primary, #f9fafb); outline: none;
    }
    .row:hover { background: var(--dsw-specific-sidebar-nav-item-hover, var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.08))); }
    .row.active { background: color-mix(in srgb, var(--dsw-alias-label-primary, #f9fafb) 11%, transparent); }
    .title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; line-height: 18px; }
    .remove {
      width: 22px; height: 22px; flex: none; display: none; align-items: center; justify-content: center; border-radius: 6px;
      color: var(--dsw-alias-label-tertiary, #adb2b8);
    }
    .row:hover .remove, .remove:focus-visible { display: inline-flex; }
    .remove:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.1)); color: var(--dsw-alias-label-primary, #f9fafb); }
    .remove svg { width: 13px; height: 13px; }
    svg { fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; flex: none; }
    .more {
      display: block; width: 100%; height: 28px; padding: 0 10px; text-align: left; border-radius: 10px;
      font: 12px/18px ${FONT}; color: var(--dsw-alias-label-tertiary, #adb2b8);
    }
    .more:hover { color: var(--dsw-alias-label-primary, #f9fafb); background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.08)); }
    @media (prefers-reduced-motion: reduce) { .toggle svg, .group { transition: none; } }
  `;

  // The menu lives on the body, where no ancestor in the sidebar can clip it.
  const MENU_STYLES = `
    :host { position: fixed; left: 0; top: 0; z-index: 2147483000; }
    * { box-sizing: border-box; }
    .menu {
      position: fixed; min-width: 200px; max-width: 280px; padding: 6px; border-radius: 12px;
      font: 13px/20px ${FONT}; color: var(--dsw-alias-label-primary, #f9fafb);
      background: var(--dsw-specific-popover-fill, var(--dsw-alias-bg-layer-2, #2a2b2d));
      border: 1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.1)); box-shadow: 0 8px 28px rgba(0,0,0,.4);
      animation: in .08s ease-out;
    }
    @keyframes in { from { opacity: 0; transform: translateY(-2px); } to { opacity: 1; transform: none; } }
    button {
      display: flex; align-items: center; gap: 8px; width: 100%; height: 32px; padding: 0 10px; border: 0; border-radius: 8px;
      font: inherit; color: inherit; background: none; text-align: left; cursor: pointer; outline: none;
    }
    button:hover, button:focus-visible { background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.08)); }
    button.danger { color: var(--dsw-alias-state-error-primary, #f0605d); }
    button.confirm { color: #fff; background: var(--dsw-alias-state-error-primary, #d93f3c); justify-content: center; }
    button.confirm:hover, button.confirm:focus-visible { background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #d93f3c) 85%, #fff); }
    button.cancel { justify-content: center; }
    .row2 { display: flex; gap: 6px; margin-top: 6px; }
    .row2 button { flex: 1; }
    p { margin: 4px 8px 6px; line-height: 18px; overflow-wrap: anywhere; }
    p.note { color: var(--dsw-alias-label-tertiary, #adb2b8); font-size: 12px; margin-top: 0; }
    p.error { color: var(--dsw-alias-state-error-primary, #f0605d); }
    svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; flex: none; }
    @media (prefers-reduced-motion: reduce) { .menu { animation: none; } }
  `;

  function icon(name) {
    return `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function withIcon(node, name) {
    node.insertAdjacentHTML('afterbegin', icon(name));
    return node;
  }

  function plural(count, word) {
    return `${count} ${word}${count === 1 ? '' : 's'}`;
  }

  // Everything the user does here is handed back through `actions`, and only for an event the user made: a
  // script of the page cannot delete a chat or start one, because the shadow roots are closed and untrusted
  // events are ignored. `onDelete(ids)` returns a promise of { ok, error }.
  function createSidebarProjects({ sessionOf, onOpenChat, onNewChat, onRemoveChat, onToggleFold, onDelete, onReorder }) {
    const host = document.createElement('dsx-projects');
    const shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = STYLES;
    const box = document.createElement('div');
    shadow.append(style, box);
    // The folders that show all their chats instead of the newest few. It lasts until the page is reloaded.
    const expanded = new Set();
    // Chats deleted on DeepSeek. Its own list still shows them until the page loads again, so they stay hidden.
    const deleted = new Set();
    let shownKey = '';
    let lastModel = { groups: [], folded: {}, currentId: null };
    let dragging = null;

    function anchors() {
      return [...document.querySelectorAll(CHAT_LINK)];
    }

    // The list holding DeepSeek's groups (Today, Yesterday...): the parent of the group that holds a chat.
    function findList(links) {
      const group = links.length ? links[0].parentElement : null;
      return group ? group.parentElement : null;
    }

    // DeepSeek puts a small button for choosing chats over the right end of the first line of the list, which is
    // where the "+" of the first project is. It is a sibling of the scrolling list, before it. It stays hidden
    // while the section is there and comes back when there are no projects.
    let chooser = null;

    function setChooserHidden(list, hidden) {
      const scroller = list ? list.parentElement : null;
      const found = scroller && scroller.parentElement
        ? [...scroller.parentElement.children].find((node) => node !== scroller && node.matches('[role="button"]') && node.compareDocumentPosition(scroller) & Node.DOCUMENT_POSITION_FOLLOWING)
        : null;
      if (found) chooser = found;
      if (chooser && chooser.hasAttribute('data-dsx-hidden') !== hidden) chooser.toggleAttribute('data-dsx-hidden', hidden);
    }

    function draw(model) {
      const rows = [];
      for (const group of model.groups) {
        const folded = Boolean(model.folded[group.path]);
        const all = expanded.has(group.path);
        const shown = all ? group.chats : group.chats.slice(0, MAX_SHOWN);
        const part = el('div', folded ? 'group folded' : 'group');
        part.dataset.path = group.path;

        const label = el('div', 'label');
        label.draggable = true;
        // Not a <button>: Firefox cannot start a drag from inside one, and the name is what is dragged.
        const toggle = withIcon(el('div', 'toggle'), 'chevron');
        toggle.setAttribute('role', 'button');
        toggle.tabIndex = 0;
        toggle.dataset.action = 'toggle';
        toggle.setAttribute('aria-expanded', String(!folded));
        toggle.title = group.path;
        toggle.append(el('span', 'name', group.label));
        const plus = withIcon(el('button', 'plus'), 'plus');
        plus.type = 'button';
        plus.dataset.action = 'new';
        plus.setAttribute('aria-label', `New chat in ${group.label}`);
        plus.title = `New chat in ${group.label}`;
        label.append(toggle, plus);
        part.append(label);

        if (!folded) {
          for (const chat of shown) {
            const row = el('div', chat.id === model.currentId ? 'row active' : 'row');
            row.dataset.action = 'open';
            row.dataset.id = chat.id;
            row.setAttribute('role', 'link');
            row.tabIndex = 0;
            const remove = withIcon(el('button', 'remove'), 'x');
            remove.type = 'button';
            remove.dataset.action = 'remove';
            remove.setAttribute('aria-label', 'Remove from the project');
            remove.title = 'Remove from the project';
            row.append(el('span', 'title', chat.title), remove);
            part.append(row);
          }
          if (group.chats.length > MAX_SHOWN) {
            const more = el('button', 'more', all ? 'Show less' : `Show all ${group.chats.length}`);
            more.type = 'button';
            more.dataset.action = 'more';
            part.append(more);
          }
        }
        rows.push(part);
      }
      box.replaceChildren(...rows);
    }

    // Marks the chats that belong to a project, draws the section when something about it changed, and keeps
    // it at the top of the list. Returns the titles that DeepSeek shows for those chats.
    function sync(model) {
      lastModel = model;
      const links = anchors();
      const members = new Set();
      for (const group of model.groups) for (const chat of group.chats) members.add(chat.id);
      const titles = {};
      for (const link of links) {
        const id = sessionOf(link.getAttribute('href'));
        if (!id) continue;
        const inside = members.has(id);
        // A deleted chat is hidden like one that has moved to a project, so it does not linger in the list.
        const hidden = inside || deleted.has(id);
        if (link.hasAttribute(IN_PROJECT) !== hidden) link.toggleAttribute(IN_PROJECT, hidden);
        if (inside) {
          const text = (link.textContent || '').trim();
          if (text) titles[id] = text;
        }
      }

      const list = findList(links);
      if (!model.groups.length || !list) {
        if (host.isConnected) host.remove();
        shownKey = '';
        setChooserHidden(list, false);
        return titles;
      }
      setChooserHidden(list, true);
      const key = JSON.stringify([model.groups.map((group) => [group.path, group.label, group.chats.map((chat) => [chat.id, chat.title])]), model.folded, model.currentId, [...expanded]]);
      if (key !== shownKey) {
        shownKey = key;
        draw(model);
      }
      if (list.firstElementChild !== host) list.prepend(host);
      return titles;
    }

    // ---- The menu of the right click ---------------------------------------------------------

    const menuHost = document.createElement('dsx-projects-menu');
    const menuShadow = menuHost.attachShadow({ mode: 'closed' });
    const menuStyle = document.createElement('style');
    menuStyle.textContent = MENU_STYLES;
    const menu = el('div', 'menu');
    menu.setAttribute('role', 'menu');
    menuShadow.append(menuStyle, menu);
    let menuOpen = false;
    let menuBusy = false;

    function closeMenu() {
      if (!menuOpen || menuBusy) return;
      menuOpen = false;
      menuHost.remove();
    }

    function place(x, y) {
      menu.style.left = '0px';
      menu.style.top = '0px';
      const width = menu.offsetWidth;
      const height = menu.offsetHeight;
      menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - width - 8))}px`;
      menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - height - 8))}px`;
    }

    function menuButton(text, className, handler, iconName) {
      const button = el('button', className);
      if (iconName) button.insertAdjacentHTML('afterbegin', icon(iconName));
      button.append(text);
      button.type = 'button';
      button.setAttribute('role', 'menuitem');
      button.addEventListener('click', (event) => {
        if (event.isTrusted) handler();
      });
      return button;
    }

    // The question before anything is deleted. It cannot be undone, so it is always asked.
    function showConfirm(point, ids, question) {
      const sure = menuButton('Delete', 'confirm', () => run(point, ids));
      const cancel = menuButton('Cancel', 'cancel', () => closeMenu());
      const buttons = el('div', 'row2');
      buttons.append(cancel, sure);
      menu.replaceChildren(el('p', '', question), el('p', 'note', 'This cannot be undone.'), buttons);
      place(point.x, point.y);
      cancel.focus();
    }

    async function run(point, ids) {
      menuBusy = true;
      menu.replaceChildren(el('p', '', `Deleting ${plural(ids.length, 'chat')}...`));
      place(point.x, point.y);
      let outcome;
      try {
        outcome = await onDelete(ids);
      } catch {
        outcome = { ok: false, error: 'something went wrong' };
      }
      menuBusy = false;
      if (outcome && outcome.ok) {
        for (const id of ids) deleted.add(id);
        closeMenu();
        sync(lastModel);
        return;
      }
      const close = menuButton('Close', 'cancel', () => closeMenu());
      menu.replaceChildren(el('p', 'error', `Could not delete: ${(outcome && outcome.error) || 'unknown error'}.`), close);
      place(point.x, point.y);
      close.focus();
    }

    function showMenu(point, entries) {
      if (menuBusy) return;
      menu.replaceChildren(...entries.map((entry) => menuButton(entry.text, entry.danger ? 'danger' : '', entry.run, entry.icon)));
      if (!menuHost.isConnected) document.body.append(menuHost);
      menuOpen = true;
      place(point.x, point.y);
      const first = menu.querySelector('button');
      if (first) first.focus();
    }

    function groupOf(path) {
      return lastModel.groups.find((group) => group.path === path);
    }

    function openContextMenu(event) {
      const target = event.target instanceof Element ? event.target : null;
      const part = target ? target.closest('.group') : null;
      if (!target || !part) return;
      const group = groupOf(part.dataset.path);
      if (!group) return;
      event.preventDefault();
      const point = { x: event.clientX, y: event.clientY };
      const row = target.closest('.row');
      const entries = [];
      if (row) {
        const chat = group.chats.find((entry) => entry.id === row.dataset.id);
        if (chat) {
          entries.push({ text: 'Delete chat', icon: 'trash', danger: true, run: () => showConfirm(point, [chat.id], `Delete "${chat.title}"?`) });
        }
        if (group.chats.length > 1) {
          entries.push({ text: `Delete all ${group.chats.length} chats here`, icon: 'trash', danger: true, run: () => showConfirm(point, group.chats.map((entry) => entry.id), `Delete all ${group.chats.length} chats in ${group.label}?`) });
        }
      } else {
        entries.push({ text: 'New chat', icon: 'plus', run: () => { closeMenu(); onNewChat(group.path); } });
        entries.push({ text: `Delete all ${plural(group.chats.length, 'chat')}`, icon: 'trash', danger: true, run: () => showConfirm(point, group.chats.map((entry) => entry.id), `Delete all ${plural(group.chats.length, 'chat')} in ${group.label}?`) });
      }
      if (entries.length) showMenu(point, entries);
    }

    box.addEventListener('contextmenu', (event) => {
      if (event.isTrusted) openContextMenu(event);
    });

    // Closes on a click outside, the Escape key, a scroll and a resize, as a menu does.
    document.addEventListener('mousedown', (event) => {
      if (menuOpen && !event.composedPath().includes(menuHost)) closeMenu();
    }, true);
    document.addEventListener('keydown', (event) => {
      if (menuOpen && event.key === 'Escape') closeMenu();
    }, true);
    window.addEventListener('resize', closeMenu);
    window.addEventListener('blur', closeMenu);
    window.addEventListener('wheel', () => closeMenu(), { passive: true });

    // ---- Moving a project --------------------------------------------------------------------
    // The project is dragged by its name, with every chat it holds. The line shows where it will land.

    function clearDropMarks() {
      for (const part of box.querySelectorAll('.drop-before, .drop-after')) part.classList.remove('drop-before', 'drop-after');
    }

    box.addEventListener('dragstart', (event) => {
      const part = event.target instanceof Element ? event.target.closest('.group') : null;
      if (!event.isTrusted || !part || !event.target.classList.contains('label')) {
        event.preventDefault();
        return;
      }
      dragging = part.dataset.path;
      part.classList.add('dragging');
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', dragging);
    });

    function dropTarget(event) {
      const part = event.target instanceof Element ? event.target.closest('.group') : null;
      if (!part || dragging === null || part.dataset.path === dragging) return null;
      const rect = part.getBoundingClientRect();
      return { part, after: event.clientY > rect.top + rect.height / 2 };
    }

    // DeepSeek listens for drags on the whole document, before this section does, to take dropped files. For a
    // drag of text it answers "none", which would forbid the drop here. Answering last, with "move", allows it.
    function allowMove(event) {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    }

    box.addEventListener('dragenter', (event) => {
      if (dragging !== null) allowMove(event);
    });

    box.addEventListener('dragover', (event) => {
      if (dragging === null) return;
      allowMove(event);
      const target = dropTarget(event);
      clearDropMarks();
      if (target) target.part.classList.add(target.after ? 'drop-after' : 'drop-before');
    });

    box.addEventListener('drop', (event) => {
      if (!event.isTrusted || dragging === null) return;
      allowMove(event);
      const target = dropTarget(event);
      const from = dragging;
      dragging = null;
      clearDropMarks();
      if (!target) {
        sync(lastModel);
        return;
      }
      const shownOrder = lastModel.groups.map((group) => group.path);
      const next = root.DsxProjects.reorder(shownOrder, from, target.part.dataset.path, target.after);
      if (next.some((path, index) => path !== shownOrder[index])) onReorder(next);
      else sync(lastModel);
    });

    box.addEventListener('dragend', () => {
      dragging = null;
      clearDropMarks();
      for (const part of box.querySelectorAll('.dragging')) part.classList.remove('dragging');
    });

    // ---- Clicks ------------------------------------------------------------------------------

    // A click on a row opens the chat; one on a button inside it does what the button says.
    box.addEventListener('click', (event) => {
      if (!event.isTrusted) return;
      const target = event.target instanceof Element ? event.target.closest('[data-action]') : null;
      if (!target) return;
      const part = target.closest('.group');
      const path = part ? part.dataset.path : '';
      switch (target.dataset.action) {
        case 'toggle':
          onToggleFold(path);
          break;
        case 'new':
          onNewChat(path);
          break;
        case 'open':
          onOpenChat(target.dataset.id);
          break;
        case 'remove':
          event.stopPropagation();
          onRemoveChat(target.closest('.row').dataset.id);
          break;
        case 'more':
          if (expanded.has(path)) expanded.delete(path);
          else expanded.add(path);
          sync(lastModel);
          break;
        default:
      }
    });

    box.addEventListener('keydown', (event) => {
      if (!event.isTrusted || (event.key !== 'Enter' && event.key !== ' ')) return;
      const node = event.target instanceof Element ? event.target : null;
      if (!node) return;
      if (node.classList.contains('row')) {
        event.preventDefault();
        onOpenChat(node.dataset.id);
      } else if (node.classList.contains('toggle')) {
        event.preventDefault();
        const part = node.closest('.group');
        if (part) onToggleFold(part.dataset.path);
      }
    });

    // The anchor DeepSeek draws for a chat, when the sidebar has loaded it.
    function anchorOf(id) {
      return anchors().find((link) => sessionOf(link.getAttribute('href')) === id) || null;
    }

    return { sync, anchorOf };
  }

  root.DsxSidebarProjects = { createSidebarProjects };
})(globalThis);
