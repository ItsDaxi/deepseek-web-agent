'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createEvilAwakening, drawGlitch, coverageAt } = require('../../extension/evil-awakening.js');

// A canvas context that only records what is drawn.
function fakeContext() {
  const calls = { rects: [], clears: 0 };
  return {
    calls,
    clearRect: () => { calls.clears += 1; },
    fillRect: (x, y, w, h) => calls.rects.push({ x, y, w, h, fill: undefined }),
    createLinearGradient: () => ({ addColorStop() {} }),
    fillStyle: '',
  };
}

// The glitch is random, and about one frame in eighty has fewer than 300 shapes, so a test that counts
// them uses a generator of its own, which always gives the same frame.
function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('the glitch covers the screen at first, more and more, then nothing at the end', () => {
  assert.ok(coverageAt(0) > 0 && coverageAt(0) < 1);
  assert.ok(coverageAt(150) > coverageAt(0));
  assert.equal(coverageAt(450), 1);
  assert.ok(coverageAt(800) < 1 && coverageAt(800) > 0);
  assert.equal(coverageAt(1000), 0);
  assert.equal(coverageAt(5000), 0);
});

test('a full frame is detailed and spans the whole height and width', () => {
  const context = fakeContext();
  drawGlitch(context, 1280, 720, 1, seeded(1));
  assert.ok(context.calls.rects.length > 300, `only ${context.calls.rects.length} shapes`);
  const bottom = Math.max(...context.calls.rects.map((rect) => rect.y + rect.h));
  assert.ok(bottom >= 720, 'the bands reach the bottom of the screen');
  assert.equal(Math.min(...context.calls.rects.map((rect) => rect.x)), 0);
});

test('with no coverage nothing but the thin lines is left to draw', () => {
  const context = fakeContext();
  drawGlitch(context, 1280, 720, 0);
  assert.equal(context.calls.rects.length, 0);
});

test('without a page to draw on the look is switched on at once', () => {
  let activations = 0;
  const awakening = createEvilAwakening({ onActivate: () => { activations += 1; } });
  awakening.play();
  assert.equal(activations, 1);
  assert.equal(awakening.isPlaying(), false);
});

test('with a page the look is switched on once, under the glitch, and the overlay is removed', async () => {
  const noop = () => {};
  const element = () => ({
    className: '',
    style: {},
    append: noop,
    animate: noop,
    getContext: fakeContext,
    remove() { this.removed = true; },
    attachShadow() { return { append: noop }; },
  });
  const body = element();
  const hosts = [];
  body.append = (node) => hosts.push(node);
  globalThis.document = { body, createElement: element, querySelector: () => null };
  try {
    let activations = 0;
    const awakening = createEvilAwakening({ onActivate: () => { activations += 1; } });
    awakening.play();
    awakening.play();
    assert.equal(awakening.isPlaying(), true);
    assert.equal(activations, 0, 'the theme is not switched before the screen is covered');
    await new Promise((resolve) => setTimeout(resolve, 1300));
    assert.equal(activations, 1);
    assert.equal(awakening.isPlaying(), false);
    assert.equal(hosts.length, 1);
    assert.equal(hosts[0].removed, true);
  } finally {
    delete globalThis.document;
  }
});
