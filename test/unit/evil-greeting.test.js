'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { GREETINGS, pickGreeting, findGreetingNode, createEvilGreeting } = require('../../extension/evil-greeting.js');

test('there are the five greetings', () => {
  assert.equal(GREETINGS.length, 5);
  assert.ok(GREETINGS.includes("I'm unchained. Put me to the test."));
});

test('a greeting is never the one that was just shown', () => {
  for (const current of [null, ...GREETINGS]) {
    for (const pick of [0, 0.3, 0.6, 0.999]) {
      const greeting = pickGreeting(current, () => pick);
      assert.ok(GREETINGS.includes(greeting));
      assert.notEqual(greeting, current);
    }
  }
});

// An empty chat as far as the greeting goes: the whale, with the title text right after it.
function emptyChat(text) {
  const node = { nodeType: 3, data: text };
  const title = { childNodes: [{ nodeType: 1 }, node] };
  const whale = { nextElementSibling: title };
  const listeners = [];
  const page = { querySelector: (selector) => (selector.startsWith('svg') && page.shown ? whale : null), shown: true };
  class Observer {
    constructor(callback) { this.callback = callback; listeners.push(this); this.connected = false; }
    observe() { this.connected = true; }
    disconnect() { this.connected = false; }
  }
  return { node, page, Observer, listeners, whale };
}

test('the greeting is found next to the whale, and there is none on a chat in progress', () => {
  const chat = emptyChat('Where would you like to begin?');
  assert.equal(findGreetingNode(chat.page), chat.node);
  chat.page.shown = false;
  assert.equal(findGreetingNode(chat.page), null);
});

test('while it runs DeepSeek\'s greeting is replaced, each time it writes a new one', () => {
  const chat = emptyChat('Where would you like to begin?');
  const greeting = createEvilGreeting({ page: chat.page, Observer: chat.Observer, random: () => 0 });
  greeting.start();
  assert.equal(greeting.isRunning(), true);
  const first = chat.node.data;
  assert.ok(GREETINGS.includes(first));

  // The page's own update of the same text does not loop: ours is left alone.
  chat.listeners[0].callback();
  assert.equal(chat.node.data, first);

  // DeepSeek writes another greeting: it is replaced by one that differs from the last one.
  chat.node.data = 'Hi. How can I help?';
  chat.listeners[0].callback();
  assert.ok(GREETINGS.includes(chat.node.data));
  assert.notEqual(chat.node.data, first);
});

test('turning it off stops the observer and gives DeepSeek\'s greeting back', () => {
  const chat = emptyChat('Where would you like to begin?');
  const greeting = createEvilGreeting({ page: chat.page, Observer: chat.Observer, random: () => 0.5 });
  greeting.start();
  greeting.start();
  assert.equal(chat.listeners.length, 1, 'starting twice does not watch twice');
  greeting.stop();
  assert.equal(chat.listeners[0].connected, false);
  assert.equal(greeting.isRunning(), false);
  assert.equal(chat.node.data, 'Where would you like to begin?');
});

test('it does nothing on a page without an empty chat', () => {
  const chat = emptyChat('x');
  chat.page.shown = false;
  const greeting = createEvilGreeting({ page: chat.page, Observer: chat.Observer });
  greeting.start();
  greeting.stop();
  assert.equal(chat.node.data, 'x');
});
