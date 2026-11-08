'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createChatStats, formatStats, formatDuration } = require('../../extension/lib/chat-stats.js');
const { formatTokens } = require('../../extension/lib/format-tokens.js');
const { createSseRewriter } = require('../../extension/lib/stream-filter.js');

// One reply: a request at `start`, the first token after `wait` ms and the end `generate` ms later.
function reply(stats, id, { start, wait, generate, tokens }) {
  stats.streamStart(id, start);
  stats.firstToken(id, start + wait);
  stats.replyEnd(id, start + wait + generate, tokens, true);
}

test('a chat with no finished step has nothing to show', () => {
  const stats = createChatStats();
  assert.equal(stats.summary('a'), null);
  stats.userTurn('a', true);
  stats.streamStart('a', 0);
  assert.equal(stats.summary('a'), null);
});

test('turns, steps, time, speed and tokens add up over a chat', () => {
  const stats = createChatStats();
  stats.userTurn('a', true);
  reply(stats, 'a', { start: 1000, wait: 1000, generate: 4000, tokens: 201 });
  // A tool result goes back as a step of the same turn: no new turn.
  reply(stats, 'a', { start: 20000, wait: 2000, generate: 1000, tokens: 11 });
  stats.usage('a', 5000);

  const summary = stats.summary('a');
  assert.equal(summary.turns, 1);
  assert.equal(summary.steps, 2);
  assert.equal(summary.llmMs, 8000);
  assert.equal(summary.ttftMs, 1500);
  // (200 + 10) tokens after the first ones, in 5 seconds.
  assert.equal(Math.round(summary.tokensPerSecond), 42);
  assert.equal(summary.output, 212);
  assert.equal(summary.input, 4788);

  stats.userTurn('a', false);
  assert.equal(stats.summary('a').turns, 2);
});

test('a chat the tab did not follow from its first message shows no input', () => {
  const stats = createChatStats();
  stats.userTurn('old', false);
  reply(stats, 'old', { start: 0, wait: 500, generate: 1000, tokens: 50 });
  stats.usage('old', 90000);
  const summary = stats.summary('old');
  assert.equal(summary.input, null);
  assert.equal(summary.output, 50);
  assert.equal(formatStats(summary, formatTokens), '1 turn · 1 step | LLM 1.5s | TTFT avg 0.5s · 49 tok/s | Output 50 tok');
});

test('a replayed reply is not counted, and a reply that never began is a step with no speed', () => {
  const stats = createChatStats();
  stats.userTurn('a', true);
  stats.streamStart('a', 0);
  stats.replyEnd('a', 3000, 400, false);
  assert.equal(stats.summary('a'), null);

  stats.streamStart('a', 0);
  stats.replyEnd('a', 3000, 0, true);
  const summary = stats.summary('a');
  assert.equal(summary.steps, 1);
  assert.equal(summary.ttftMs, null);
  assert.equal(summary.tokensPerSecond, null);
  assert.equal(formatStats(summary, formatTokens), '1 turn · 1 step | LLM 3.0s');
  // An end with no start, such as a stream that began before the page was hooked, is ignored.
  stats.replyEnd('nothing', 10, 5, true);
  assert.equal(stats.summary('nothing'), null);
});

test('the figures survive a reload through the store, and old chats are dropped past thirty', () => {
  let saved = null;
  const store = { read: () => saved, write: (value) => { saved = JSON.parse(JSON.stringify(value)); } };
  const first = createChatStats({ store });
  first.userTurn('a', true);
  reply(first, 'a', { start: 0, wait: 100, generate: 900, tokens: 11 });
  first.usage('a', 2000);

  const again = createChatStats({ store });
  assert.deepEqual(again.summary('a'), first.summary('a'));

  for (let index = 0; index < 35; index += 1) again.userTurn(`chat-${index}`, true);
  assert.ok(Object.keys(saved).length <= 30);
  assert.equal(Object.keys(saved).includes('a'), false);
  assert.ok(Object.keys(saved).includes('chat-34'));
  // A store that cannot be read or written never breaks the figures.
  const broken = createChatStats({ store: { read: () => { throw new Error('blocked'); }, write: () => { throw new Error('blocked'); } } });
  broken.userTurn('b', true);
  reply(broken, 'b', { start: 0, wait: 1, generate: 1, tokens: 2 });
  assert.equal(broken.summary('b').steps, 1);
});

test('the line is written like the reference, and long times become minutes', () => {
  assert.equal(formatDuration(7500), '7.5s');
  assert.equal(formatDuration(72000), '1m 12s');
  const summary = { turns: 3, steps: 5, llmMs: 7500, ttftMs: 1500, tokensPerSecond: 68.2, output: 407, input: 23300 };
  assert.equal(formatStats(summary, formatTokens), '3 turns · 5 steps | LLM 7.5s | TTFT avg 1.5s · 68 tok/s | Input 23.3K tok · Output 407 tok');
  assert.equal(formatStats(null, formatTokens), '');
});

test('the stream filter counts what the model wrote and reports when it began and ended', () => {
  const stream = [
    'event: ready',
    'data: {"request_message_id":1,"response_message_id":2}',
    '',
    'data: {"v":{"response":{"message_id":2,"fragments":[{"id":2,"type":"THINK","content":"We"}]}}}',
    '',
    'data: {"p":"response/fragments/-1/content","o":"APPEND","v":" need"}',
    '',
    'data: {"v":" it"}',
    '',
    'data: {"p":"response/fragments","v":[{"id":3,"type":"RESPONSE","content":"A"}]}',
    '',
    'data: {"p":"response/fragments/-1/content","o":"APPEND","v":"="}',
    '',
    'data: {"v":"1"}',
    '',
    'data: {"p":"response","o":"BATCH","v":[{"p":"accumulated_token_usage","v":900},{"p":"quasi_status","v":"FINISHED"}]}',
    '',
  ].join('\n');
  for (const size of [1, 9, stream.length]) {
    const events = [];
    const rewriter = createSseRewriter({ sessionId: 's', onEvent: (event) => events.push(event) });
    for (let at = 0; at < stream.length; at += size) rewriter.feed(stream.slice(at, at + size));
    rewriter.end();
    assert.equal(events.filter((event) => event.type === 'first-token').length, 1, `chunk size ${size}`);
    const end = events.filter((event) => event.type === 'reply-end');
    assert.equal(end.length, 1);
    // Three of reasoning and three of answer.
    assert.equal(end[0].tokens, 6);
    assert.equal(end[0].think, 3);
    assert.equal(end[0].live, true);
    assert.ok(events.findIndex((event) => event.type === 'first-token') < events.findIndex((event) => event.type === 'reply-end'));
  }
});
