// "Evil Awakening": the short transition played when /evil is turned on. It only draws: a canvas in a
// closed shadow root and a Web Animation on the page's own logos. Nothing it does outlasts the
// animation except the final state, which is the data-dsx-evil attribute that onActivate sets (the red
// theme and logos, in evil.css and logos.css).
//
// The canvas is a full-screen data glitch: horizontal bands of pixel blocks in purple, magenta, blue and
// black, smooth colour streaks and bright hairlines, redrawn about every 45 ms so that it flickers.
//
//   0-300 ms     the glitch flickers in and covers more and more of the screen
//   300-600 ms   it covers everything; the red theme is switched on under it at 450 ms
//   600-1000 ms  it breaks up block by block and leaves the red page, and the red logos fade in
(function (root) {
  'use strict';

  const RAMP_MS = 300;
  const FULL_MS = 600;
  const ACTIVATE_MS = 450;
  const TOTAL_MS = 1000;
  const FRAME_MS = 45;
  // A timer that never fires on time (a background tab) must not leave the page half changed.
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

  // Black is listed twice so that it makes up a good part of the picture.
  const PALETTE = [
    '#000000', '#000000', '#12063a', '#2a0f9e', '#4b24e8', '#6a2cf2', '#8a3cf0', '#b04cf2',
    '#d65cf4', '#ff4fd8', '#ff2f9a', '#e0124a', '#6fa6ff', '#9bc4ff', '#c8b8ff', '#f1e8ff',
  ];
  const BLOCK_WIDTHS = [6, 12, 20, 32, 48, 80, 130];

  const HOST_STYLES = `
    :host { position: fixed; inset: 0; z-index: 2147483000; pointer-events: none; overflow: hidden; }
    canvas { position: absolute; inset: 0; width: 100%; height: 100%; }
  `;

  // How much of the screen the glitch covers, from 0 to 1, after `elapsed` ms.
  function coverageAt(elapsed) {
    if (elapsed <= 0) return 0.4;
    if (elapsed < RAMP_MS) return 0.4 + 0.6 * (elapsed / RAMP_MS);
    if (elapsed < FULL_MS) return 1;
    return Math.max(0, 1 - (elapsed - FULL_MS) / (TOTAL_MS - FULL_MS));
  }

  // One frame of the glitch. `random` is injected so this can be tested.
  function drawGlitch(context, width, height, coverage, random = Math.random) {
    const pick = (list) => list[Math.floor(random() * list.length)];
    const between = (low, high) => low + random() * (high - low);
    context.clearRect(0, 0, width, height);
    let y = 0;
    while (y < height) {
      const kind = random();
      const bandHeight = kind < 0.35 ? between(3, 12) : kind < 0.85 ? between(14, 46) : between(50, 130);
      const mode = random();
      if (mode < 0.58) {
        // Pixel blocks: the cells of a band are as high as the band and of uneven width.
        const cell = pick(BLOCK_WIDTHS);
        let x = 0;
        while (x < width) {
          const cellWidth = cell * between(0.5, 2);
          if (random() <= coverage) {
            context.fillStyle = pick(PALETTE);
            context.fillRect(x, y, cellWidth + 1, bandHeight + 1);
          }
          x += cellWidth;
        }
      } else if (mode < 0.8) {
        // A smooth streak, often with a hard step in the middle where the colours change.
        if (random() <= coverage) {
          const cut = random() < 0.5 ? between(0.2, 0.8) * width : width;
          for (const [from, to] of [[0, cut], [cut, width]]) {
            if (to - from < 1) continue;
            const gradient = context.createLinearGradient(from, 0, to, 0);
            gradient.addColorStop(0, pick(PALETTE));
            gradient.addColorStop(between(0.3, 0.7), pick(PALETTE));
            gradient.addColorStop(1, pick(PALETTE));
            context.fillStyle = gradient;
            context.fillRect(from, y, to - from + 1, bandHeight + 1);
          }
        }
      } else if (random() <= coverage) {
        // A black band with a few coloured bits left in it.
        context.fillStyle = '#000000';
        context.fillRect(0, y, width, bandHeight + 1);
        const bits = Math.floor(between(2, 9));
        for (let bit = 0; bit < bits; bit += 1) {
          context.fillStyle = pick(PALETTE);
          context.fillRect(random() * width, y + random() * bandHeight * 0.6, between(10, 120), Math.max(2, bandHeight * between(0.2, 0.6)));
        }
      }
      y += bandHeight;
    }
    // Thin bright lines across the whole width.
    const lines = Math.floor(between(2, 6));
    for (let line = 0; line < lines; line += 1) {
      if (random() > coverage) continue;
      context.fillStyle = random() < 0.5 ? '#ffffff' : pick(PALETTE.slice(8));
      context.fillRect(0, random() * height, width, between(1, 3));
    }
  }

  function findFirst(selectors) {
    for (const selector of selectors) {
      const node = document.querySelector(selector);
      if (node) return node;
    }
    return null;
  }

  function createEvilAwakening({ onActivate }) {
    let playing = false;

    function play() {
      if (playing) return;
      if (typeof document === 'undefined' || !document.body || typeof document.body.animate !== 'function') {
        onActivate();
        return;
      }
      playing = true;

      const host = document.createElement('dsx-awakening');
      const shadow = host.attachShadow({ mode: 'closed' });
      const style = document.createElement('style');
      style.textContent = HOST_STYLES;
      const canvas = document.createElement('canvas');
      shadow.append(style, canvas);
      document.body.append(host);

      const width = Math.max(globalThis.innerWidth || 1280, 1);
      const height = Math.max(globalThis.innerHeight || 720, 1);
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      const startedAt = performance.now();

      let activated = false;
      let finished = false;

      function activate() {
        if (activated) return;
        activated = true;
        onActivate();
        const logos = [findFirst(WORDMARK_SELECTORS), findFirst(WHALE_SELECTORS)].filter(Boolean);
        for (const logo of logos) {
          logo.animate([{ opacity: 0 }, { opacity: 1 }], { duration: TOTAL_MS - ACTIVATE_MS, easing: 'ease-out' });
        }
      }

      function finish() {
        if (finished) return;
        finished = true;
        clearInterval(drawTimer);
        clearTimeout(activateTimer);
        clearTimeout(finishTimer);
        clearTimeout(watchdog);
        activate();
        host.remove();
        playing = false;
      }

      function frame() {
        const elapsed = performance.now() - startedAt;
        const coverage = coverageAt(elapsed);
        // While it flickers in and out, now and then a frame is left empty.
        if (coverage < 1 && Math.random() < 0.15) {
          context.clearRect(0, 0, width, height);
          return;
        }
        drawGlitch(context, width, height, coverage);
      }

      frame();
      const drawTimer = setInterval(frame, FRAME_MS);
      const activateTimer = setTimeout(activate, ACTIVATE_MS);
      const finishTimer = setTimeout(finish, TOTAL_MS);
      const watchdog = setTimeout(finish, WATCHDOG_MS);
    }

    return { play, isPlaying: () => playing };
  }

  const api = { createEvilAwakening, drawGlitch, coverageAt };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DsxEvilAwakening = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
