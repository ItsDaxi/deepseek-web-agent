'use strict';

// Runs page-hook.js against a small imitation of DeepSeek's page: a composer, a file input that uploads and
// parses like the real one, and the completion request. It checks what the model's message ends up carrying.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Protocol = require('../../extension/lib/protocol.js');
const Filter = require('../../extension/lib/stream-filter.js');
const ContextUsage = require('../../extension/lib/context-usage.js');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', '..', 'extension', 'page-hook.js'), 'utf8');
const SESSION = '11111111-2222-3333-4444-555555555555';
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(predicate, label, ms = 8000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await wait(10);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

// `parseStatus` is what DeepSeek says about each file once it has been parsed. `blockSendUntilParsed` makes the
// composer ignore Enter while a file is still being read, as the real one does.
function createPage({ parseStatus = 'SUCCESS', blockSendUntilParsed = true, noUploadRequests = false } = {}) {
  const messageListeners = [];
  const log = [];
  const completions = [];
  const state = { parsed: false, refIds: [] };

  class FakeXHR {
    constructor() {
      this.listeners = {};
      this.readyState = 0;
      this.status = 0;
      this.responseType = '';
      this.text = '';
    }
    open(method, url) {
      this.method = method;
      this.url = url;
    }
    setRequestHeader() {}
    addEventListener(type, listener) {
      (this.listeners[type] = this.listeners[type] || []).push(listener);
    }
    getResponseHeader() {
      return '';
    }
    send(body) {
      if (String(this.url).includes('/chat/completion')) completions.push({ xhr: this, body: JSON.parse(body) });
    }
    get responseText() {
      return this.text;
    }
    get response() {
      return this.text;
    }
    finish(status, text) {
      this.readyState = 4;
      this.status = status;
      this.text = text;
      for (const listener of this.listeners.loadend || []) listener();
    }
  }

  class FakeTextarea {
    constructor() {
      this.text = '';
      this.attributes = new Set();
    }
    set value(next) {
      this.text = next;
    }
    get value() {
      return this.text;
    }
    getClientRects() {
      return [{}];
    }
    setAttribute(name) {
      this.attributes.add(name);
    }
    removeAttribute(name) {
      this.attributes.delete(name);
    }
    focus() {}
    dispatchEvent(event) {
      // Enter sends the message, unless a file is still being read.
      if (event.type !== 'keydown' || event.key !== 'Enter' || !this.text) return true;
      if (blockSendUntilParsed && state.refIds.length && !state.parsed) return true;
      const xhr = new FakeXHR();
      xhr.open('POST', '/api/v0/chat/completion');
      xhr.send(JSON.stringify({ chat_session_id: SESSION, parent_message_id: 3, prompt: this.text, ref_file_ids: state.refIds, search_enabled: false, thinking_enabled: true }));
      log.push('sent');
      this.text = '';
      state.refIds = [];
      state.parsed = false;
      return true;
    }
  }

  const composer = new FakeTextarea();

  // The file input: choosing files uploads each one, then polls until DeepSeek has parsed it.
  const input = {
    accept: '.pdf,.png,.txt',
    _files: [],
    set files(list) {
      this._files = list;
    },
    get files() {
      return this._files;
    },
    dispatchEvent(event) {
      if (event.type !== 'change') return true;
      log.push(`change:${this._files.map((file) => file.name).join(',')}`);
      if (noUploadRequests) return true;
      this._files.forEach((file, index) => {
        const id = `f${index}`;
        const upload = new FakeXHR();
        upload.open('POST', '/api/v0/file/upload_file');
        upload.send('form');
        setTimeout(() => {
          state.refIds.push(id);
          upload.finish(200, JSON.stringify({ data: { biz_code: 0, biz_data: { id, status: 'PENDING' } } }));
          setTimeout(() => {
            const poll = new FakeXHR();
            poll.open('GET', `/api/v0/file/fetch_files?file_ids=${id}`);
            poll.send(null);
            setTimeout(() => {
              state.parsed = parseStatus === 'SUCCESS';
              poll.finish(200, JSON.stringify({ data: { biz_code: 0, biz_data: { files: [{ id, status: parseStatus }] } } }));
            }, 30);
          }, 20);
        }, 30);
      });
      return true;
    },
  };

  class HTMLTextAreaElement {
    set value(next) {
      this.text = next;
    }
  }
  // The hook reads the page's own setter for a textarea's value, and applies it to the composer.
  Object.defineProperty(HTMLTextAreaElement.prototype, 'value', Object.getOwnPropertyDescriptor(FakeTextarea.prototype, 'value'));

  const sandbox = {
    XMLHttpRequest: FakeXHR,
    HTMLTextAreaElement,
    KeyboardEvent: class { constructor(type, init) { this.type = type; Object.assign(this, init); } },
    Event: class { constructor(type, init) { this.type = type; Object.assign(this, init); } },
    DataTransfer: class { constructor() { this.files = []; this.items = { add: (file) => this.files.push(file) }; } },
    File: class { constructor(parts, name, options) { this.parts = parts; this.name = name; this.type = options.type; this.size = parts[0].length; } },
    URL,
    JSON,
    Map,
    Set,
    WeakMap,
    Promise,
    Date,
    atob,
    performance,
    setTimeout,
    clearTimeout,
    // The hook polls the address forever; this keeps the test from waiting on it.
    setInterval: (fn, ms) => setInterval(fn, ms).unref(),
    location: { origin: 'https://chat.deepseek.com', pathname: `/a/chat/s/${SESSION}`, href: `https://chat.deepseek.com/a/chat/s/${SESSION}` },
    localStorage: { getItem: () => null },
    document: {
      querySelectorAll: (selector) => (selector === 'textarea' ? [composer] : selector === 'input[type="file"]' ? [input] : []),
      addEventListener() {},
    },
  };
  sandbox.window = sandbox;
  sandbox.postMessage = (message) => log.push(message);
  sandbox.addEventListener = (type, listener) => {
    if (type === 'message') messageListeners.push(listener);
  };
  sandbox.DsxProtocol = Protocol;
  sandbox.DsxStreamFilter = Filter;
  sandbox.DsxContextUsage = ContextUsage;
  // Stands for the page's own fetch, which the hook wraps.
  sandbox.fetch = async () => ({ status: 200, clone: () => ({ json: async () => ({}) }) });

  // Inside the context `window` is the context's own global object, which is what the hook compares an
  // event's source with.
  vm.createContext(sandbox);
  const pageWindow = vm.runInContext('globalThis', sandbox);
  vm.runInContext(SOURCE, sandbox);

  return {
    log,
    completions,
    composer,
    // What the content script says to the hook.
    say(message) {
      for (const listener of messageListeners) listener({ source: pageWindow, data: { source: 'dsx-content', ...message } });
    },
    // Ends the reply of the last request, so the next result may go out.
    endStream() {
      completions[completions.length - 1].xhr.finish(200, '');
    },
  };
}

const PDF = { name: 'paper.pdf', mime: 'application/pdf', size: 4, data: Buffer.from('%PDF').toString('base64') };
const RESULT = { id: 'r1', status: 'ok', code: 0, durationMs: 3, output: 'Attached paper.pdf (4 bytes, application/pdf) to this message.', tool: 'read', command: 'paper.pdf' };
const ENV = { platform: 'win32', features: ['attachments'] };

test('a file the model read goes into the composer, is waited for, and leaves with the result', async () => {
  const page = createPage();
  page.say({ type: 'config', env: ENV, thinking: true, agent: false, plan: false });
  page.say({ type: 'send-results', results: [{ ...RESULT, attachment: PDF }], sessionId: SESSION });
  await until(() => page.completions.length === 1, 'the message to be sent');

  const order = page.log.filter((entry) => typeof entry === 'string');
  assert.deepEqual(order, ['change:paper.pdf', 'sent'], 'the file is chosen before the message goes out');
  const [{ body }] = page.completions;
  assert.deepEqual(body.ref_file_ids, ['f0'], 'the message carries the uploaded file');
  assert.match(body.prompt, /<dsx:result id="r1" tool="read" command="paper\.pdf" status="ok"/);
  assert.match(body.prompt, /Attached paper\.pdf/);
  assert.doesNotMatch(body.prompt, /could not be attached/);
  assert.equal(body.search_enabled, false, 'search is not forced on for a message that carries a file');
});

test('a file DeepSeek cannot read is reported to the model, and the result still goes out', async () => {
  const page = createPage({ parseStatus: 'CONTENT_TOO_LONG', blockSendUntilParsed: false });
  page.say({ type: 'config', env: ENV, thinking: true, agent: false, plan: false });
  page.say({ type: 'send-results', results: [{ ...RESULT, attachment: PDF }], sessionId: SESSION });
  await until(() => page.completions.length === 1, 'the message to be sent');
  assert.match(page.completions[0].body.prompt, /could not be attached \(it is too long for the chat\)/);
});

test('when the page shows no upload at all the result is not held back for ever', async () => {
  const page = createPage({ noUploadRequests: true, blockSendUntilParsed: false });
  page.say({ type: 'config', env: ENV, thinking: true, agent: false, plan: false });
  page.say({ type: 'send-results', results: [{ ...RESULT, attachment: PDF }], sessionId: SESSION });
  await until(() => page.completions.length === 1, 'the message to be sent', 15000);
  assert.match(page.completions[0].body.prompt, /<dsx:result id="r1"/);
});

test('a result without a file never touches the file input', async () => {
  const page = createPage();
  page.say({ type: 'config', env: ENV, thinking: true, agent: false, plan: false });
  page.say({ type: 'send-results', results: [{ ...RESULT, output: 'ok', attachment: undefined }], sessionId: SESSION });
  await until(() => page.completions.length === 1, 'the message to be sent');
  assert.deepEqual(page.log.filter((entry) => typeof entry === 'string'), ['sent']);
  assert.equal(page.completions[0].body.search_enabled, true, 'search stays on as before');
});

test('plan mode is announced with every message, and its end once', async () => {
  const page = createPage();
  const send = async (id) => {
    page.say({ type: 'send-results', results: [{ ...RESULT, id, output: 'ok', attachment: undefined }], sessionId: SESSION });
    await until(() => page.completions.length === Number(id.slice(1)), `${id} to be sent`);
    page.endStream();
  };
  page.say({ type: 'config', env: ENV, thinking: true, agent: false, plan: true });
  await send('r1');
  await send('r2');
  page.say({ type: 'config', env: ENV, thinking: true, agent: false, plan: false });
  await send('r3');
  await send('r4');
  const prompts = page.completions.map((entry) => entry.body.prompt);
  assert.match(prompts[0], /Plan mode is on/);
  assert.match(prompts[1], /Plan mode is on/);
  assert.match(prompts[2], /Plan mode is over/);
  assert.doesNotMatch(prompts[2], /Plan mode is on/);
  assert.doesNotMatch(prompts[3], /Plan mode/);
});
