'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parse } = require('../../host/toml.js');

test('reads a Codex style MCP config', () => {
  const data = parse(`
# top comment
model = "gpt-5"   # trailing comment

[mcp_servers.node_repl]
args = []
command = 'C:\\Users\\me\\bin\\node_repl.exe'
env_vars = ["A", "B"]
startup_timeout_sec = 120

[mcp_servers.node_repl.env]
NODE_PATH = 'C:\\x\\node.exe'
FLAG = "1000"

[mcp_servers.Roblox_Studio]
args = ["/c", "cd /d %LOCALAPPDATA%\\\\Roblox && .\\\\mcp.bat"]
command = "cmd.exe"
`);
  assert.equal(data.model, 'gpt-5');
  const repl = data.mcp_servers.node_repl;
  assert.equal(repl.command, 'C:\\Users\\me\\bin\\node_repl.exe');
  assert.deepEqual(repl.args, []);
  assert.deepEqual(repl.env_vars, ['A', 'B']);
  assert.equal(repl.startup_timeout_sec, 120);
  assert.deepEqual(repl.env, { NODE_PATH: 'C:\\x\\node.exe', FLAG: '1000' });
  assert.deepEqual(data.mcp_servers.Roblox_Studio.args, ['/c', 'cd /d %LOCALAPPDATA%\\Roblox && .\\mcp.bat']);
});

test('reads numbers, booleans, nested arrays, inline tables and dotted keys', () => {
  const data = parse(`
count = 1_000
ratio = -1.5e2
on = true
off = false
hex = 0xFF
list = [
  1, 2,   # a comment inside
  [3, 4],
]
inline = { a = 1, "b c" = "x", nested = { d = [1] } }
a.b.c = "deep"
when = 2024-05-01T10:00:00Z
[quoted."key with spaces"]
v = "ok"
`);
  assert.equal(data.count, 1000);
  assert.equal(data.ratio, -150);
  assert.equal(data.on, true);
  assert.equal(data.off, false);
  assert.equal(data.hex, 255);
  assert.deepEqual(data.list, [1, 2, [3, 4]]);
  assert.deepEqual(data.inline, { a: 1, 'b c': 'x', nested: { d: [1] } });
  assert.equal(data.a.b.c, 'deep');
  assert.equal(data.when, '2024-05-01T10:00:00Z');
  assert.equal(data.quoted['key with spaces'].v, 'ok');
});

test('reads escapes and multi-line strings', () => {
  const data = parse('a = "tab\\there \\u00e9 \\"q\\""\nb = """\nline one\nline two"""\nc = \'\'\'\nraw \\n stays\'\'\'\n');
  assert.equal(data.a, 'tab\there é "q"');
  assert.equal(data.b, 'line one\nline two');
  assert.equal(data.c, 'raw \\n stays');
});

test('reads arrays of tables', () => {
  const data = parse('[[item]]\nname = "a"\n[[item]]\nname = "b"\n[item.extra]\nk = 1\n');
  assert.deepEqual(data.item, [{ name: 'a' }, { name: 'b', extra: { k: 1 } }]);
});

test('names the line of a mistake', () => {
  assert.throws(() => parse('a = 1\nb = \n'), /line 2/);
  assert.throws(() => parse('a = "open\n'), /line 1/);
  assert.throws(() => parse('a = 1\na = 2\n'), /defined twice/);
  assert.throws(() => parse('[t]\nx = 1 2\n'), /line 2/);
  assert.throws(() => parse('x = nope\n'), /cannot read the value/);
});
