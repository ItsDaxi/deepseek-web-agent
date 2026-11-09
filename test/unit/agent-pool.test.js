'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAgentPool, MAX_ACTIVE } = require('../../extension/lib/agent-pool.js');

// A pool with the browser replaced by lists, so what it opens, closes and reports can be read back.
function makePool(options = {}) {
  const log = { opened: [], closed: [], updates: [], done: [] };
  const timers = [];
  const pool = createAgentPool({
    open: options.open || ((job) => { log.opened.push(job.id); }),
    close: (job) => { log.closed.push(job.id); },
    onUpdate: (job, state) => log.updates.push([job.id, state]),
    onDone: (job, result) => log.done.push([job.id, result.status, result.text]),
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length - 1; },
    clearTimer: (id) => { if (timers[id]) timers[id].cleared = true; },
    ...options.pool,
  });
  return { pool, log, timers };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('two helpers is the most that work at once', async () => {
  assert.equal(MAX_ACTIVE, 2);
  const { pool, log } = makePool();
  for (const id of ['a', 'b', 'c', 'd']) pool.submit({ id, owner: 1 });
  await flush();
  assert.deepEqual(log.opened, ['a', 'b']);
  assert.equal(pool.active(), 2);
  assert.equal(pool.queued(), 2);
});

test('only a helper that has to wait is told it is waiting', async () => {
  const { pool, log } = makePool();
  for (const id of ['a', 'b', 'c']) pool.submit({ id, owner: 1 });
  await flush();
  assert.deepEqual(log.updates, [['a', 'running'], ['b', 'running'], ['c', 'queued']]);
});

test('a place that frees up goes to the helper that waited longest', async () => {
  const { pool, log } = makePool();
  for (const id of ['a', 'b', 'c', 'd']) pool.submit({ id, owner: 1 });
  await flush();
  pool.finish('a', { status: 'ok', text: 'report a' });
  await flush();
  assert.deepEqual(log.opened, ['a', 'b', 'c']);
  pool.finish('c', { status: 'ok', text: 'report c' });
  await flush();
  assert.deepEqual(log.opened, ['a', 'b', 'c', 'd']);
  assert.deepEqual(log.closed, ['a', 'c']);
  assert.deepEqual(log.done, [['a', 'ok', 'report a'], ['c', 'ok', 'report c']]);
});

test('a job ends once, however many times it is finished', async () => {
  const { pool, log } = makePool();
  pool.submit({ id: 'a', owner: 1 });
  await flush();
  assert.equal(pool.finish('a', { status: 'ok', text: 'first' }), true);
  assert.equal(pool.finish('a', { status: 'failed', text: 'second' }), false);
  assert.equal(pool.cancel('a'), false);
  assert.deepEqual(log.done, [['a', 'ok', 'first']]);
  assert.equal(log.closed.length, 1);
});

test('the same job submitted twice runs once', async () => {
  const { pool, log } = makePool();
  pool.submit({ id: 'a', owner: 1 });
  pool.submit({ id: 'a', owner: 1 });
  await flush();
  assert.deepEqual(log.opened, ['a']);
});

test('stopping a helper that waits gives it no tab and frees nothing', async () => {
  const { pool, log } = makePool();
  for (const id of ['a', 'b', 'c']) pool.submit({ id, owner: 1 });
  await flush();
  pool.cancel('c');
  assert.deepEqual(log.done, [['c', 'stopped', 'The helper was stopped.']]);
  assert.deepEqual(log.closed, []);
  pool.finish('a', { status: 'ok', text: 'x' });
  await flush();
  // c was stopped, so nothing takes the freed place.
  assert.deepEqual(log.opened, ['a', 'b']);
  assert.equal(pool.active(), 1);
});

test('a chat that goes away takes its helpers with it, and only its own', async () => {
  const { pool, log } = makePool();
  pool.submit({ id: 'a', owner: 1 });
  pool.submit({ id: 'b', owner: 2 });
  pool.submit({ id: 'c', owner: 1 });
  await flush();
  pool.cancelOwnedBy(1);
  await flush();
  assert.deepEqual(log.done.map(([id]) => id).sort(), ['a', 'c']);
  assert.equal(pool.get('b').state, 'running');
});

test('a helper that cannot start is reported as failed and gives its place back', async () => {
  let calls = 0;
  const { pool, log } = makePool({
    open: (job) => {
      calls += 1;
      if (job.id === 'a') throw new Error('no tab');
    },
  });
  pool.submit({ id: 'a', owner: 1 });
  pool.submit({ id: 'b', owner: 1 });
  pool.submit({ id: 'c', owner: 1 });
  await flush();
  await flush();
  assert.equal(log.done[0][0], 'a');
  assert.equal(log.done[0][1], 'failed');
  assert.match(log.done[0][2], /no tab/);
  assert.equal(calls, 3);
  assert.equal(pool.active(), 2);
});

test('a helper that never finishes is stopped when its time is up', async () => {
  const { pool, log, timers } = makePool({ pool: { timeoutMs: 1234 } });
  pool.submit({ id: 'a', owner: 1 });
  await flush();
  assert.equal(timers[0].ms, 1234);
  timers[0].fn();
  assert.equal(log.done[0][1], 'timeout');
  assert.deepEqual(log.closed, ['a']);
});

test('finishing a helper cancels its timer', async () => {
  const { pool, timers } = makePool();
  pool.submit({ id: 'a', owner: 1 });
  await flush();
  pool.finish('a', { status: 'ok', text: '' });
  assert.equal(timers[0].cleared, true);
});
