// Controls placed on the DeepSeek page: a connection pill, and two buttons in the composer row.
// The buttons copy the values of DeepSeek's own .ds-toggle-button. Shadow roots are closed and
// handlers ignore untrusted events, so page scripts cannot change the permission mode.
(function (root) {
  'use strict';

  const ICONS = {
    folder: '<path d="M5 4h4l3 3h7a2 2 0 0 1 2 2v8a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-11a2 2 0 0 1 2 -2"/>',
    shield: '<path d="M12 3a12 12 0 0 0 8.5 3a12 12 0 0 1 -8.5 15a12 12 0 0 1 -8.5 -15a12 12 0 0 0 8.5 -3"/><path d="M9 12l2 2l4 -4"/>',
    bolt: '<path d="M13 3v7h6l-8 11v-7h-6l8 -11"/>',
    arrowUp: '<path d="M12 19v-14"/><path d="M18 11l-6 -6l-6 6"/>',
  };

  const BUTTON_STYLES = `
    :host { display: inline-flex; }
    button {
      box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; gap: 4px;
      height: 34px; padding: 10px; border-radius: 18px; cursor: pointer; user-select: none; outline: none; position: relative;
      font: inherit; font-size: 13px; font-weight: 500; white-space: nowrap;
      color: var(--dsw-alias-label-primary, #f9fafb); background: none;
      border: 1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.12));
      transition: border .2s ease, background .2s ease;
    }
    button:hover { background-color: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.08)); }
    button:focus-visible { box-shadow: 0 0 0 2px var(--dsw-alias-brand-primary, #5686fe); }
    button.selected { color: var(--dsw-alias-brand-text, #679efe); border-color: var(--dsw-alias-button-ghost-active-border, rgba(86,134,254,.5)); background-color: var(--dsw-alias-button-ghost-active-fill, rgba(86,134,254,.1)); }
    button.selected:hover { background-color: var(--dsw-alias-button-ghost-active-hover, rgba(86,134,254,.18)); }
    button.danger { color: var(--dsw-alias-state-error-primary, #f25a5a); border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary, #f25a5a) 55%, transparent); background-color: color-mix(in srgb, var(--dsw-alias-state-error-primary, #f25a5a) 12%, transparent); }
    button.danger:hover { background-color: color-mix(in srgb, var(--dsw-alias-state-error-primary, #f25a5a) 20%, transparent); }
    button.busy { opacity: .4; cursor: progress; }
    svg { width: 14px; height: 14px; flex: none; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
    @media (prefers-reduced-motion: reduce) { button { transition: none; } }
  `;

  // The top right corner: the connection pill, and to its left a link to the new release when
  // there is one. Both share one fixed row, so they never overlap whatever their width.
  const PILL_STYLES = `
    :host { position: fixed; top: 12px; right: 16px; z-index: 2147483000; display: flex; align-items: center; gap: 8px; }
    .status { display: flex; align-items: center; gap: 7px; height: 30px; padding: 0 11px; border-radius: 999px; font: 12px/18px Inter, system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--dsw-alias-label-secondary, #cfd3d6); background: var(--dsw-specific-tip, #353638); border: 1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.06)); }
    .status i { width: 7px; height: 7px; flex: none; border-radius: 50%; }
    .update { display: inline-flex; align-items: center; height: 30px; border-radius: 999px; font: 500 12px/18px Inter, system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--dsw-alias-brand-text, #679efe); border: 1px solid color-mix(in srgb, var(--dsw-alias-brand-primary, #5686fe) 55%, transparent); background: color-mix(in srgb, var(--dsw-alias-brand-primary, #5686fe) 14%, transparent); transition: background .2s ease; }
    .update:hover { background: color-mix(in srgb, var(--dsw-alias-brand-primary, #5686fe) 24%, transparent); }
    .update[hidden] { display: none; }
    .update a { display: inline-flex; align-items: center; gap: 6px; height: 100%; padding: 0 4px 0 11px; color: inherit; text-decoration: none; border-radius: 999px; }
    .update button { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; margin-right: 3px; padding: 0; border: 0; border-radius: 50%; background: none; color: inherit; cursor: pointer; font: inherit; font-size: 16px; line-height: 1; }
    .update button:hover { background: color-mix(in srgb, var(--dsw-alias-brand-primary, #5686fe) 24%, transparent); }
    .update a:focus-visible, .update button:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #5686fe); outline-offset: 1px; }
    svg { width: 14px; height: 14px; flex: none; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
    @media (prefers-reduced-motion: reduce) { .update { transition: none; } }
  `;

  const DOT_COLORS = { ok: 'var(--dsw-alias-state-success-primary, #22c55e)', warn: '#e5a13a' };

  function attach(tag, styles, markup) {
    const host = document.createElement(tag);
    const shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = styles;
    const body = document.createElement('template');
    body.innerHTML = markup;
    shadow.append(style, body.content);
    return { host, shadow };
  }

  function iconMarkup(name) {
    return `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;
  }

  // ---- Tooltip ---------------------------------------------------------------------------------
  // The browser's own title tooltip waits about a second. DeepSeek's native buttons show theirs at
  // once, so ours does too. One bubble is shared by every control and lives on the body, where no
  // ancestor of the composer can clip it.

  const TOOLTIP_STYLES = `
    :host { position: fixed; left: 0; top: 0; z-index: 2147483001; pointer-events: none; }
    div {
      position: fixed; box-sizing: border-box; max-width: 380px; overflow-wrap: anywhere; padding: 6px 10px; border-radius: 8px;
      font: 13px/20px Inter, system-ui, -apple-system, "Segoe UI", sans-serif;
      color: var(--dsw-alias-label-primary, #f9fafb); background: var(--dsw-specific-tip, #353638);
      border: 1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.06)); box-shadow: 0 4px 14px rgba(0,0,0,.28);
      animation: in .08s ease-out;
    }
    div[hidden] { display: none; }
    @keyframes in { from { opacity: 0; } to { opacity: 1; } }
    @media (prefers-reduced-motion: reduce) { div { animation: none; } }
  `;
  const TOOLTIP_GAP_PX = 8;
  const TOOLTIP_MARGIN_PX = 8;

  function createTooltip() {
    const tip = attach('dsx-tooltip', TOOLTIP_STYLES, '<div hidden></div>');
    const bubble = tip.shadow.querySelector('div');
    let current = null;

    function place(target) {
      const rect = target.getBoundingClientRect();
      bubble.style.left = '0px';
      bubble.style.top = '0px';
      const size = bubble.getBoundingClientRect();
      // Above the control, or below it when there is no room, like the pill at the top edge.
      let top = rect.top - TOOLTIP_GAP_PX - size.height;
      if (top < TOOLTIP_MARGIN_PX) top = rect.bottom + TOOLTIP_GAP_PX;
      const centered = rect.left + rect.width / 2 - size.width / 2;
      const left = Math.min(Math.max(centered, TOOLTIP_MARGIN_PX), Math.max(window.innerWidth - size.width - TOOLTIP_MARGIN_PX, TOOLTIP_MARGIN_PX));
      bubble.style.left = `${Math.round(left)}px`;
      bubble.style.top = `${Math.round(top)}px`;
    }

    // The text is cleared when hidden, so a hidden tooltip leaves nothing behind in the page.
    function hide() {
      current = null;
      bubble.hidden = true;
      bubble.textContent = '';
    }

    function show(target, getText) {
      const text = getText();
      if (!text) {
        hide();
        return;
      }
      current = { target, getText };
      bubble.textContent = text;
      bubble.hidden = false;
      place(target);
    }

    // Updates the text of a tooltip that is already showing, such as after a mode change.
    function refresh() {
      if (current) show(current.target, current.getText);
    }

    function bind(target, getText) {
      target.addEventListener('mouseenter', () => show(target, getText));
      target.addEventListener('mouseleave', hide);
      target.addEventListener('focus', () => {
        if (target.matches(':focus-visible')) show(target, getText);
      });
      target.addEventListener('blur', hide);
    }

    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);

    return { host: tip.host, bind, refresh };
  }

  // ---- Mode switch wave ------------------------------------------------------------------------
  // A short pixel wave across the composer when the permission mode changes: red for bypass,
  // light for manual. Cells are dithered with a Bayer matrix and a little fixed noise, so the
  // front reads as a detailed pixel pattern instead of a smooth gradient.

  const WAVE_STYLES = `
    :host { position: fixed; z-index: 2147483000; pointer-events: none; overflow: hidden; }
    canvas { display: block; width: 100%; height: 100%; }
  `;
  const WAVE_CELL_PX = 4;
  const WAVE_DURATION_MS = 1300;
  const WAVE_LEVELS = 5;
  const WAVE_TONES = {
    danger: { rgb: [242, 90, 90], alpha: 0.75 },
    light: { rgb: [255, 255, 255], alpha: 0.6 },
    // White would vanish on DeepSeek's light theme, so it turns into a soft grey there.
    lightOnLight: { rgb: [96, 102, 118], alpha: 0.42 },
  };
  const BAYER_4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

  function cellNoise(column, row) {
    let value = Math.imul(column + 1, 374761393) ^ Math.imul(row + 1, 668265263);
    value = Math.imul(value ^ (value >>> 13), 1274126177);
    return ((value ^ (value >>> 16)) >>> 0) / 4294967296;
  }

  function backgroundBrightness(node) {
    for (let current = node; current; current = current.parentElement) {
      const match = /rgba?\((\d+)[ ,]+(\d+)[ ,]+(\d+)(?:[ ,/]+([\d.]+%?))?\)/.exec(getComputedStyle(current).backgroundColor);
      if (match && (match[4] === undefined || parseFloat(match[4]) > 0.5)) {
        return (Number(match[1]) * 0.299 + Number(match[2]) * 0.587 + Number(match[3]) * 0.114) / 255;
      }
    }
    return 0;
  }

  // The rounded box that holds the textarea and the composer buttons.
  function findComposerBox(from) {
    let fallback = null;
    for (let node = from.parentElement, depth = 0; node && depth < 10; node = node.parentElement, depth += 1) {
      if (!node.querySelector('textarea') || node.getBoundingClientRect().width < 300) continue;
      fallback = fallback || node;
      if (parseFloat(getComputedStyle(node).borderTopLeftRadius) >= 12) return node;
    }
    return fallback;
  }

  function createWave() {
    const wave = attach('dsx-wave', WAVE_STYLES, '<canvas></canvas>');
    const canvas = wave.shadow.querySelector('canvas');
    const context = canvas.getContext('2d');
    let frame = null;

    function stop() {
      if (frame) cancelAnimationFrame(frame);
      frame = null;
      wave.host.remove();
    }

    function play(origin, kind) {
      stop();
      // This plays even when the system asks for reduced motion: Windows turns that on for all
      // animations at once, and the wave is a short, deliberate signal that the mode changed.
      const box = findComposerBox(origin);
      if (!box || !document.body) return;

      const rect = box.getBoundingClientRect();
      const width = Math.round(rect.width);
      const height = Math.round(rect.height);
      if (width < 40 || height < 20) return;
      const ratio = window.devicePixelRatio || 1;
      const columns = Math.ceil(width / WAVE_CELL_PX);
      const rows = Math.ceil(height / WAVE_CELL_PX);
      const light = kind === 'light' && backgroundBrightness(box) > 0.6;
      const tone = WAVE_TONES[light ? 'lightOnLight' : kind];
      const fills = Array.from({ length: WAVE_LEVELS }, (_, level) => `rgba(${tone.rgb.join(',')},${((level + 1) / WAVE_LEVELS * tone.alpha).toFixed(3)})`);

      Object.assign(wave.host.style, {
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${width}px`,
        height: `${height}px`,
        borderRadius: getComputedStyle(box).borderRadius,
      });
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      document.body.append(wave.host);

      // The wave spreads from the button that was clicked.
      const source = origin.getBoundingClientRect();
      const originX = Math.min(Math.max(source.left + source.width / 2 - rect.left, 0), width);
      const originY = Math.min(Math.max(source.top + source.height / 2 - rect.top, 0), height);
      const farthest = Math.max(
        Math.hypot(originX, originY),
        Math.hypot(width - originX, originY),
        Math.hypot(originX, height - originY),
        Math.hypot(width - originX, height - originY),
      );
      const travel = farthest + 110;
      const levels = new Uint8Array(columns * rows);
      const startedAt = performance.now();

      function draw(now) {
        const progress = Math.min((now - startedAt) / WAVE_DURATION_MS, 1);
        const front = travel * (1 - (1 - progress) ** 1.8);
        const envelope = Math.min(1, (1 - progress) * 1.7);
        levels.fill(0);

        for (let row = 0; row < rows; row += 1) {
          const y = row * WAVE_CELL_PX + WAVE_CELL_PX / 2;
          for (let column = 0; column < columns; column += 1) {
            const x = column * WAVE_CELL_PX + WAVE_CELL_PX / 2;
            // The ripple bends the front, so it is a wave rather than a perfect ring.
            const distance = Math.hypot(x - originX, y - originY) + Math.sin(x * 0.085 + y * 0.06 + progress * 9) * 5;
            const behind = front - distance;
            let strength = behind < 0 ? Math.max(0, 1 + behind / 14) : Math.exp(-behind / 42);
            strength += 0.35 * Math.max(0, 1 - Math.abs(behind - 64) / 9);
            // The border of the box catches the wave a little more, so its outline lights up.
            if (Math.min(x, width - x, y, height - y) < 7) strength += 0.3 * Math.exp(-Math.abs(behind) / 60);
            const threshold = (BAYER_4[(row & 3) * 4 + (column & 3)] / 16) * 0.7 + cellNoise(column, row) * 0.3;
            levels[row * columns + column] = Math.max(0, Math.min(WAVE_LEVELS, Math.floor(Math.min(strength * envelope, 1) * WAVE_LEVELS + threshold)));
          }
        }

        context.clearRect(0, 0, width, height);
        const size = WAVE_CELL_PX - 1;
        for (let level = 1; level <= WAVE_LEVELS; level += 1) {
          context.fillStyle = fills[level - 1];
          for (let index = 0; index < levels.length; index += 1) {
            if (levels[index] === level) context.fillRect((index % columns) * WAVE_CELL_PX, Math.floor(index / columns) * WAVE_CELL_PX, size, size);
          }
        }

        if (progress < 1) frame = requestAnimationFrame(draw);
        else stop();
      }

      frame = requestAnimationFrame(draw);
    }

    return { play };
  }

  // The composer's toggle group: the parent of a toggle button that shares a container with a textarea.
  function findComposerToggleGroup() {
    for (const toggle of document.querySelectorAll('.ds-toggle-button')) {
      let node = toggle.parentElement;
      for (let depth = 0; node && depth < 6; depth += 1) {
        if (node.querySelector('textarea')) return toggle.parentElement;
        node = node.parentElement;
      }
    }
    return null;
  }

  function createPageControls({ onPickFolder, onChangeMode, onDismissUpdate }) {
    const pill = attach(
      'dsx-status',
      PILL_STYLES,
      `<span class="update" hidden><a target="_blank" rel="noopener noreferrer">${iconMarkup('arrowUp')}<span></span></a><button type="button" aria-label="Dismiss" data-action="dismiss-update">×</button></span><div class="status"><i></i><span></span></div>`,
    );
    const updateBox = pill.shadow.querySelector('.update');
    const updateLink = updateBox.querySelector('a');
    const updateLabel = updateBox.querySelector('a span');
    const updateClose = updateBox.querySelector('button');
    const statusLabel = pill.shadow.querySelector('.status span');
    let updateTag = '';
    const folder = attach('dsx-composer-button', BUTTON_STYLES, `<button type="button" data-action="pick-folder">${iconMarkup('folder')}</button>`);
    const permission = attach('dsx-composer-button', BUTTON_STYLES, '<button type="button" data-action="cycle-permission"></button>');

    // DeepSeek spaces its toggles with their own margins, so the first button brings its own.
    folder.host.style.marginRight = '8px';

    const pillBox = pill.shadow.querySelector('.status');
    const folderButton = folder.shadow.querySelector('button');
    const permissionButton = permission.shadow.querySelector('button');
    const tooltip = createTooltip();
    const wave = createWave();
    let mode = 'ask';
    // What each tooltip says right now. The tooltips read it when they show, and update() fills it in.
    const tips = { pill: '', folder: '', permission: '', update: 'Open the new release on GitHub' };
    tooltip.bind(pillBox, () => tips.pill);
    tooltip.bind(updateLink, () => tips.update);
    tooltip.bind(folderButton, () => tips.folder);
    tooltip.bind(permissionButton, () => tips.permission);

    // Page scripts can only produce untrusted events.
    const trusted = (handler) => (event) => {
      if (event.isTrusted) handler();
    };
    folderButton.addEventListener('click', trusted(onPickFolder));
    updateClose.addEventListener('click', trusted(() => onDismissUpdate(updateTag)));
    permissionButton.addEventListener('click', trusted(() => {
      const next = mode === 'bypass' ? 'ask' : 'bypass';
      // The host sits in the page's own tree, so the wave can find the composer from it.
      wave.play(permission.host, next === 'bypass' ? 'danger' : 'light');
      onChangeMode(next);
    }));

    function update({ alive, settings, hostInfo, hostError, picking, pickError, update: newerRelease }) {
      mode = settings.mode;

      // The link returns for the next release after the user closes this one. While it is hidden
      // it holds no text, so nothing is left behind in the page.
      updateTag = newerRelease && newerRelease.tag !== settings.dismissedUpdate ? newerRelease.tag : '';
      updateBox.hidden = !updateTag;
      updateLabel.textContent = updateTag ? `Update available: ${updateTag}` : '';
      if (updateTag) updateLink.href = newerRelease.url;
      else updateLink.removeAttribute('href');

      const status = !alive ? 'Reload page' : hostInfo ? 'Connected' : 'Not connected';
      pill.shadow.querySelector('i').style.background = alive && hostInfo ? DOT_COLORS.ok : DOT_COLORS.warn;
      statusLabel.textContent = `Shell · ${status}`;
      tips.pill = alive && !hostInfo ? ['Run node host/install.js, then restart the browser.', hostError].filter(Boolean).join('\n') : '';

      const bypass = mode === 'bypass';
      permissionButton.className = bypass ? 'danger' : '';
      permissionButton.setAttribute('aria-label', `Permissions: ${bypass ? 'bypass' : 'manual'}`);
      tips.permission = bypass ? 'Commands run without asking' : 'Commands ask before running';
      permissionButton.innerHTML = `${iconMarkup(bypass ? 'bolt' : 'shield')}<span>${bypass ? 'Bypass' : 'Manual'}</span>`;

      folderButton.className = [settings.cwd ? 'selected' : '', picking ? 'busy' : ''].join(' ').trim();
      const location = settings.cwd || (hostInfo && hostInfo.home) || 'your home folder';
      folderButton.setAttribute('aria-label', `Working directory: ${location}`);
      tips.folder = pickError ? `Couldn't open the folder dialog: ${pickError}` : location;
      tooltip.refresh();
    }

    // React owns the group's children, so this only adds to it and never moves anything of React's.
    function mount() {
      if (document.body && !pill.host.isConnected) document.body.append(pill.host);
      if (document.body && !tooltip.host.isConnected) document.body.append(tooltip.host);
      const group = findComposerToggleGroup();
      if (!group) return;
      if (folder.host.parentElement !== group) group.prepend(folder.host);
      if (permission.host.parentElement !== group) group.append(permission.host);
    }

    return { update, mount };
  }

  root.DsxPageControls = { createPageControls };
})(globalThis);
