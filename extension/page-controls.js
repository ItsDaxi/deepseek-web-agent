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
    target: '<circle cx="12" cy="12" r="1"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="9"/>',
    plan: '<path d="M9 5h-2a2 2 0 0 0 -2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2 -2v-12a2 2 0 0 0 -2 -2h-2"/><path d="M9 3m0 2a2 2 0 0 1 2 -2h2a2 2 0 0 1 2 2v0a2 2 0 0 1 -2 2h-2a2 2 0 0 1 -2 -2z"/><path d="M9 12h6"/><path d="M9 16h6"/>',
    send: '<path d="M10 14l11 -11"/><path d="M21 3l-6.5 18a.55 .55 0 0 1 -1 0l-3.5 -7l-7 -3.5a.55 .55 0 0 1 0 -1l18 -6.5"/>',
    compact: '<path d="M12 3a9 9 0 1 0 9 9"/>',
    database: '<path d="M4 6a8 3 0 1 0 16 0a8 3 0 1 0 -16 0"/><path d="M4 6v6a8 3 0 0 0 16 0v-6"/><path d="M4 12v6a8 3 0 0 0 16 0v-6"/>',
    download: '<path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2 -2v-2"/><path d="M7 11l5 5l5 -5"/><path d="M12 4v12"/>',
    help: '<circle cx="12" cy="12" r="9"/><path d="M12 17v.01"/><path d="M12 13.5a1.5 1.5 0 0 1 1 -1.5a2.6 2.6 0 1 0 -3 -4"/>',
    paperclip: '<path d="M15 7l-6.5 6.5a1.5 1.5 0 0 0 3 3l6.5 -6.5a3 3 0 0 0 -6 -6l-6.5 6.5a4.5 4.5 0 0 0 9 9l6.5 -6.5"/>',
    chevronDown: '<path d="M6 9l6 6l6 -6"/>',
    chevronRight: '<path d="M9 6l6 6l-6 6"/>',
    chevronLeft: '<path d="M15 6l-6 6l6 6"/>',
    check: '<path d="M5 12l5 5l10 -10"/>',
    plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 8h.01"/><path d="M11 12h1v4h1"/>',
    flame: '<path d="M12 12c2 -2.96 0 -7 -1 -8c0 3.038 -1.773 4.741 -3 6c-1.226 1.26 -2 3.24 -2 5a6 6 0 1 0 12 0c0 -1.532 -1.056 -3.94 -2 -5c-1.786 3 -2.791 3 -4 2z"/>',
  };

  // The buttons of the composer row are quiet: no border until the mouse is over them, like the
  // rest of the row. The round one (attach) has a soft fill, and the red one marks Full access.
  const BUTTON_STYLES = `
    :host { display: inline-flex; }
    button {
      box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; gap: 6px;
      height: 34px; padding: 0 10px; border-radius: 18px; cursor: pointer; user-select: none; outline: none; position: relative;
      font: inherit; font-size: 13px; font-weight: 500; white-space: nowrap;
      color: var(--dsw-alias-label-primary, #f9fafb); background: none;
      border: 1px solid transparent;
      transition: border .2s ease, background .2s ease;
    }
    button:hover, button[aria-expanded="true"] { background-color: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.08)); }
    button:focus-visible { box-shadow: 0 0 0 2px var(--dsw-alias-brand-primary, #5686fe); }
    button.round { width: 34px; padding: 0; border-radius: 50%; background-color: color-mix(in srgb, var(--dsw-alias-label-primary, #f9fafb) 10%, transparent); }
    button.round:hover { background-color: color-mix(in srgb, var(--dsw-alias-label-primary, #f9fafb) 18%, transparent); }
    button.workspace { height: 30px; padding: 0 8px; border-radius: 8px; font-weight: 600; }
    button.busy { opacity: .4; cursor: progress; }
    .muted { color: var(--dsw-alias-label-tertiary, #adb2b8); font-weight: 400; }
    svg { width: 14px; height: 14px; flex: none; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
    svg.chev { width: 12px; height: 12px; opacity: .7; }
    button.round svg { width: 17px; height: 17px; }
    @media (prefers-reduced-motion: reduce) { button { transition: none; } }
  `;

  // The Evil Mode button, next to "New chat" in the sidebar. It takes the height of the row, so it stays
  // round whatever size DeepSeek gives that button, and it copies the fill, the corners and the text
  // colour of "New chat" (mount() sets --dsx-bg, --dsx-radius and --dsx-color), so the two look like a
  // pair. On, it turns red.
  const EVIL_BUTTON_STYLES = `
    :host { display: flex; flex: none; align-self: stretch; aspect-ratio: 1 / 1; min-width: 34px; }
    button {
      box-sizing: border-box; width: 100%; height: 100%; display: inline-flex; align-items: center; justify-content: center; padding: 0;
      border-radius: var(--dsx-radius, 999px); cursor: pointer; user-select: none; outline: none; font: inherit; position: relative;
      color: var(--dsx-color, var(--dsw-alias-label-primary, #f9fafb)); border: 1px solid transparent;
      background: var(--dsx-bg, color-mix(in srgb, var(--dsw-alias-label-primary, #f9fafb) 10%, transparent));
      box-shadow: var(--dsx-shadow, none);
      transition: background .2s ease, border .2s ease, color .2s ease;
    }
    button:hover { background: color-mix(in srgb, var(--dsx-bg, var(--dsw-alias-bg-layer-3, #2b2c2f)) 90%, var(--dsw-alias-label-primary, #f9fafb) 10%); }
    button:focus-visible { box-shadow: 0 0 0 2px var(--dsw-alias-brand-primary, #5686fe); }
    button.on { color: var(--dsw-alias-state-error-primary, #f25a5a); border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary, #f25a5a) 55%, transparent); background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #f25a5a) 12%, transparent); }
    button.on:hover { background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #f25a5a) 20%, transparent); }
    button.busy { opacity: .4; cursor: progress; }
    svg { width: 18px; height: 18px; flex: none; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
    @media (prefers-reduced-motion: reduce) { button { transition: none; } }
  `;

  // The row of the "New chat" button, found from the logo above it instead of from DeepSeek's class
  // names: the logo's row is followed by the row that holds the button. Null when the sidebar is not
  // laid out like that, and then the Evil Mode button is simply not shown.
  function findNewChatRow() {
    const logo = document.querySelector('svg[viewBox="0 0 143 23"]');
    const header = logo && logo.parentElement && logo.parentElement.parentElement;
    const row = header && header.nextElementSibling;
    const button = row && row.firstElementChild;
    return button && button.querySelector('[tabindex]') ? row : null;
  }

  // DeepSeek draws the shortcut hint of "New chat" ("Ctrl J") with a ::after rule on the button, shown on
  // hover. Once the button gives room to the Evil Mode button the hint lands on top of the label, so the
  // button is marked here and page.css switches the hint off. The marked element is the pill itself,
  // the one with a tabindex, found from the row and not from DeepSeek's class names.
  function markNewChatButton(row) {
    const pill = row.firstElementChild && row.firstElementChild.querySelector('[tabindex]');
    if (pill && !pill.hasAttribute('data-dsx-newchat')) pill.setAttribute('data-dsx-newchat', '');
    return pill;
  }

  // The look of the "New chat" button: the first element inside it that is actually filled.
  function readNewChatLook(button) {
    for (const node of [button, ...button.querySelectorAll('*')]) {
      const style = getComputedStyle(node);
      if (/^rgba?\(\s*\d+[ ,]+\d+[ ,]+\d+\s*\)$/.test(style.backgroundColor) || /rgba?\(.*[ ,/]\s*0?\.[1-9]/.test(style.backgroundColor)) {
        return { bg: style.backgroundColor, radius: style.borderTopLeftRadius, color: style.color, shadow: style.boxShadow };
      }
    }
    return null;
  }

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

    return { host: tip.host, bind, refresh, hide };
  }

  // ---- Mode switch wave ------------------------------------------------------------------------
  // A short pixel wave across the composer when the permission mode changes: white, or red in Evil Mode,
  // where it also flickers: it is redrawn in steps, a frame now and then drops out, the edge shimmers
  // and the red changes in strength from frame to frame. Cells are
  // dithered with a Bayer matrix and a little fixed noise, so the front reads as a detailed pixel
  // pattern instead of a smooth gradient.

  const WAVE_STYLES = `
    :host { position: fixed; z-index: 2147482999; pointer-events: none; overflow: hidden; }
    canvas { display: block; width: 100%; height: 100%; }
  `;
  const WAVE_CELL_PX = 4;
  const WAVE_DURATION_MS = 1300;
  const WAVE_LEVELS = 5;
  const FLICKER_DURATION_MS = 1100;
  const FLICKER_FRAME_MS = 45;
  const FLICKER_DROP_CHANCE = 0.2;
  const WAVE_TONES = {
    light: { rgb: [255, 255, 255], alpha: 0.6 },
    // Evil Mode, whatever the preset.
    danger: { rgb: [242, 90, 90], alpha: 0.75 },
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

      const flicker = kind === 'danger';
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
      let lastDrawn = -FLICKER_FRAME_MS;

      function draw(now) {
        const progress = Math.min((now - startedAt) / (flicker ? FLICKER_DURATION_MS : WAVE_DURATION_MS), 1);
        if (progress >= 1) {
          stop();
          return;
        }
        let strengthFactor = 1;
        if (flicker) {
          // Redrawn about every 45 ms, and now and then a frame is left empty, so it flickers.
          if (now - lastDrawn < FLICKER_FRAME_MS) {
            frame = requestAnimationFrame(draw);
            return;
          }
          lastDrawn = now;
          if (progress > 0.04 && Math.random() < FLICKER_DROP_CHANCE) {
            context.clearRect(0, 0, width, height);
            frame = requestAnimationFrame(draw);
            return;
          }
          strengthFactor = 0.55 + Math.random() * 0.45;
        }
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
            // The edge of a flickering wave shimmers: every frame each cell is nudged by chance.
            const shimmer = flicker ? (Math.random() - 0.5) * 0.7 : 0;
            levels[row * columns + column] = Math.max(0, Math.min(WAVE_LEVELS, Math.floor(Math.min(Math.max(strength * envelope * strengthFactor + shimmer, 0), 1) * WAVE_LEVELS + threshold)));
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

        frame = requestAnimationFrame(draw);
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

  // The toggles DeepSeek draws itself: DeepThink and Search. The extension hides them and drives them
  // from its own controls, so the page keeps working exactly as if they had been clicked.
  function findNativeToggles(group) {
    const list = [...group.querySelectorAll('.ds-toggle-button')];
    const think = list.find((toggle) => /think/i.test(toggle.textContent || '')) || list[0] || null;
    const search = list.find((toggle) => toggle !== think && /search/i.test(toggle.textContent || '')) || list.find((toggle) => toggle !== think) || null;
    return { think, search };
  }

  // The last visible textarea, which is the composer.
  function findComposerArea() {
    const areas = [...document.querySelectorAll('textarea')].filter((area) => area.getClientRects().length > 0);
    return areas[areas.length - 1] || null;
  }

  const TOGGLE_CLICK_GAP_MS = 500;
  const TOGGLE_MAX_TRIES = 6;

  function chevron() {
    return iconMarkup('chevronDown').replace('<svg ', '<svg class="chev" ');
  }

  function createPageControls({ onPickFolder, onChangeMode, onSelectWorkspace, onSetThinking, onDismissUpdate, onToggleEvil }) {
    const { MODES, MODEL_NAME, DEFAULT_WORKSPACE, basename, modeLabel } = root.DsxMenus;
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

    // Above the composer: the workspace. Inside it: attach and the permission preset on the left, the
    // model on the right. The attach button opens DeepSeek's own file dialog.
    const workspace = attach('dsx-workspace', BUTTON_STYLES, `<button type="button" class="workspace" data-action="workspace-menu" aria-haspopup="menu" aria-expanded="false">${iconMarkup('folder')}<span class="label"></span>${chevron()}</button>`);
    const attachment = attach('dsx-composer-button', BUTTON_STYLES, `<button type="button" class="round" data-action="attach" aria-label="Attach file">${iconMarkup('paperclip')}</button>`);
    const permission = attach('dsx-composer-button', BUTTON_STYLES, '<button type="button" data-action="permission-menu" aria-haspopup="menu" aria-expanded="false"></button>');
    const model = attach('dsx-composer-button', BUTTON_STYLES, `<button type="button" data-action="model-menu" aria-haspopup="menu" aria-expanded="false"><span class="name"></span><span class="muted effort"></span>${chevron()}</button>`);

    // DeepSeek spaces its toggles with their own margins, so the first button brings its own.
    attachment.host.style.marginRight = '8px';
    model.host.style.marginRight = '8px';
    workspace.host.style.cssText = 'display: flex; align-self: flex-start; margin: 0 0 8px 4px;';

    const evil = attach('dsx-evil-button', EVIL_BUTTON_STYLES, `<button type="button" data-action="toggle-evil">${iconMarkup('flame')}</button>`);
    const evilButton = evil.shadow.querySelector('button');

    const pillBox = pill.shadow.querySelector('.status');
    const workspaceButton = workspace.shadow.querySelector('button');
    const workspaceLabel = workspace.shadow.querySelector('.label');
    const attachButton = attachment.shadow.querySelector('button');
    const permissionButton = permission.shadow.querySelector('button');
    const modelButton = model.shadow.querySelector('button');
    const modelName = model.shadow.querySelector('.name');
    const modelEffort = model.shadow.querySelector('.effort');
    const tooltip = createTooltip();
    const wave = createWave();
    let current = { mode: 'ask', cwd: '', workspaces: [], thinking: true };
    // Tokens the open chat has used, and the most it can hold (null while that is not known).
    let contextUsage = { used: 0, limit: null };
    // DeepSeek's own attach button and toggles, found in the last mount, and the clicks spent on
    // keeping the toggles in step.
    let nativeAttach = null;
    let nativeToggles = { think: null, search: null };
    const toggleSync = { lastClick: { think: 0, search: 0 }, tries: { think: 0, search: 0 } };
    // What each tooltip says right now. The tooltips read it when they show, and update() fills it in.
    const tips = { pill: '', workspace: '', permission: '', attach: 'Attach files', evil: '', update: 'Open the release page. Run the new setup and the extension updates itself.' };
    tooltip.bind(evilButton, () => tips.evil);
    tooltip.bind(pillBox, () => tips.pill);
    tooltip.bind(updateLink, () => tips.update);
    tooltip.bind(workspaceButton, () => tips.workspace);
    tooltip.bind(permissionButton, () => tips.permission);
    tooltip.bind(attachButton, () => tips.attach);

    // The host sits in the page's own tree, so the wave can find the composer from it.
    function playModeWave(next) {
      // White, and red (flickering) whatever the preset while Evil Mode is on.
      wave.play(permission.host, document.documentElement.hasAttribute('data-dsx-evil') ? 'danger' : 'light');
    }

    const menus = root.DsxMenus.createMenus({
      icon: iconMarkup,
      tooltip,
      getState: () => ({ ...current, context: contextUsage }),
      actions: {
        selectMode: (next) => {
          if (next === current.mode) return;
          playModeWave(next);
          onChangeMode(next);
        },
        selectWorkspace: (path) => onSelectWorkspace(path),
        addWorkspace: () => onPickFolder(),
        setThinking: (thinking) => onSetThinking(thinking),
      },
    });

    // Marks which button holds a menu open, for its look and for screen readers.
    const openers = { workspace: workspaceButton, permission: permissionButton, model: modelButton };
    function syncExpanded() {
      for (const [kind, button] of Object.entries(openers)) button.setAttribute('aria-expanded', String(menus.isOpen(kind)));
    }

    // Opens a menu on its button. A second click on the same button closes it. `onClose` is what
    // happens after: by default the focus goes back to the composer when something was picked.
    function openMenu(kind, host, onClose) {
      if (menus.isOpen(kind)) {
        menus.close('toggle');
        return;
      }
      menus.open(kind, {
        anchor: host,
        box: kind === 'permission' ? findComposerBox(host) : null,
        onClose: (reason) => {
          syncExpanded();
          if (onClose) onClose(reason);
          else if (reason === 'pick' || reason === 'escape') {
            const area = findComposerArea();
            if (area) area.focus();
          }
        },
      });
      syncExpanded();
    }

    // The file dialog belongs to DeepSeek: its own attach button, or the file input behind it.
    function openFileDialog() {
      if (nativeAttach && nativeAttach.isConnected) {
        nativeAttach.click();
        return;
      }
      const input = document.querySelector('input[type="file"]');
      if (input) input.click();
    }

    // Page scripts can only produce untrusted events.
    const trusted = (handler) => (event) => {
      if (event.isTrusted) handler();
    };
    evilButton.addEventListener('click', trusted(onToggleEvil));
    updateClose.addEventListener('click', trusted(() => onDismissUpdate(updateTag)));
    workspaceButton.addEventListener('click', trusted(() => openMenu('workspace', workspace.host)));
    permissionButton.addEventListener('click', trusted(() => openMenu('permission', permission.host)));
    modelButton.addEventListener('click', trusted(() => openMenu('model', model.host)));
    attachButton.addEventListener('click', trusted(openFileDialog));

    function update({ alive, settings, hostInfo, hostError, picking, pickError, update: newerRelease, evilBusy }) {
      const workspaces = Array.isArray(settings.workspaces) ? settings.workspaces : [];
      current = {
        mode: MODES.some((entry) => entry.id === settings.mode) ? settings.mode : 'ask',
        cwd: settings.cwd || '',
        workspaces,
        thinking: settings.thinking !== false,
      };

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

      permissionButton.setAttribute('aria-label', `Permissions: ${modeLabel(current.mode)}`);
      tips.permission = {
        ask: 'Reads run by themselves in the workspace. Everything else asks first',
        workspace: 'Reads and edits run by themselves in the workspace. Commands ask first',
        bypass: 'Commands run without asking',
      }[current.mode];
      permissionButton.innerHTML = `${iconMarkup('shield')}<span>${modeLabel(current.mode)}</span>${chevron()}`;

      const evilOn = Boolean(settings.evilOn);
      evilButton.className = [evilOn ? 'on' : '', evilBusy ? 'busy' : ''].join(' ').trim();
      evilButton.setAttribute('aria-pressed', String(evilOn));
      evilButton.setAttribute('aria-label', `Evil Mode: ${evilOn ? 'on' : 'off'}`);
      tips.evil = evilOn ? 'Evil Mode: on. Click to turn it off.' : 'Evil Mode: off. Click to turn it on.';

      workspaceButton.className = ['workspace', picking ? 'busy' : ''].join(' ').trim();
      workspaceLabel.textContent = current.cwd ? basename(current.cwd) : DEFAULT_WORKSPACE;
      const location = current.cwd || (hostInfo && hostInfo.home) || 'your home folder';
      workspaceButton.setAttribute('aria-label', `Workspace: ${location}`);
      tips.workspace = pickError ? `Couldn't open the folder dialog: ${pickError}` : location;

      modelName.textContent = MODEL_NAME;
      modelEffort.textContent = current.thinking ? 'On' : 'Off';
      modelButton.setAttribute('aria-label', `Model: ${MODEL_NAME}, effort ${current.thinking ? 'on' : 'off'}`);

      menus.refresh();
      syncToggles();
      tooltip.refresh();
    }

    // `used` and `limit` are tokens, as DeepSeek counts them. They are shown in the model panel.
    function setContext({ used, limit }) {
      const next = { used: Math.max(0, Number(used) || 0), limit: Number.isFinite(limit) && limit > 0 ? limit : null };
      if (next.used === contextUsage.used && next.limit === contextUsage.limit) return;
      contextUsage = next;
      menus.refresh();
    }

    // Clicks a native toggle until it matches what is wanted. A toggle that refuses is left alone
    // after a few tries, so a page that locks it can never turn this into a loop.
    function ensureToggle(key, toggle, wanted) {
      if (!toggle) return;
      if (toggle.classList.contains('ds-toggle-button--selected') === wanted) {
        toggleSync.tries[key] = 0;
        return;
      }
      const now = Date.now();
      if (now - toggleSync.lastClick[key] < TOGGLE_CLICK_GAP_MS || toggleSync.tries[key] >= TOGGLE_MAX_TRIES) return;
      toggleSync.lastClick[key] = now;
      toggleSync.tries[key] += 1;
      toggle.click();
      // Looks again once the page has had time to react, in case nothing else changes on it.
      setTimeout(syncToggles, TOGGLE_CLICK_GAP_MS + 50);
    }

    function syncToggles() {
      ensureToggle('think', nativeToggles.think, current.thinking);
      // Search is always on.
      ensureToggle('search', nativeToggles.search, true);
    }

    // React owns the group's children, so this only adds to it and never moves anything of React's.
    // What it hides, it hides with an attribute, which page.css turns into display: none.
    function mount() {
      if (document.body && !pill.host.isConnected) document.body.append(pill.host);
      if (document.body && !tooltip.host.isConnected) document.body.append(tooltip.host);
      // The sidebar row. data-dsx-row lets page.css turn it into a row of two, so "New chat" shrinks.
      const row = findNewChatRow();
      if (row) {
        if (!row.hasAttribute('data-dsx-row')) row.setAttribute('data-dsx-row', '');
        if (evil.host.parentElement !== row) row.append(evil.host);
        const pill = markNewChatButton(row);
        const look = pill && readNewChatLook(pill);
        if (look) {
          evil.host.style.setProperty('--dsx-bg', look.bg);
          evil.host.style.setProperty('--dsx-radius', look.radius);
          evil.host.style.setProperty('--dsx-color', look.color);
          evil.host.style.setProperty('--dsx-shadow', look.shadow);
        }
      }
      const group = findComposerToggleGroup();
      if (!group) return;
      if (attachment.host.parentElement !== group) group.prepend(attachment.host);
      if (permission.host.parentElement !== group) group.append(permission.host);

      nativeToggles = findNativeToggles(group);
      for (const toggle of [nativeToggles.think, nativeToggles.search]) {
        if (toggle && !toggle.hasAttribute('data-dsx-hidden')) toggle.setAttribute('data-dsx-hidden', '');
      }

      // The attach and send buttons sit in the next group of the same row. The model
      // goes before them, and DeepSeek's own attach button is hidden, because ours takes its place.
      const actions = group.nextElementSibling;
      if (actions) {
        if (model.host.parentElement !== actions) actions.prepend(model.host);
        const own = [...actions.children].filter((child) => child !== model.host);
        nativeAttach = own.length >= 2 ? own[0] : null;
        if (nativeAttach && !nativeAttach.hasAttribute('data-dsx-hidden')) nativeAttach.setAttribute('data-dsx-hidden', '');
      }

      // The workspace sits right above the composer's rounded box.
      const box = findComposerBox(group);
      if (box && box.parentElement && workspace.host.nextElementSibling !== box) box.parentElement.insertBefore(workspace.host, box);
      syncToggles();
    }

    // The permission and model menus can also be opened from the slash menu. `onClose` runs when
    // they close, and says why.
    function openPermission(onClose) {
      if (!permission.host.isConnected) return false;
      if (!menus.isOpen('permission')) openMenu('permission', permission.host, onClose);
      return true;
    }

    function openModel(onClose) {
      if (!model.host.isConnected) return false;
      if (!menus.isOpen('model')) openMenu('model', model.host, onClose);
      return true;
    }

    return { update, mount, playModeWave, setContext, openPermission, openModel, openFileDialog, icon: iconMarkup };
  }

  root.DsxPageControls = { createPageControls, findComposerBox };
})(globalThis);
