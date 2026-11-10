'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOST = path.join(__dirname, '..', '..', 'host', 'host.js');
const FAKE = path.join(__dirname, '..', 'helpers', 'fake-mcp-server.js');

// A host whose home folder is a new empty one, so the real Claude Code and Codex setups are never read.
function startHost(files = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsx-host-mcp-'));
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(home, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  }
  const env = { ...process.env, HOME: home, USERPROFILE: home, DSX_USER_DIR: path.join(home, '.dsx'), CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: home };
  const child = spawn(process.execPath, [HOST], { stdio: ['pipe', 'pipe', 'inherit'], env });
  const messages = [];
  const waiters = [];
  let buffer = Buffer.alloc(0);
  child.stdout.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const size = buffer.readUInt32LE(0);
      if (buffer.length < 4 + size) break;
      messages.push(JSON.parse(buffer.subarray(4, 4 + size).toString('utf8')));
      buffer = buffer.subarray(4 + size);
    }
    for (const waiter of [...waiters]) waiter();
  });
  return {
    home,
    messages,
    send(message) {
      const payload = Buffer.from(JSON.stringify(message));
      const header = Buffer.alloc(4);
      header.writeUInt32LE(payload.length);
      child.stdin.write(Buffer.concat([header, payload]));
    },
    waitFor(predicate, timeoutMs = 30000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out: ${JSON.stringify(messages).slice(0, 2000)}`)), timeoutMs);
        const check = () => {
          const match = messages.find(predicate);
          if (!match) return;
          clearTimeout(timer);
          waiters.splice(waiters.indexOf(check), 1);
          resolve(match);
        };
        waiters.push(check);
        check();
      });
    },
    stop() {
      child.stdin.end();
    },
  };
}

const exited = (id) => (message) => message.type === 'exit' && message.id === id;
const outputOf = (host, id) => host.messages.filter((m) => m.type === 'output' && m.id === id).map((m) => m.data).join('');

// The snapshot the host sent last, put together from its pieces.
function lastSnapshot(host, id) {
  const pieces = host.messages.filter((m) => m.type === 'mcp-servers' && m.id === id);
  const last = [];
  for (const piece of pieces) {
    if (piece.part === 0) last.length = 0;
    last.push(piece);
  }
  return { servers: JSON.parse(last.map((piece) => piece.text).join('')), done: last[last.length - 1].done, last };
}

const fakeConfig = { '.dsx/mcp.json': { mcpServers: { fake: { command: process.execPath, args: [FAKE] } } } };

test('the host says it can do MCP', async () => {
  const host = startHost();
  host.send({ type: 'hello' });
  const hello = await host.waitFor((m) => m.type === 'hello');
  assert.ok(hello.features.includes('mcp'));
  // It says where the config files are, so the model can be told.
  assert.equal(hello.config.userDir, path.join(host.home, '.dsx'));
  assert.equal(hello.config.mcp, path.join(host.home, '.dsx', 'mcp.json'));
  assert.equal(hello.config.claude, path.join(host.home, '.claude.json'));
  assert.equal(hello.config.codex, path.join(host.home, '.codex', 'config.toml'));
  host.stop();
});

test('lists the servers of the config, then calls a tool', async () => {
  const host = startHost(fakeConfig);
  try {
    host.send({ type: 'mcp-list', id: 'list-1', cwd: host.home });
    await host.waitFor((m) => m.type === 'mcp-servers' && m.done === true);
    const { servers } = lastSnapshot(host, 'list-1');
    assert.equal(servers.length, 1);
    assert.equal(servers[0].name, 'fake');
    assert.equal(servers[0].status, 'ready');
    assert.deepEqual(servers[0].tools.map((tool) => tool.name), ['echo', 'add', 'fail', 'slow', 'pid']);

    host.send({ type: 'exec', id: 'call-1', tool: 'mcp', server: 'fake', mcpTool: 'echo', body: '{"text": "from the host"}' });
    const exit = await host.waitFor(exited('call-1'));
    assert.equal(exit.status, 'ok');
    assert.equal(exit.code, 0);
    assert.equal(outputOf(host, 'call-1'), 'echo: from the host');
    assert.ok(host.messages.some((m) => m.type === 'started' && m.id === 'call-1'));
  } finally {
    host.stop();
  }
});

test('a tool error, bad arguments, a bad name and a missing server all come back as failed calls', async () => {
  const host = startHost(fakeConfig);
  try {
    host.send({ type: 'mcp-list', id: 'list-2', cwd: host.home });
    await host.waitFor((m) => m.type === 'mcp-servers' && m.done === true);

    host.send({ type: 'exec', id: 'e1', tool: 'mcp', server: 'fake', mcpTool: 'fail', body: '' });
    assert.deepEqual([(await host.waitFor(exited('e1'))).status, outputOf(host, 'e1')], ['failed', 'it failed on purpose']);

    host.send({ type: 'exec', id: 'e2', tool: 'mcp', server: 'fake', mcpTool: 'echo', body: '{not json' });
    assert.equal((await host.waitFor(exited('e2'))).status, 'failed');
    assert.match(outputOf(host, 'e2'), /not valid JSON/);

    host.send({ type: 'exec', id: 'e3', tool: 'mcp', server: 'fake', mcpTool: 'nothing', body: '{}' });
    assert.equal((await host.waitFor(exited('e3'))).status, 'failed');
    assert.match(outputOf(host, 'e3'), /no tool called "nothing"/);

    host.send({ type: 'exec', id: 'e4', tool: 'mcp', server: 'ghost', mcpTool: 'echo', body: '{}' });
    assert.equal((await host.waitFor(exited('e4'))).status, 'failed');
    assert.match(outputOf(host, 'e4'), /no MCP server called "ghost"/);

    host.send({ type: 'exec', id: 'e5', tool: 'mcp', server: 'fake', mcpTool: 'echo', body: '```json\n{"text": "fenced"}\n```' });
    assert.equal((await host.waitFor(exited('e5'))).status, 'ok');
    assert.equal(outputOf(host, 'e5'), 'echo: fenced');
  } finally {
    host.stop();
  }
});

test('a call can be stopped, and a slow one times out', async () => {
  const host = startHost(fakeConfig);
  try {
    host.send({ type: 'mcp-list', id: 'list-3', cwd: host.home });
    await host.waitFor((m) => m.type === 'mcp-servers' && m.done === true);

    host.send({ type: 'exec', id: 's1', tool: 'mcp', server: 'fake', mcpTool: 'slow', body: '{"ms": 5000}' });
    await host.waitFor((m) => m.type === 'started' && m.id === 's1');
    host.send({ type: 'kill', id: 's1' });
    assert.equal((await host.waitFor(exited('s1'))).status, 'stopped');

    host.send({ type: 'exec', id: 's2', tool: 'mcp', server: 'fake', mcpTool: 'slow', body: '{"ms": 5000}', timeoutMs: 200 });
    assert.equal((await host.waitFor(exited('s2'))).status, 'timeout');
  } finally {
    host.stop();
  }
});

test('with no config the answer is an empty list, and a broken file is named', async () => {
  const empty = startHost();
  empty.send({ type: 'mcp-list', id: 'none', cwd: empty.home });
  await empty.waitFor((m) => m.type === 'mcp-servers' && m.done === true);
  assert.deepEqual(lastSnapshot(empty, 'none').servers, []);
  empty.stop();

  const broken = startHost({ '.codex/config.toml': 'this is = = not toml' });
  broken.send({ type: 'mcp-list', id: 'bad', cwd: broken.home });
  const reply = await broken.waitFor((m) => m.type === 'mcp-servers' && m.done === true);
  assert.equal(reply.errors.length, 1);
  assert.match(reply.errors[0].message, /TOML error/);
  broken.stop();
});

test('the servers end with the host', async () => {
  const host = startHost(fakeConfig);
  host.send({ type: 'mcp-list', id: 'list-4', cwd: host.home });
  await host.waitFor((m) => m.type === 'mcp-servers' && m.done === true);
  host.send({ type: 'exec', id: 'p1', tool: 'mcp', server: 'fake', mcpTool: 'pid', body: '{}' });
  await host.waitFor(exited('p1'));
  const pid = Number(outputOf(host, 'p1'));
  host.stop();
  const deadline = Date.now() + 8000;
  let alive = true;
  while (alive && Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await new Promise((resolve) => setTimeout(resolve, 50));
    } catch {
      alive = false;
    }
  }
  assert.equal(alive, false);
});
