'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCd, expandTarget, cdCommand, folderFrom, formatPrompt, pushHistory, stepHistory, MAX_HISTORY } = require('../../extension/lib/terminal-core.js');

test('a lone cd is recognized in every spelling, and the target is cleaned up', () => {
  assert.deepEqual(parseCd('cd'), { target: '' });
  assert.deepEqual(parseCd('  cd  '), { target: '' });
  assert.deepEqual(parseCd('cd ..'), { target: '..' });
  assert.deepEqual(parseCd('CD C:\\Users\\me'), { target: 'C:\\Users\\me' });
  assert.deepEqual(parseCd('cd "C:\\Program Files"'), { target: 'C:\\Program Files' });
  assert.deepEqual(parseCd("cd 'my folder'"), { target: 'my folder' });
  assert.deepEqual(parseCd('cd /d D:\\work'), { target: 'D:\\work' });
  assert.deepEqual(parseCd('Set-Location -LiteralPath C:\\temp'), { target: 'C:\\temp' });
  assert.deepEqual(parseCd('sl -Path src'), { target: 'src' });
  assert.deepEqual(parseCd('chdir src'), { target: 'src' });
  assert.deepEqual(parseCd('cd -'), { target: '-' });
  assert.deepEqual(parseCd('cd ~'), { target: '~' });
});

test('a cd joined to something else, or a command that only starts like one, is not a lone cd', () => {
  for (const command of ['cd src; npm test', 'cd src && npm test', 'cd src | more', 'cd src & dir', 'cd $(pwd)', 'cd `pwd`', 'cd a\nls', 'cdx src', 'echo cd', 'cdrom', 'slx', 'ls']) {
    assert.equal(parseCd(command), null, command);
  }
});

test('~ means the home folder, and only at the start of a target', () => {
  assert.equal(expandTarget('', 'C:\\Users\\me'), 'C:\\Users\\me');
  assert.equal(expandTarget('~', '/home/me'), '/home/me');
  assert.equal(expandTarget('~/work', '/home/me'), '/home/me/work');
  assert.equal(expandTarget('~\\work', 'C:\\Users\\me'), 'C:\\Users\\me\\work');
  assert.equal(expandTarget('src/~x', '/home/me'), 'src/~x');
  assert.equal(expandTarget('..', '/home/me'), '..');
});

test('the command that follows a cd quotes the target for its shell', () => {
  assert.equal(cdCommand('powershell', "it's here"), "Set-Location -LiteralPath 'it''s here'; (Get-Location).Path");
  assert.equal(cdCommand('pwsh', 'C:\\a b'), "Set-Location -LiteralPath 'C:\\a b'; (Get-Location).Path");
  assert.equal(cdCommand('bash', "it's here"), "cd -- 'it'\\''s here' && pwd");
  assert.equal(cdCommand('zsh', '-dash'), "cd -- '-dash' && pwd");
  assert.equal(cdCommand('cmd', 'D:\\x "y"'), 'cd /d "D:\\x y" && cd');
});

test('the folder is the last line the command printed', () => {
  assert.equal(folderFrom('C:\\Users\\me\\work\n'), 'C:\\Users\\me\\work');
  assert.equal(folderFrom('\n  \nnoise\n/home/me/work  \n\n'), '/home/me/work');
  assert.equal(folderFrom(''), '');
});

test('the prompt reads the way the shell writes it', () => {
  assert.equal(formatPrompt('C:\\Users\\me\\work', 'powershell', 'C:\\Users\\me', true), 'PS C:\\Users\\me\\work>');
  assert.equal(formatPrompt('D:\\x', 'cmd', 'C:\\Users\\me', true), 'D:\\x>');
  assert.equal(formatPrompt('/home/me/work', 'bash', '/home/me'), '~/work $');
  assert.equal(formatPrompt('/home/me', 'bash', '/home/me'), '~ $');
  assert.equal(formatPrompt('/home/mellow', 'bash', '/home/me'), '/home/mellow $');
  assert.equal(formatPrompt('c:\\users\\me\\src', 'bash', 'C:\\Users\\me', true), '~\\src $');
  assert.equal(formatPrompt('/tmp', 'zsh', ''), '/tmp $');
});

test('the history keeps the newest last, skips blanks and repeats, and stays bounded', () => {
  let history = [];
  history = pushHistory(history, 'ls');
  history = pushHistory(history, '   ');
  history = pushHistory(history, 'ls');
  history = pushHistory(history, 'pwd');
  history = pushHistory(history, ' ls ');
  assert.deepEqual(history, ['ls', 'pwd', 'ls']);
  for (let index = 0; index < MAX_HISTORY + 20; index += 1) history = pushHistory(history, `command ${index}`);
  assert.equal(history.length, MAX_HISTORY);
  assert.equal(history[history.length - 1], `command ${MAX_HISTORY + 19}`);
});

test('the arrow keys walk the history and come back to the line being typed', () => {
  const history = ['one', 'two', 'three'];
  let step = stepHistory(history, history.length, -1);
  assert.deepEqual(step, { index: 2, text: 'three' });
  step = stepHistory(history, step.index, -1);
  assert.deepEqual(step, { index: 1, text: 'two' });
  step = stepHistory(history, 0, -1);
  assert.deepEqual(step, { index: 0, text: 'one' });
  step = stepHistory(history, 1, 1);
  assert.deepEqual(step, { index: 2, text: 'three' });
  step = stepHistory(history, 2, 1);
  assert.deepEqual(step, { index: 3, text: null });
  assert.deepEqual(stepHistory(history, 3, 1), { index: 3, text: null });
  assert.deepEqual(stepHistory([], 0, -1), { index: 0, text: null });
});
