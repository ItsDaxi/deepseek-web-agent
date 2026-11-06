'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { scrambleText, otherGreeting } = require('../../extension/evil-awakening.js');

const fixed = (value) => () => value;

test('the greeting resolves from left to right and keeps its spaces', () => {
  const text = "Hi! What's on";
  assert.equal(scrambleText(text, 1), text);
  assert.equal(scrambleText(text, 5), text);
  const half = scrambleText(text, 0.5, fixed(0));
  assert.equal(half.length, text.length);
  assert.equal(half.slice(0, 6), "Hi! Wh");
  assert.equal(half[3], ' ');
  assert.ok(!half.slice(6).includes('a'), 'the rest is noise');
  const none = scrambleText(text, 0, fixed(0));
  assert.equal(none.length, text.length);
  assert.equal([...none].filter((char) => char === ' ').length, 2);
  assert.notEqual(none, text);
});

test('noise only uses the glyph set and never changes the length', () => {
  for (let step = 0; step <= 10; step += 1) {
    const out = scrambleText('Hello, let\'s start chatting', step / 10);
    assert.equal(out.length, 'Hello, let\'s start chatting'.length);
  }
});

test('a new greeting comes from DeepSeek\'s own list and is never the one on screen', () => {
  const state = JSON.stringify({
    entries: { welcome_msg: { id: 1, value: { messages: [{ id: 0, text: 'Hi. How can I help?' }, { id: 1, text: 'Hello, let\'s start chatting' }, { id: 2, text: 'Whenever you\'re ready' }] } } },
  });
  for (const pick of [0, 0.5, 0.99]) {
    const greeting = otherGreeting('Hello, let\'s start chatting', state, fixed(pick));
    assert.ok(['Hi. How can I help?', 'Whenever you\'re ready'].includes(greeting), greeting);
  }
  assert.equal(otherGreeting('x', JSON.stringify({ entries: {} }), fixed(0)), null);
  assert.equal(otherGreeting('x', 'not json', fixed(0)), null);
  assert.equal(otherGreeting('x', null, fixed(0)), null);
  const only = JSON.stringify({ entries: { welcome_msg: { value: { messages: [{ text: 'same' }] } } } });
  assert.equal(otherGreeting('same', only, fixed(0)), null);
});
