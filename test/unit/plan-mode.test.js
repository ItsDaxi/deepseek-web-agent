'use strict';

// Plan mode: the hidden block that tells the model, the plan tag the stream filter takes out, and the
// presets and cards that carry it.

const test = require('node:test');
const assert = require('node:assert/strict');
const Protocol = require('../../extension/lib/protocol.js');
const { createToolScanner, rewriteHistory } = require('../../extension/lib/stream-filter.js');

test('plan is a tool the stream filter recognises', () => {
  assert.ok(Protocol.TOOL_NAMES.includes('plan'));
  const calls = [];
  const scanner = createToolScanner({ nextId: () => 'p-1', onCall: (call) => calls.push(call) });
  const plan = '## Goal\n\n1. Change `a.js`\n2. Run the tests';
  const shown = scanner.push(`I looked around.\n<dsx:plan>\n${plan}\n</dsx:plan>`) + scanner.flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tool, 'plan');
  assert.equal(calls[0].command, plan);
  assert.doesNotMatch(shown, /Goal|dsx:plan/);
  assert.match(shown, /dsx-tool:p-1/);
});

test('a plan split into tiny chunks comes out whole', () => {
  const calls = [];
  const scanner = createToolScanner({ nextId: () => 'p-2', onCall: (call) => calls.push(call) });
  const text = '<dsx:plan>step one\nstep two</dsx:plan>';
  for (let index = 0; index < text.length; index += 3) scanner.push(text.slice(index, index + 3));
  scanner.flush();
  assert.equal(calls[0].command, 'step one\nstep two');
});

test('the plan block names the tag and stays out of the history', () => {
  const block = Protocol.buildPlanBlock();
  assert.match(block, /Plan mode is on/);
  assert.match(block, /<dsx:plan>/);
  assert.match(block, /helper/);
  assert.doesNotMatch(Protocol.buildPlanBlock({ agents: false }), /helper/);
  const sent = Protocol.injectPrompt('fix the bug', { platform: 'win32' }, { full: false, plan: true });
  assert.match(sent, /Plan mode is on/);
  assert.equal(Protocol.stripInjected(sent), 'fix the bug');
});

test('plan mode is only described while it is on, and its end is announced once', () => {
  const env = { platform: 'win32' };
  assert.doesNotMatch(Protocol.injectPrompt('x', env, { full: true }), /<dsx:plan>/);
  assert.doesNotMatch(Protocol.injectPrompt('x', env, { full: false }), /<dsx:plan>/);
  const over = Protocol.injectPrompt('x', env, { full: false, planRetire: true });
  assert.match(over, /Plan mode is over/);
  assert.equal(Protocol.stripInjected(over), 'x');
});

test('an old plan in the history is a card, not text on the page', () => {
  const payload = {
    data: {
      biz_data: {
        chat_messages: [
          {
            message_id: 2,
            role: 'ASSISTANT',
            fragments: [{ type: 'RESPONSE', content: 'Looked.\n<dsx:plan>\nDo it\n</dsx:plan>' }],
          },
        ],
      },
    },
  };
  const { tools } = rewriteHistory(payload, 'abcdef12-0000-0000-0000-000000000000');
  assert.equal(tools.length, 1);
  assert.equal(tools[0].tool, 'plan');
  assert.equal(tools[0].command, 'Do it');
  assert.doesNotMatch(JSON.stringify(payload), /Do it/);
});
