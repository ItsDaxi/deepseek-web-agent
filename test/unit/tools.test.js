'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runTool, globToRegExp } = require('../../host/tools.js');

function workspace() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dsx-tools-'));
  fs.mkdirSync(path.join(cwd, 'src', 'deep'), { recursive: true });
  fs.mkdirSync(path.join(cwd, 'node_modules', 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'src', 'app.js'), 'function main() {\n  return 1;\n}\n');
  fs.writeFileSync(path.join(cwd, 'src', 'deep', 'util.ts'), 'export const value = 2;\n');
  fs.writeFileSync(path.join(cwd, 'node_modules', 'pkg', 'index.js'), 'function main() {}\n');
  fs.writeFileSync(path.join(cwd, '.env'), 'SECRET=function main\n');
  return cwd;
}

const run = (tool, fields) => runTool({ tool, ...fields });

test('read numbers lines and supports offset and limit', () => {
  const cwd = workspace();
  const all = run('read', { cwd, path: 'src/app.js' });
  assert.equal(all.status, 'ok');
  assert.equal(all.output, '1\tfunction main() {\n2\t  return 1;\n3\t}');
  const part = run('read', { cwd, path: 'src/app.js', offset: '2', limit: '1' });
  assert.match(part.output, /^2\t {2}return 1;\n\[Showing lines 2-2 of 3/);
});

test('read explains missing files, folders and binary files', () => {
  const cwd = workspace();
  assert.match(run('read', { cwd, path: 'nope.txt' }).output, /File not found/);
  assert.match(run('read', { cwd, path: 'src' }).output, /is a folder/);
  fs.writeFileSync(path.join(cwd, 'data.bin'), Buffer.from([1, 0, 2]));
  const binary = run('read', { cwd, path: 'data.bin' });
  assert.equal(binary.status, 'failed');
  assert.match(binary.output, /binary/);
});

test('long files stop within the output budget and say how to continue', () => {
  const cwd = workspace();
  fs.writeFileSync(path.join(cwd, 'long.txt'), Array.from({ length: 5000 }, (_, i) => `line number ${i}`).join('\n'));
  const result = run('read', { cwd, path: 'long.txt' });
  assert.ok(result.output.length < 20000);
  assert.match(result.output, /Use offset to read more/);
});

test('write creates folders and reports what it did', () => {
  const cwd = workspace();
  const created = run('write', { cwd, path: 'new/dir/file.txt', body: 'caffè €\n' });
  assert.match(created.output, /^Created/);
  assert.equal(fs.readFileSync(path.join(cwd, 'new', 'dir', 'file.txt'), 'utf8'), 'caffè €\n');
  assert.match(run('write', { cwd, path: 'new/dir/file.txt', body: 'x' }).output, /^Replaced/);
});

const editBody = (oldText, newText) => `<dsx:old>${oldText}</dsx:old><dsx:new>${newText}</dsx:new>`;

test('edit replaces unique text and refuses ambiguous text', () => {
  const cwd = workspace();
  const file = path.join(cwd, 'a.txt');
  fs.writeFileSync(file, 'one two two');
  assert.equal(run('edit', { cwd, path: 'a.txt', body: editBody('one', 'ONE') }).status, 'ok');
  assert.equal(fs.readFileSync(file, 'utf8'), 'ONE two two');

  const ambiguous = run('edit', { cwd, path: 'a.txt', body: editBody('two', '2') });
  assert.equal(ambiguous.status, 'failed');
  assert.match(ambiguous.output, /appears 2 times/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'ONE two two');

  assert.match(run('edit', { cwd, path: 'a.txt', replace_all: 'true', body: editBody('two', '2') }).output, /2 replacements/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'ONE 2 2');
  assert.match(run('edit', { cwd, path: 'a.txt', body: editBody('zzz', 'y') }).output, /not found/);
});

test('edit matches Windows line endings when the model writes plain newlines', () => {
  const cwd = workspace();
  const file = path.join(cwd, 'crlf.txt');
  fs.writeFileSync(file, 'a\r\nb\r\nc\r\n');
  assert.equal(run('edit', { cwd, path: 'crlf.txt', body: editBody('a\nb', 'x\ny') }).status, 'ok');
  assert.equal(fs.readFileSync(file, 'utf8'), 'x\r\ny\r\nc\r\n');
});

test('glob patterns match the expected paths', () => {
  assert.ok(globToRegExp('**/*.js').test('a/b/c.js'));
  assert.ok(globToRegExp('**/*.js').test('c.js'));
  assert.ok(!globToRegExp('*.js').test('a/c.js'));
  assert.ok(globToRegExp('src/*.{js,ts}').test('src/a.ts'));
  assert.ok(!globToRegExp('src/?.js').test('src/ab.js'));
});

test('glob finds files, skipping dependencies and secrets', () => {
  const cwd = workspace();
  const result = run('glob', { cwd, body: '**/*' });
  assert.match(result.output, /src\/app\.js/);
  assert.match(result.output, /src\/deep\/util\.ts/);
  assert.doesNotMatch(result.output, /node_modules/);
  assert.doesNotMatch(result.output, /\.env/);
  assert.match(run('glob', { cwd, body: '**/*.py' }).output, /No files match/);
});

test('grep searches contents, skipping dependencies and secrets', () => {
  const cwd = workspace();
  const result = run('grep', { cwd, body: 'function\\s+main' });
  assert.equal(result.output, 'src/app.js:1:function main() {');
  assert.equal(run('grep', { cwd, body: 'FUNCTION', ignore_case: 'true', glob: '*.js' }).output, 'src/app.js:1:function main() {');
  assert.match(run('grep', { cwd, body: 'FUNCTION' }).output, /No matches/);
  assert.match(run('grep', { cwd, body: 'return', context: '1' }).output, /app\.js:1:[\s\S]*app\.js:2:[\s\S]*app\.js:3:/);
  assert.match(run('grep', { cwd, body: '(' }).output, /Invalid regular expression/);
});

function startHost() {
  const child = spawn(process.execPath, [path.join(__dirname, '..', '..', 'host', 'host.js')], { stdio: ['pipe', 'pipe', 'ignore'] });
  const messages = [];
  let buffer = Buffer.alloc(0);
  child.stdout.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE(0)) {
      const size = buffer.readUInt32LE(0);
      messages.push(JSON.parse(buffer.subarray(4, 4 + size).toString('utf8')));
      buffer = buffer.subarray(4 + size);
    }
  });
  const send = (message) => {
    const payload = Buffer.from(JSON.stringify(message));
    const header = Buffer.alloc(4);
    header.writeUInt32LE(payload.length);
    child.stdin.write(Buffer.concat([header, payload]));
  };
  const exitOf = async (id) => {
    for (let waited = 0; waited < 15000; waited += 25) {
      const exit = messages.find((message) => message.type === 'exit' && message.id === id);
      if (exit) return exit;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`No exit for ${id}: ${JSON.stringify(messages)}`);
  };
  return { send, exitOf, messages, stop: () => child.stdin.end() };
}

test('the host runs file tools like commands', async () => {
  const cwd = workspace();
  const host = startHost();
  host.send({ type: 'exec', id: 'r1', tool: 'read', cwd, path: 'src/app.js' });
  const exit = await host.exitOf('r1');
  assert.equal(exit.status, 'ok');
  const output = host.messages.filter((m) => m.type === 'output' && m.id === 'r1').map((m) => m.data).join('');
  assert.match(output, /function main/);

  host.send({ type: 'exec', id: 'r2', tool: 'read', cwd, path: 'missing.txt' });
  const failed = await host.exitOf('r2');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.code, 1);
  host.stop();
});

test('a regular expression that never finishes can be timed out', async () => {
  const cwd = workspace();
  fs.writeFileSync(path.join(cwd, 'evil.txt'), `${'a'.repeat(40)}!`);
  const host = startHost();
  host.send({ type: 'exec', id: 'slow', tool: 'grep', cwd, body: '(a+)+$', path: 'evil.txt', timeoutMs: 700 });
  assert.equal((await host.exitOf('slow')).status, 'timeout');
  host.stop();
});
