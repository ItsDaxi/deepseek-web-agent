'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { latestUsage, contextLimit, storedContextLimit } = require('../../extension/lib/context-usage.js');
const { createSseRewriter, rewriteHistory } = require('../../extension/lib/stream-filter.js');

test('the limit is the smaller token limit of the model the chat opens with', () => {
  const payload = (configs) => ({ data: { biz_data: { settings: { model_configs: { value: configs } } } } });
  const feature = (a, b) => ({ file_feature: { token_limit: a, token_limit_with_thinking: b } });

  assert.equal(contextLimit(payload([
    { model_type: 'expert', enabled: false, is_default: false, ...feature(1, 1) },
    { model_type: 'default', enabled: true, is_default: true, ...feature(890880, 890880) },
  ])), 890880);
  assert.equal(contextLimit(payload([{ model_type: 'default', enabled: true, ...feature(900000, 800000) }])), 800000);
  // No default model: the first one that is switched on.
  assert.equal(contextLimit(payload([
    { model_type: 'a', enabled: false, ...feature(5, 5) },
    { model_type: 'b', enabled: true, ...feature(7, 7) },
  ])), 7);
  assert.equal(contextLimit(payload([{ model_type: 'default', enabled: true }])), null);
  assert.equal(contextLimit(payload([])), null);
  assert.equal(contextLimit({ data: { biz_data: null } }), null);
  assert.equal(contextLimit(null), null);
});

test('the limit can also be read from the copy the page keeps in localStorage', () => {
  const stored = JSON.stringify({
    schemaVersion: 2,
    entries: { model_configs: { id: 1, value: [{ model_type: 'default', enabled: true, is_default: true, file_feature: { token_limit: 890880, token_limit_with_thinking: 890880 } }] } },
  });
  assert.equal(storedContextLimit(stored), 890880);
  assert.equal(storedContextLimit('{"entries":{}}'), null);
  assert.equal(storedContextLimit('not json'), null);
  assert.equal(storedContextLimit(null), null);
});

test('the usage of a chat is the total after its newest message', () => {
  const messages = [
    { message_id: 1, role: 'USER' },
    { message_id: 2, role: 'ASSISTANT', accumulated_token_usage: 999 },
    { message_id: 3, role: 'USER' },
    { message_id: 4, role: 'ASSISTANT', accumulated_token_usage: 1606 },
    { message_id: 5, role: 'USER' },
  ];
  assert.equal(latestUsage(messages), 1606);
  // The message the chat ends on wins, as after switching to another branch of a reply.
  assert.equal(latestUsage(messages, 2), 999);
  assert.equal(latestUsage(messages, 99), 1606);
  assert.equal(latestUsage([{ message_id: 1 }], undefined), null);
  assert.equal(latestUsage([{ message_id: 2, accumulated_token_usage: 0 }]), null);
  assert.equal(latestUsage(null), null);
});

test('history reports the usage and the chat it belongs to', () => {
  const payload = {
    data: {
      biz_data: {
        chat_session: { id: 'sess-1', current_message_id: 4 },
        chat_messages: [
          { message_id: 1, role: 'USER', fragments: [{ type: 'REQUEST', content: 'hi' }] },
          { message_id: 2, role: 'ASSISTANT', accumulated_token_usage: 999, fragments: [{ type: 'RESPONSE', content: 'a' }] },
          { message_id: 3, role: 'USER', fragments: [{ type: 'REQUEST', content: 'more' }] },
          { message_id: 4, role: 'ASSISTANT', accumulated_token_usage: 1606, fragments: [{ type: 'RESPONSE', content: 'b' }] },
        ],
      },
    },
  };
  const found = rewriteHistory(payload, null);
  assert.equal(found.tokens, 1606);
  assert.equal(found.sessionId, 'sess-1');
  assert.deepEqual(rewriteHistory({}, 'fallback'), { tools: [], results: [], tokens: null, sessionId: 'fallback' });
});

test('the end of a reply reports the total DeepSeek counted, however the stream is cut', () => {
  const stream = [
    'event: ready',
    'data: {"request_message_id":1,"response_message_id":2,"model_type":"default"}',
    '',
    'data: {"v":{"response":{"message_id":2,"accumulated_token_usage":0,"fragments":[{"id":2,"type":"RESPONSE","content":"Hi"}]}}}',
    '',
    'data: {"p":"response","o":"BATCH","v":[{"p":"accumulated_token_usage","v":1606},{"p":"quasi_status","v":"FINISHED"}]}',
    '',
    'data: {"p":"response/status","o":"SET","v":"FINISHED"}',
    '',
  ].join('\n');

  for (const size of [1, 7, stream.length]) {
    const events = [];
    const rewriter = createSseRewriter({ sessionId: 'sess-1', onEvent: (event) => events.push(event) });
    for (let at = 0; at < stream.length; at += size) rewriter.feed(stream.slice(at, at + size));
    rewriter.end();
    assert.deepEqual(events.filter((event) => event.type === 'usage'), [{ type: 'usage', sessionId: 'sess-1', tokens: 1606 }], `chunk size ${size}`);
  }
});

test('a reply that carries no total reports none', () => {
  const events = [];
  const rewriter = createSseRewriter({ sessionId: 's', onEvent: (event) => events.push(event) });
  rewriter.feed('data: {"p":"response","o":"BATCH","v":[{"p":"quasi_status","v":"FINISHED"}]}\n\n');
  rewriter.feed('data: {"p":"response","o":"BATCH","v":[{"p":"accumulated_token_usage","v":0}]}\n\n');
  rewriter.end();
  assert.equal(events.filter((event) => event.type === 'usage').length, 0);
});
