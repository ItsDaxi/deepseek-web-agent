'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildMessage, summarizeStream, percentOf } = require('../manual/context-probe.js');

test('the probe message is about the size asked for, and always the same', () => {
  const first = buildMessage({ tokens: 100000, charsPerToken: 1 });
  assert.ok(Math.abs(first.text.length - 100000) < 400, `got ${first.text.length} characters`);
  assert.equal(buildMessage({ tokens: 100000, charsPerToken: 1 }).text, first.text);
  assert.notEqual(buildMessage({ tokens: 50000, charsPerToken: 1 }).text, first.text);
  // By default a token is about 2.88 characters, as DeepSeek counted for digits.
  assert.ok(Math.abs(buildMessage({ tokens: 100000 }).text.length - 288000) < 1000);
  assert.throws(() => buildMessage({ tokens: 10 }), /at least/);
});

test('five different codes sit at the start, a quarter, the middle, three quarters and the end', () => {
  const { text, canaries } = buildMessage({ tokens: 200000 });
  assert.equal(new Set(canaries.map((canary) => canary.code)).size, 5);
  const positions = canaries.map((canary) => {
    assert.equal(text.split(canary.sentence).length - 1, 1, `${canary.label} appears once`);
    return text.indexOf(canary.sentence) / text.length;
  });
  assert.deepEqual(positions.map((position) => Math.round(position * 100) / 100), [0, 0.25, 0.5, 0.75, 1]);
  assert.ok(positions.every((position, index) => index === 0 || position > positions[index - 1]));
  assert.ok(text.endsWith('D=<code> E=<code>. Say nothing else.'));
});

test('the filler is digits only, in lines of a fixed width', () => {
  const { text } = buildMessage({ tokens: 20000 });
  const rows = text.split('\n').filter((line) => /^\d+$/.test(line));
  assert.ok(rows.length > 190);
  assert.ok(rows.every((row) => row.length === 100));
});

test('a stream is summed up: the token count, the events and what the server said', () => {
  const stream = [
    'event: ready',
    'data: {"request_message_id":1,"response_message_id":2}',
    '',
    'data: {"p":"response","o":"BATCH","v":[{"p":"accumulated_token_usage","v":1000123},{"p":"quasi_status","v":"FINISHED"}]}',
    '',
    'event: toast',
    'data: {"type":"error","content":"too long"}',
    '',
  ].join('\n');
  const summary = summarizeStream(stream);
  assert.equal(summary.usage, 1000123);
  assert.deepEqual(summary.events, { ready: 1, toast: 1 });
  assert.deepEqual(summary.statuses, ['FINISHED']);
  assert.deepEqual(summary.messages, ['{"type":"error","content":"too long"}']);
  assert.equal(summarizeStream('').usage, null);
});

test('the number in a refusal notice is read, and anything else gives none', () => {
  assert.equal(percentOf('Content is too long (9%). Please shorten it and try again.'), 9);
  assert.equal(percentOf('Content is too long (12.5 %)'), 12.5);
  assert.equal(percentOf('Content is too long'), null);
  assert.equal(percentOf(null), null);
});
