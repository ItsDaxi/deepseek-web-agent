'use strict';

// Runs page-hook.js against a page that only has XMLHttpRequest, to see how a chat is deleted: DeepSeek's own
// call, with the headers its pages send, and the answer reported back.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Protocol = require('../../extension/lib/protocol.js');
const Filter = require('../../extension/lib/stream-filter.js');
const ContextUsage = require('../../extension/lib/context-usage.js');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', '..', 'extension', 'page-hook.js'), 'utf8');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

function createPage({ token = null, answer = { status: 200, body: { code: 0, data: { biz_code: 0 } } } } = {}) {
  const listeners = [];
  const posted = [];
  const sent = [];

  class FakeXHR {
    constructor() {
      this.headers = {};
      this.responseType = '';
    }
    open(method, url) {
      this.method = method;
      this.url = url;
    }
    setRequestHeader(name, value) {
      this.headers[name] = value;
    }
    addEventListener() {}
    send(body) {
      sent.push({ method: this.method, url: this.url, headers: this.headers, body });
      if (!String(this.url).includes('chat_session/delete')) return;
      this.status = answer.status;
      this.text = JSON.stringify(answer.body);
      setTimeout(() => this.onload && this.onload(), 0);
    }
    get responseText() {
      return this.text;
    }
    get response() {
      return this.text;
    }
  }

  const sandbox = {
    XMLHttpRequest: FakeXHR,
    HTMLTextAreaElement: class { set value(next) { this.text = next; } },
    URL, JSON, Map, Set, WeakMap, WeakSet, Promise, Date, atob, performance, setTimeout, clearTimeout,
    setInterval: (fn, ms) => setInterval(fn, ms).unref(),
    location: { origin: 'https://chat.deepseek.com', pathname: '/', href: 'https://chat.deepseek.com/' },
    localStorage: { getItem: (key) => (key === 'userToken' && token ? JSON.stringify({ value: token }) : null) },
    document: { querySelectorAll: () => [], addEventListener() {} },
    fetch: async () => ({ status: 200, clone: () => ({ json: async () => ({}) }) }),
  };
  sandbox.window = sandbox;
  sandbox.postMessage = (message) => posted.push(message);
  sandbox.addEventListener = (type, listener) => { if (type === 'message') listeners.push(listener); };
  sandbox.DsxProtocol = Protocol;
  sandbox.DsxStreamFilter = Filter;
  sandbox.DsxContextUsage = ContextUsage;
  vm.createContext(sandbox);
  const pageWindow = vm.runInContext('globalThis', sandbox);
  vm.runInContext(SOURCE, sandbox);

  return {
    posted,
    sent,
    // A call the page makes itself, with the headers its client puts on every request.
    pageCall(url, headers) {
      const xhr = new sandbox.XMLHttpRequest();
      xhr.open('GET', url);
      for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
      xhr.send(null);
    },
    say(message) {
      for (const listener of listeners) listener({ source: pageWindow, data: { source: 'dsx-content', ...message } });
    },
    async reply(id) {
      for (let tries = 0; tries < 100; tries += 1) {
        const found = posted.find((message) => message.type === 'chats-deleted' && message.id === id);
        if (found) return found;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error('no answer');
    },
  };
}

test('deleting repeats the call DeepSeek makes, with the headers the page sends, and says it worked', async () => {
  const page = createPage();
  page.pageCall('/api/v0/chat_session/fetch_page?lte_cursor.pinned=false', { Authorization: 'Bearer abc', 'x-client-version': '1.2.3', 'x-ds-pow-response': 'once', 'content-type': 'text/plain' });
  page.say({ type: 'delete-chats', id: 'd1', ids: [A, B] });
  const answer = await page.reply('d1');
  assert.equal(answer.ok, true);
  const call = page.sent.find((entry) => entry.url === '/api/v0/chat_session/delete');
  assert.equal(call.method, 'POST');
  assert.deepEqual(JSON.parse(call.body), { chat_session_ids: [A, B] });
  assert.equal(call.headers.authorization, 'Bearer abc');
  assert.equal(call.headers['x-client-version'], '1.2.3');
  assert.equal(call.headers['content-type'], 'application/json');
  assert.equal(call.headers['x-ds-pow-response'], undefined, 'a proof of work is for one call only');
});

test('without a call made yet, the stored sign-in is used', async () => {
  const page = createPage({ token: 'stored-token' });
  page.say({ type: 'delete-chats', id: 'd1', ids: [A] });
  assert.equal((await page.reply('d1')).ok, true);
  assert.equal(page.sent[0].headers.authorization, 'Bearer stored-token');
});

test('no sign-in, a refusal and a bad id are reported, and nothing is deleted', async () => {
  const none = createPage();
  none.say({ type: 'delete-chats', id: 'd1', ids: [A] });
  const missing = await none.reply('d1');
  assert.equal(missing.ok, false);
  assert.equal(missing.error, 'not signed in');
  assert.equal(none.sent.length, 0);

  const refused = createPage({ token: 't', answer: { status: 200, body: { code: 0, data: { biz_code: 7 } } } });
  refused.say({ type: 'delete-chats', id: 'd2', ids: [A] });
  const answer = await refused.reply('d2');
  assert.equal(answer.ok, false);
  assert.match(answer.error, /code 7/);

  const bad = createPage({ token: 't' });
  bad.say({ type: 'delete-chats', id: 'd3', ids: ['../../x', 42] });
  assert.equal((await bad.reply('d3')).ok, false);
  assert.equal(bad.sent.length, 0);
});
