'use strict';

// What the helpers (sub-agents) need from the shared text protocol and the stream filter.
const test = require('node:test');
const assert = require('node:assert/strict');
const Protocol = require('../../extension/lib/protocol.js');
const { createToolScanner, createSseRewriter } = require('../../extension/lib/stream-filter.js');

function sse(lines) {
  return `${lines.join('\n')}\n\n`;
}

function run(text, size, options = {}) {
  const events = [];
  const rewriter = createSseRewriter({ sessionId: 'abcdef012345', onEvent: (event) => events.push(event), ...options });
  let output = '';
  for (let index = 0; index < text.length; index += size) output += rewriter.feed(text.slice(index, index + size));
  output += rewriter.end();
  return { output, events };
}

const REPLY = (...tokens) => sse([
  'event: ready',
  'data: {"request_message_id":1,"response_message_id":2,"model_type":"default"}',
  '',
  `data: ${JSON.stringify({ v: { response: { message_id: 2, status: 'WIP', fragments: [{ id: 2, type: 'RESPONSE', content: tokens[0] }] } } })}`,
  '',
  ...tokens.slice(1).flatMap((token, index) => [
    `data: ${JSON.stringify(index === 0 ? { p: 'response/fragments/-1/content', v: token } : { v: token })}`,
    '',
  ]),
  'data: {"p":"response/status","o":"SET","v":"FINISHED"}',
  '',
  'event: close',
  'data: {"click_behavior":"none","auto_resume":false}',
]);

const REFUSAL = (reason) => sse([
  'event: ready',
  'data: {"request_message_id":1,"response_message_id":2,"model_type":"default"}',
  '',
  'event: hint',
  `data: {"type":"error","content":"Si sta generando un messaggio, riprova più tardi.","clear_response":true,"finish_reason":"${reason}"}`,
  '',
  'event: close',
  'data: {"click_behavior":"retry","auto_resume":false}',
]);

test('the end of a reply carries what the model answered, and whether it called a tool', () => {
  for (const size of [1, 7, 1000]) {
    const plain = run(REPLY('The ', 'report ', 'is ready.'), size);
    const end = plain.events.find((event) => event.type === 'reply-end');
    assert.equal(end.answer, 'The report is ready.', `chunk size ${size}`);
    assert.equal(end.toolCalled, false);
    assert.equal(end.failed, false);
  }
  const called = run(REPLY('Looking.\n', '<dsx:read path="a.txt"></dsx:read>'), 7);
  const end = called.events.find((event) => event.type === 'reply-end');
  assert.equal(end.toolCalled, true);
  assert.ok(end.answer.includes('Looking.'));
});

test('a refusal inside a normal answer is reported with its reason, and the page still gets it', () => {
  for (const reason of ['parallel_chat_limit', 'rate_limit_reached']) {
    for (const size of [1, 9, 1000]) {
      const { events, output } = run(REFUSAL(reason), size);
      const error = events.find((event) => event.type === 'stream-error');
      assert.equal(error.reason, reason, `${reason} at chunk size ${size}`);
      assert.match(error.message, /riprova/);
      assert.equal(events.find((event) => event.type === 'reply-end').failed, true);
      assert.ok(output.includes(reason));
    }
  }
});

test('a hint that is not an error is not a refusal', () => {
  const text = sse(['event: hint', 'data: {"type":"info","content":"fyi"}']);
  assert.equal(run(text, 1000).events.some((event) => event.type === 'stream-error'), false);
});

test('a helper call is found like any other tool, with its description', () => {
  const text = 'On it.\n<dsx:agent description="Find the config">\nLook in src for the config loader and report its path.\n</dsx:agent>';
  for (const size of [1, 6, 1000]) {
    const calls = [];
    const scanner = createToolScanner({ mode: 'call', nextId: () => 'id-1', onCall: (call) => calls.push(call) });
    let output = scanner.push(text.slice(0, size));
    for (let index = size; index < text.length; index += size) output += scanner.push(text.slice(index, index + size));
    output += scanner.flush();
    assert.equal(calls.length, 1, `chunk size ${size}`);
    assert.equal(calls[0].tool, 'agent');
    assert.equal(calls[0].attributes.description, 'Find the config');
    assert.equal(calls[0].command, 'Look in src for the config loader and report its path.');
    assert.ok(!output.includes('dsx:agent'));
  }
});

test('the helper tool is described to the model, with its limit of two', () => {
  const prompt = Protocol.buildSystemPrompt({ platform: 'win32', defaultShell: 'powershell', shells: ['powershell'], home: 'C:\\Users\\me' });
  assert.ok(Protocol.TOOL_NAMES.includes('agent'));
  assert.match(prompt, /<dsx:agent description=/);
  assert.match(prompt, /At most 2 helpers/);
  assert.match(Protocol.injectPrompt('hi', null, { full: false }), /<dsx:agent description=/);
});

test('a helper chat is not offered the helper tool', () => {
  const full = Protocol.injectPrompt('task', null, { full: true, agents: false });
  const reminder = Protocol.injectPrompt('task', null, { full: false, agents: false });
  assert.ok(!full.includes('dsx:agent'));
  assert.ok(!reminder.includes('dsx:agent'));
  assert.match(full, /<dsx:shell/);
});

test('the task of a helper is wrapped with what is expected of it', () => {
  const text = Protocol.buildHelperTask('  Find the login code.  ');
  assert.match(text, /plain-text report/);
  assert.match(text, /Task:\nFind the login code\.$/);
});
