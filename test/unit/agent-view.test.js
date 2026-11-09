'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAgentRegistry } = require('../../extension/lib/agent-registry.js');
const { visibleAgents, describeAgent, summaryText, isWorking } = require('../../extension/lib/agent-view.js');
const { formatTokens } = require('../../extension/lib/format-tokens.js');
const { formatDuration } = require('../../extension/lib/chat-stats.js');

const format = { formatTokens, formatDuration };

test('a helper is listed with its figures and a finished one keeps them', () => {
  const registry = createAgentRegistry();
  registry.add({ id: '1-a', toolId: 'abcdef01-2-1', owner: 1, description: 'Find the config' });
  registry.update('1-a', { state: 'running', startedAt: 1000, output: 407, input: 23300, sessionId: 'sess' });
  const [entry] = registry.snapshot(1);
  assert.deepEqual(
    { id: entry.id, state: entry.state, output: entry.output, input: entry.input, hasTab: entry.hasTab },
    { id: 'abcdef01-2-1', state: 'running', output: 407, input: 23300, hasTab: false },
  );
  // The task and the tab are not part of what the page gets.
  assert.equal('task' in entry, false);
  assert.equal('tabId' in entry, false);
});

test('each tab only gets its own helpers', () => {
  const registry = createAgentRegistry();
  registry.add({ id: 'a', toolId: 't1', owner: 1 });
  registry.add({ id: 'b', toolId: 't2', owner: 2 });
  assert.deepEqual(registry.snapshot(1).map((entry) => entry.id), ['t1']);
  assert.deepEqual(registry.snapshot(2).map((entry) => entry.id), ['t2']);
  assert.equal(registry.findByTool(2, 't1'), null);
  registry.removeOwner(1);
  assert.deepEqual(registry.snapshot(1), []);
  assert.equal(registry.snapshot(2).length, 1);
});

test('the oldest finished helpers go first when there are too many, and working ones stay', () => {
  const registry = createAgentRegistry({ maxPerOwner: 3 });
  registry.add({ id: 'a', toolId: 't1', owner: 1, state: 'running' });
  registry.add({ id: 'b', toolId: 't2', owner: 1, state: 'ok' });
  registry.add({ id: 'c', toolId: 't3', owner: 1, state: 'ok' });
  registry.add({ id: 'd', toolId: 't4', owner: 1, state: 'queued' });
  assert.deepEqual(registry.snapshot(1).map((entry) => entry.id), ['t1', 't3', 't4']);
});

test('the helpers of the open chat are the ones its call ids start with', () => {
  const list = [{ id: 'abcdef01-2-1' }, { id: 'abcdef01-4-1' }, { id: '99999999-2-1' }];
  assert.deepEqual(visibleAgents(list, 'abcdef01-2222-3333-4444-555555555555').map((entry) => entry.id), ['abcdef01-2-1', 'abcdef01-4-1']);
  assert.deepEqual(visibleAgents(list, null), []);
  assert.deepEqual(visibleAgents(null, 'abcdef01-x'), []);
  // A chat whose id merely starts with the same letters is not the same chat.
  assert.deepEqual(visibleAgents([{ id: 'abcdef012-2-1' }], 'abcdef01-x'), []);
});

test('a working helper shows its tokens and a time that keeps counting', () => {
  const entry = { description: 'Find the config', state: 'running', startedAt: 1000, output: 407, input: 23300, sessionId: 's', hasTab: true };
  const early = describeAgent(entry, 8500, format);
  assert.equal(early.title, 'Find the config');
  assert.equal(early.meta, 'Input 23.3K tok · Output 407 tok · 7.5s');
  assert.equal(early.clickable, true);
  assert.equal(describeAgent(entry, 73000, format).meta, 'Input 23.3K tok · Output 407 tok · 1m 12s');
});

test('a helper that has produced nothing yet says it is starting', () => {
  const entry = { state: 'running', startedAt: 1000, output: 0, input: null, sessionId: null, hasTab: true };
  const row = describeAgent(entry, 3000, format);
  assert.equal(row.meta, 'Starting · 2.0s');
  assert.equal(row.title, 'Helper');
  assert.equal(row.clickable, true);
});

test('input is left out when it is not known, never shown as zero', () => {
  const entry = { state: 'running', startedAt: 0, output: 1500, input: null, hasTab: true };
  assert.equal(describeAgent(entry, 1000, format).meta, 'Output 1.5K tok · 1.0s');
});

test('a helper that waits for a place cannot be opened yet', () => {
  const row = describeAgent({ state: 'queued', description: 'Task 3', hasTab: false }, 5000, format);
  assert.equal(row.meta, 'Waiting for a free place');
  assert.equal(row.clickable, false);
});

test('a finished helper shows how long it took, fixed at the moment it ended', () => {
  const done = { state: 'ok', startedAt: 1000, endedAt: 13000, output: 900, input: 5000, sessionId: 's', hasTab: false };
  assert.equal(describeAgent(done, 999999, format).meta, 'Input 5K tok · Output 900 tok · 12.0s');
  assert.equal(describeAgent(done, 999999, format).clickable, true);
  const failed = { ...done, state: 'failed' };
  assert.match(describeAgent(failed, 0, format).meta, /^Failed · /);
  assert.match(describeAgent({ ...done, state: 'timeout' }, 0, format).meta, /^Timed out · /);
  assert.match(describeAgent({ ...done, state: 'stopped' }, 0, format).meta, /^Stopped · /);
});

test('a finished helper with no chat to go to is not a link', () => {
  assert.equal(describeAgent({ state: 'failed', startedAt: 1, endedAt: 2, output: 0, sessionId: null, hasTab: false }, 3, format).clickable, false);
});

test('the summary counts what is working, done, failed and stopped', () => {
  const list = [{ state: 'running' }, { state: 'queued' }, { state: 'ok' }, { state: 'failed' }, { state: 'stopped' }];
  assert.equal(summaryText(list), '2 working · 1 done · 1 failed · 1 stopped');
  assert.equal(summaryText([]), '');
  assert.equal(isWorking(list), true);
  assert.equal(isWorking([{ state: 'ok' }]), false);
});
