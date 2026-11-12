'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseTodos, countDone, describeSaved, titleOf, MAX_TASKS } = require('../../extension/lib/todo.js');
const Protocol = require('../../extension/lib/protocol.js');
const { createToolScanner } = require('../../extension/lib/stream-filter.js');

test('parseTodos reads the three marks', () => {
  const tasks = parseTodos('[x] Read the config\n[~] Fix the parser\n[ ] Run the tests');
  assert.deepEqual(tasks, [
    { text: 'Read the config', status: 'done' },
    { text: 'Fix the parser', status: 'active' },
    { text: 'Run the tests', status: 'pending' },
  ]);
  assert.equal(countDone(tasks), 1);
});

test('parseTodos accepts the ways a model writes a checklist', () => {
  const tasks = parseTodos('- [X] one\n* [>] two\n1. [ ] three\n2) [] four\n  - [✓] five\n[-] six\nseven\n- eight');
  assert.deepEqual(tasks.map((task) => task.status), ['done', 'active', 'pending', 'pending', 'done', 'pending', 'pending', 'pending']);
  assert.deepEqual(tasks.map((task) => task.text), ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight']);
});

test('parseTodos skips blank lines and boxes with no text, and keeps one task active', () => {
  assert.deepEqual(parseTodos(''), []);
  assert.deepEqual(parseTodos(null), []);
  assert.deepEqual(parseTodos('\n\n[ ]\n[x]   \n'), []);
  const tasks = parseTodos('[~] first\n[~] second\n[ ] third');
  assert.deepEqual(tasks.map((task) => task.status), ['active', 'pending', 'pending']);
});

test('parseTodos limits how many tasks, and how long each one is', () => {
  const many = Array.from({ length: MAX_TASKS + 10 }, (_, index) => `[ ] task ${index}`).join('\n');
  assert.equal(parseTodos(many).length, MAX_TASKS);
  assert.equal(parseTodos(`[ ] ${'x'.repeat(1000)}`)[0].text.length, 200);
});

test('the answer to the model says how far the list is', () => {
  assert.equal(describeSaved([]), 'The task list is now empty.');
  assert.equal(describeSaved(parseTodos('[x] a\n[~] b\n[ ] c')), 'Task list saved: 1 of 3 done. Working on: b');
  assert.equal(describeSaved(parseTodos('[x] a\n[x] b')), 'Task list saved: 2 of 2 done. Every task is done.');
  assert.match(describeSaved(parseTodos('[x] a\n[ ] b')), /No task is marked as being worked on/);
  assert.equal(titleOf(parseTodos('[x] a\n[ ] b')), 'Tasks 1/2');
  assert.equal(titleOf([]), 'Tasks cleared');
});

test('todo is a tool the stream filter recognises, and the prompt teaches it', () => {
  assert.ok(Protocol.TOOL_NAMES.includes('todo'));
  const calls = [];
  const scanner = createToolScanner({ nextId: () => 't-1', onCall: (call) => calls.push(call) });
  const shown = scanner.push('On it.\n<dsx:todo>\n[~] one\n[ ] two\n</dsx:todo>\n<dsx:read path="a.js"></dsx:read>') + scanner.flush();
  assert.equal(calls[0].tool, 'todo');
  assert.equal(calls[0].command, '[~] one\n[ ] two');
  assert.doesNotMatch(shown, /\[~\]/);

  assert.match(Protocol.buildSystemPrompt({ platform: 'win32' }), /<dsx:todo>/);
  assert.match(Protocol.injectPrompt('x', { platform: 'win32' }, { full: false }), /<dsx:todo>/);
  // A helper's chat has no list on screen, so it is not taught the tag.
  assert.doesNotMatch(Protocol.buildSystemPrompt({ platform: 'win32' }, { agents: false }), /<dsx:todo>/);
  assert.doesNotMatch(Protocol.injectPrompt('x', { platform: 'win32' }, { full: false, agents: false }), /<dsx:todo>/);
  assert.equal(Protocol.stripInjected(Protocol.injectPrompt('x', { platform: 'win32' }, { full: true })), 'x');
});
