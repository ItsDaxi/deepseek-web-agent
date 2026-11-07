'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parse, filter, plan } = require('../../extension/lib/slash-match.js');

const commands = [
  { name: 'help', description: 'Show the commands' },
  { name: 'mode', description: 'Switch mode', args: [{ value: 'manual', description: 'Ask first' }, { value: 'bypass', description: 'Never ask' }] },
  { name: 'cd', description: 'Choose the folder' },
  { name: 'status', description: 'Show the state' },
  { name: 'thinking', description: 'Thinking blocks', args: [{ value: 'collapse', description: 'Keep closed' }, { value: 'default', description: 'Leave them' }] },
  { name: 'update', description: 'Look for a new version' },
];

test('a lone slash, or a slash word, is a command being typed', () => {
  assert.deepEqual(parse('/'), { kind: 'command', query: '' });
  assert.deepEqual(parse('/Mo'), { kind: 'command', query: 'mo' });
  assert.deepEqual(parse('/mode b'), { kind: 'argument', name: 'mode', query: 'b' });
  assert.deepEqual(parse('/mode '), { kind: 'argument', name: 'mode', query: '' });
});

test('anything else that starts with a slash is a message', () => {
  for (const text of ['', 'hello', ' /mode', '/etc/hosts', '/mode bypass now', '/mode\nbypass', 'what is /mode', '//']) {
    assert.deepEqual(parse(text), { kind: 'none' }, JSON.stringify(text));
  }
  assert.equal(parse(null).kind, 'none');
});

test('names that start with the query come before names that only contain it', () => {
  const names = filter(commands, 't', 'name').map((command) => command.name);
  assert.deepEqual(names, ['thinking', 'status', 'update']);
  assert.deepEqual(filter(commands, '', 'name').length, commands.length);
  assert.deepEqual(filter(commands, 'zzz', 'name'), []);
});

test('a lone slash lists every command, and Tab completes the highlighted one', () => {
  const result = plan(commands, '/', 0);
  assert.equal(result.items.length, commands.length);
  assert.equal(result.selected.name, 'help');
  assert.equal(result.completion, '/help');
  assert.deepEqual(result.run, { name: 'help', arg: '' });
});

test('a command that needs an argument is completed, not run, by Enter', () => {
  const result = plan(commands, '/mo');
  assert.equal(result.selected.name, 'mode');
  assert.equal(result.completion, '/mode ');
  assert.equal(result.run, null);
});

test('the highlighted index moves through the suggestions and stays in range', () => {
  assert.equal(plan(commands, '/', 2).selected.name, 'cd');
  assert.equal(plan(commands, '/', 99).selected.name, 'update');
  assert.equal(plan(commands, '/', -5).selected.name, 'help');
});

test('text that matches no command is left for DeepSeek', () => {
  assert.equal(plan(commands, '/zzz'), null);
  assert.equal(plan(commands, '/etc/hosts'), null);
  assert.equal(plan(commands, 'hello'), null);
  assert.equal(plan(commands, ''), null);
});

test('arguments are suggested for a command that takes them', () => {
  const result = plan(commands, '/mode ');
  assert.deepEqual(result.items.map((item) => item.value), ['manual', 'bypass']);
  assert.equal(result.selected.value, 'manual');
  assert.deepEqual(result.run, { name: 'mode', arg: 'manual' });

  const typed = plan(commands, '/mode by');
  assert.equal(typed.selected.value, 'bypass');
  assert.equal(typed.completion, '/mode bypass');
  assert.deepEqual(typed.run, { name: 'mode', arg: 'bypass' });
});

test('an argument that matches nothing is run as typed, for the command to refuse', () => {
  const result = plan(commands, '/mode fast');
  assert.deepEqual(result.items, []);
  assert.equal(result.selected, null);
  assert.deepEqual(result.run, { name: 'mode', arg: 'fast' });
});

test('words after a command that takes no argument are a message', () => {
  assert.equal(plan(commands, '/help me'), null);
  assert.equal(plan(commands, '/status now'), null);
  assert.equal(plan(commands, '/nothing here'), null);
});

test('commands with a group are kept together, in the order of their groups', () => {
  const grouped = [
    { name: 'file', group: 'Add', description: '' },
    { name: 'permission', group: 'Commands', description: 'Presets' },
    { name: 'plan', group: 'Add', description: 'Plan mode' },
    { name: 'export', group: 'Commands', description: 'Download' },
  ];
  assert.deepEqual(plan(grouped, '/').items.map((item) => item.name), ['file', 'plan', 'permission', 'export']);
  // "p" starts permission and plan and is inside export. The best match leads, and each group stays whole.
  assert.deepEqual(plan(grouped, '/p').items.map((item) => item.name), ['permission', 'export', 'plan']);
  assert.equal(plan(grouped, '/perm').selected.name, 'permission');
});
