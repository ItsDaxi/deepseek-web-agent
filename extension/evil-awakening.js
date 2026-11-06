// "Evil Awakening": the animation played when /evil is turned on. It runs in the isolated world and
// only draws: an overlay in a closed shadow root, an SVG filter and a few Web Animations on the page's
// own elements, and the greeting text. Nothing it does outlasts the animation except the final state,
// which is the data-dsx-evil attribute that onActivate sets (the red theme and logos, in evil.css and
// logos.css).
//
//   0-400 ms      glitch: the page itself tears into horizontal slices and splits into red, green and
//                 blue; static, torn bars and two power flickers; the logos split and the page shakes
//   400-1000 ms   corruption: a red scan line falls from the top and what it has passed turns red,
//                 with short tears behind it and a red vignette closing in
//   1000-1500 ms  activation: the red theme is switched on with a flash and a hard tear, the greeting
//                 scrambles into a new one with a colour split, the red logos land with an impact and
//                 the composer glows
//   1500-1800 ms  stabilisation: the vignette and the glow fade and the clean red page is left
(function (root) {
  'use strict';

  const GLITCH_END_MS = 400;
  const SCAN_END_MS = 1000;
  const ACTIVATE_END_MS = 1500;
  const TOTAL_MS = 1800;
  // A frame that never comes (a background tab) must not leave the page half changed.
  const WATCHDOG_MS = TOTAL_MS + 1500;

  // The same elements logos.css replaces. The class names are DeepSeek's own, so the viewBox is the fallback.
  const WORDMARK_SELECTORS = [
    '#root > div.cb86951c > div.c3ecdb44 > div.dc04ec1d > div > div._262baab > div.e066abb8 > svg',
    'svg[viewBox="0 0 143 23"]',
  ];
  const WHALE_SELECTORS = [
    '#root > div.cb86951c > div.c3ecdb44 > div._7780f2e > div > div > div._9a2f8e4 > div._5758a85 > div > svg',
    'svg[viewBox="0 0 35 26"]',
  ];
  // DeepSeek's own greetings, saved by the page with its model settings.
  const MODEL_STORE_KEY = '__ds_remote_feature_store_model';
  const SCRAMBLE_GLYPHS = '!<>-_\\/[]{}=+*^?#%&01';
  const SCRAMBLE_STEP_MS = 40;
  const TEAR_STEP_MS = 55;
  const BAR_STEP_GLITCH_MS = 50;
  const BAR_STEP_SCAN_MS = 90;
  const BAND_HEIGHT_PX = 150;
  // Blue is about 230 degrees on the colour wheel, so a quarter turn and a bit more lands on red.
  const HUE_TURN_DEG = 130;
  const FILTER_ID = 'dsx-awakening-tear';

  const HOST_STYLES = `
    :host { position: fixed; inset: 0; z-index: 2147483000; pointer-events: none; overflow: hidden; }
    canvas { position: absolute; inset: 0; width: 100%; height: 100%; }
    .hue { position: absolute; left: 0; right: 0; top: 0; height: 0; backdrop-filter: hue-rotate(${HUE_TURN_DEG}deg) saturate(1.35); }
    .band {
      position: absolute; left: 0; right: 0; top: 0; height: ${BAND_HEIGHT_PX}px; transform: translateY(-${BAND_HEIGHT_PX}px); will-change: transform;
      background: linear-gradient(to bottom, rgba(255,0,25,0) 0%, rgba(255,0,25,.16) 55%, rgba(255,40,55,.55) 94%, rgba(255,150,160,.95) 98%, rgba(255,0,25,0) 100%);
    }
    .vignette { position: absolute; inset: 0; opacity: 0; background: radial-gradient(ellipse at 50% 48%, rgba(0,0,0,0) 38%, rgba(120,0,14,.45) 72%, rgba(200,0,22,.8) 100%); }
    .flash { position: absolute; inset: 0; opacity: 0; background: radial-gradient(circle at 50% 42%, rgba(255,60,70,.75), rgba(255,0,25,.2) 55%, rgba(255,0,25,0) 80%); }
    .blackout { position: absolute; inset: 0; opacity: 0; background: #05000a; }
  `;

  // The text of the greeting while it resolves: letters before the cut are final, the others are noise.
  // Spaces stay, so the line keeps its shape. `random` is injected so this can be tested.
  function scrambleText(target, progress, random = Math.random) {
    const text = String(target);
    const settled = Math.floor(Math.max(0, Math.min(progress, 1)) * text.length);
    let out = '';
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      out += index < settled || /\s/.test(char) ? char : SCRAMBLE_GLYPHS[Math.floor(random() * SCRAMBLE_GLYPHS.length)];
    }
    return out;
  }

  // A greeting that is not the one on screen, from the ones DeepSeek itself uses. Null when none is known.
  function otherGreeting(current, storedState, random = Math.random) {
    let state = null;
    try {
      state = JSON.parse(storedState);
    } catch {
      return null;
    }
    const entry = state && state.entries && state.entries.welcome_msg;
    const messages = entry && entry.value && entry.value.messages;
    if (!Array.isArray(messages)) return null;
    const options = messages.map((message) => message && message.text).filter((text) => typeof text === 'string' && text.trim() && text !== current);
    return options.length ? options[Math.floor(random() * options.length)] : null;
  }

  function findFirst(selectors) {
    for (const selector of selectors) {
      const node = document.querySelector(selector);
      if (node) return node;
    }
    return null;
  }

  // The hidden SVG that holds the filter tearing the page: horizontal noise moves rows of the page
  // sideways, and the red, green and blue are pulled apart.
  function createTearFilter() {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('width', '0');
    svg.setAttribute('height', '0');
    svg.setAttribute('aria-hidden', 'true');
    svg.style.cssText = 'position:absolute;width:0;height:0;pointer-events:none';
    svg.innerHTML = `
      <filter id="${FILTER_ID}" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">
        <feTurbulence type="fractalNoise" baseFrequency="0.0008 0.28" numOctaves="1" seed="3" result="noise"/>
        <feDisplacementMap in="SourceGraphic" in2="noise" scale="0" xChannelSelector="R" yChannelSelector="G" result="torn"/>
        <feColorMatrix in="torn" type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" result="r"/>
        <feColorMatrix in="torn" type="matrix" values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0" result="g"/>
        <feColorMatrix in="torn" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0" result="b"/>
        <feOffset in="r" dx="0" dy="0" result="ro"/>
        <feOffset in="b" dx="0" dy="0" result="bo"/>
        <feBlend in="ro" in2="g" mode="screen" result="rg"/>
        <feBlend in="rg" in2="bo" mode="screen"/>
      </filter>`;
    return {
      svg,
      turbulence: svg.querySelector('feTurbulence'),
      displace: svg.querySelector('feDisplacementMap'),
      red: svg.querySelector('feOffset[result="ro"]'),
      blue: svg.querySelector('feOffset[result="bo"]'),
    };
  }

  function createEvilAwakening({ onActivate }) {
    let playing = false;

    function play() {
      if (playing) return;
      if (!document.body) {
        onActivate();
        return;
      }
      playing = true;

      const host = document.createElement('dsx-awakening');
      const shadow = host.attachShadow({ mode: 'closed' });
      const style = document.createElement('style');
      style.textContent = HOST_STYLES;
      const noise = document.createElement('canvas');
      const hue = document.createElement('div');
      hue.className = 'hue';
      const band = document.createElement('div');
      band.className = 'band';
      const vignette = document.createElement('div');
      vignette.className = 'vignette';
      const flash = document.createElement('div');
      flash.className = 'flash';
      const blackout = document.createElement('div');
      blackout.className = 'blackout';
      shadow.append(style, noise, hue, band, vignette, flash, blackout);
      document.body.append(host);

      const tear = createTearFilter();
      document.body.append(tear.svg);

      const width = Math.max(window.innerWidth, 1);
      const height = Math.max(window.innerHeight, 1);
      noise.width = width;
      noise.height = height;
      const noiseContext = noise.getContext('2d');

      const page = document.getElementById('root') || document.body;
      const originalFilter = page.style.filter;
      const wordmark = findFirst(WORDMARK_SELECTORS);
      const whale = findFirst(WHALE_SELECTORS);
      const logos = [wordmark, whale].filter(Boolean);
      const startedAt = performance.now();
      let frame = null;
      let activated = false;
      let finished = false;
      let lastBars = -Infinity;
      let lastTear = -Infinity;
      let lastScramble = -Infinity;
      let greeting = null;

      // The page is torn only while a burst lasts: the filter is on the page for those frames alone.
      function tearPage(scale, split) {
        if (scale <= 0) {
          page.style.filter = originalFilter;
          return;
        }
        tear.turbulence.setAttribute('seed', String(Math.floor(Math.random() * 1000)));
        tear.displace.setAttribute('scale', scale.toFixed(1));
        tear.red.setAttribute('dx', String(-split));
        tear.blue.setAttribute('dx', String(split));
        page.style.filter = `url(#${FILTER_ID})`;
      }

      // ---- 0-400 ms: glitch -------------------------------------------------------------------
      const jitter = [[-4, 1], [5, -1], [-3, 0], [4, 1], [-5, -1], [3, 0], [-2, 1], [2, -1], [-1, 0], [0, 0]];
      page.animate(
        jitter.map(([x, y]) => ({ transform: `translate(${x}px, ${y}px)` })),
        { duration: GLITCH_END_MS, easing: 'steps(10, jump-none)' },
      );
      // Two quick power flickers: the picture drops for a moment and comes back.
      blackout.animate(
        [{ opacity: 0 }, { opacity: 0.42, offset: 0.16 }, { opacity: 0, offset: 0.2 }, { opacity: 0, offset: 0.55 }, { opacity: 0.3, offset: 0.6 }, { opacity: 0, offset: 0.66 }, { opacity: 0 }],
        { duration: GLITCH_END_MS },
      );
      // The logos split into a red and a blue ghost, which pull apart and come back together.
      const split = (distance) => `drop-shadow(${-distance}px 0 0 rgba(255,0,40,.9)) drop-shadow(${distance}px 0 0 rgba(0,190,255,.9))`;
      for (const logo of logos) {
        logo.animate(
          [0, 5, 2, 8, 1, 6, 3, 9, 0].map((distance) => ({ filter: split(distance) })),
          { duration: GLITCH_END_MS, easing: 'steps(8, jump-none)' },
        );
      }
      // The red vignette closes in over the whole build-up, peaks at the activation and fades out.
      vignette.animate(
        [{ opacity: 0 }, { opacity: 0.5, offset: SCAN_END_MS / TOTAL_MS * 0.7 }, { opacity: 0.95, offset: SCAN_END_MS / TOTAL_MS }, { opacity: 0.6, offset: ACTIVATE_END_MS / TOTAL_MS }, { opacity: 0 }],
        { duration: TOTAL_MS, easing: 'ease-in-out' },
      );

      function drawStatic(strong) {
        noiseContext.clearRect(0, 0, width, height);
        const grains = strong ? 240 : 0;
        for (let index = 0; index < grains; index += 1) {
          const shade = Math.random();
          noiseContext.fillStyle = shade < 0.5 ? `rgba(255,255,255,${0.08 + Math.random() * 0.2})` : `rgba(255,30,50,${0.12 + Math.random() * 0.25})`;
          noiseContext.fillRect(Math.random() * width, Math.random() * height, 2 + Math.random() * 5, 1 + Math.random() * 2);
        }
      }

      function drawBars(count, strong) {
        drawStatic(strong);
        for (let index = 0; index < count; index += 1) {
          const y = Math.random() * height;
          const barHeight = 2 + Math.random() * (strong ? 18 : 8);
          const red = Math.random() < (strong ? 0.5 : 1);
          noiseContext.fillStyle = red ? `rgba(255,0,40,${0.2 + Math.random() * 0.25})` : `rgba(0,190,255,${0.15 + Math.random() * 0.2})`;
          noiseContext.fillRect(0, y, width, barHeight);
          // A shorter, brighter piece offset from the rest, like a torn line.
          const length = width * (0.15 + Math.random() * 0.4);
          const x = Math.random() * (width - length);
          noiseContext.fillStyle = red ? 'rgba(255,60,70,.55)' : 'rgba(120,220,255,.45)';
          noiseContext.fillRect(x, y + (Math.random() - 0.5) * 6, length, barHeight);
        }
      }

      // ---- 1000-1500 ms: activation -----------------------------------------------------------
      function activate() {
        if (activated) return;
        activated = true;
        // The red theme and the red logos replace the turned blue ones in the same moment, so the
        // hue layer goes first: on top of red it would turn the page green.
        hue.style.height = '0px';
        band.style.display = 'none';
        onActivate();
        tearPage(110, 12);
        lastTear = performance.now();
        flash.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 360, easing: 'ease-out', fill: 'forwards' });
        // The red logos land: they start large and faint, overshoot a little and settle.
        for (const logo of logos) {
          logo.animate(
            [
              { scale: 2.1, opacity: 0, filter: 'brightness(2.6)' },
              { scale: 0.92, opacity: 1, filter: 'brightness(1.6) drop-shadow(0 0 10px rgba(255,0,25,.9))', offset: 0.55 },
              { scale: 1, opacity: 1, filter: 'brightness(1)' },
            ],
            { duration: ACTIVATE_END_MS - SCAN_END_MS, easing: 'cubic-bezier(.2,.8,.3,1)' },
          );
        }
        // The composer wakes up with a red glow that goes out again.
        const area = document.querySelector('textarea');
        const box = area && root.DsxPageControls && root.DsxPageControls.findComposerBox(area);
        if (box) {
          box.animate(
            [
              { boxShadow: '0 0 0 0 rgba(255,0,25,0)' },
              { boxShadow: '0 0 38px 6px rgba(255,0,25,.6)', offset: 0.3 },
              { boxShadow: '0 0 0 0 rgba(255,0,25,0)' },
            ],
            { duration: TOTAL_MS - SCAN_END_MS, easing: 'ease-out' },
          );
        }
        const title = whale && whale.nextElementSibling;
        const node = title && [...title.childNodes].find((child) => child.nodeType === 3 && child.data.trim());
        if (node) {
          let stored = null;
          try {
            stored = localStorage.getItem(MODEL_STORE_KEY);
          } catch {
            stored = null;
          }
          greeting = { node, target: otherGreeting(node.data, stored) || node.data };
          // While it resolves the text is split into a red and a blue ghost, which close up.
          title.animate(
            [6, 2, 7, 1, 4, 0].map((distance) => ({ textShadow: `${-distance}px 0 rgba(255,0,40,.9), ${distance}px 0 rgba(0,190,255,.85)` })),
            { duration: ACTIVATE_END_MS - SCAN_END_MS, easing: 'steps(6, jump-none)' },
          );
        }
      }

      function finish() {
        if (finished) return;
        finished = true;
        if (frame !== null) cancelAnimationFrame(frame);
        clearTimeout(watchdog);
        if (!activated) {
          activated = true;
          onActivate();
        }
        // Whatever the last frame was, the greeting ends as its final text and the page as it was.
        if (greeting) greeting.node.data = greeting.target;
        page.style.filter = originalFilter;
        tear.svg.remove();
        host.remove();
        playing = false;
      }

      const watchdog = setTimeout(finish, WATCHDOG_MS);

      function tick(now) {
        const elapsed = now - startedAt;
        if (elapsed >= TOTAL_MS) {
          finish();
          return;
        }

        if (elapsed < GLITCH_END_MS) {
          if (now - lastBars >= BAR_STEP_GLITCH_MS) {
            lastBars = now;
            drawBars(4 + Math.floor(Math.random() * 4), true);
          }
          // Bursts of tearing, with short calm between them.
          if (now - lastTear >= TEAR_STEP_MS) {
            lastTear = now;
            tearPage(Math.random() < 0.7 ? 25 + Math.random() * 55 : 0, 3 + Math.random() * 7);
          }
        } else if (elapsed < SCAN_END_MS) {
          // ---- 400-1000 ms: corruption ---------------------------------------------------------
          const progress = (elapsed - GLITCH_END_MS) / (SCAN_END_MS - GLITCH_END_MS);
          const edge = progress * (height + BAND_HEIGHT_PX);
          band.style.transform = `translateY(${(edge - BAND_HEIGHT_PX).toFixed(1)}px)`;
          // Everything above the leading edge of the line has been turned.
          hue.style.height = `${Math.min(Math.max(edge - 6, 0), height).toFixed(1)}px`;
          if (now - lastBars >= BAR_STEP_SCAN_MS) {
            lastBars = now;
            drawBars(1 + Math.floor(Math.random() * 2), false);
          }
          // Short tears now and then behind the line.
          if (now - lastTear >= 170) {
            lastTear = now;
            tearPage(Math.random() < 0.45 ? 14 + Math.random() * 26 : 0, 2 + Math.random() * 4);
          }
        } else if (elapsed < ACTIVATE_END_MS) {
          if (!activated) {
            activate();
            noiseContext.clearRect(0, 0, width, height);
          }
          // The hard tear of the activation settles within a few frames.
          if (now - lastTear >= 80) {
            lastTear = now;
            tearPage(0, 0);
          }
          if (greeting && now - lastScramble >= SCRAMBLE_STEP_MS) {
            lastScramble = now;
            const progress = (elapsed - SCAN_END_MS) / (ACTIVATE_END_MS - SCAN_END_MS);
            greeting.node.data = scrambleText(greeting.target, progress);
          }
        } else {
          // ---- 1500-2200 ms: stabilisation ----------------------------------------------------
          if (!activated) activate();
          if (greeting) greeting.node.data = greeting.target;
          page.style.filter = originalFilter;
        }
        frame = requestAnimationFrame(tick);
      }

      frame = requestAnimationFrame(tick);
    }

    return { play, isPlaying: () => playing };
  }

  const api = { createEvilAwakening, scrambleText, otherGreeting };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DsxEvilAwakening = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
