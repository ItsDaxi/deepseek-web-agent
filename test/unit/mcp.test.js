'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { createMcpManager, summarizeTool, formatCallResult, McpError } = require('../../host/mcp.js');

const FAKE = path.join(__dirname, '..', 'helpers', 'fake-mcp-server.js');

const stdioServer = (overrides = {}) => ({
  name: 'fake',
  source: 'claude',
  transport: 'stdio',
  command: process.execPath,
  args: [FAKE],
  env: {},
  startupTimeoutMs: 10000,
  toolTimeoutMs: 10000,
  enabledTools: null,
  disabledTools: [],
  ...overrides,
});

async function withManager(servers, body) {
  const manager = createMcpManager();
  try {
    await manager.configure({ servers, cwd: process.cwd() });
    await body(manager);
  } finally {
    manager.closeAll();
  }
}

test('starts a stdio server, lists all its tools (two pages) and calls one', async () => {
  await withManager([stdioServer()], async (manager) => {
    const [server] = manager.snapshot();
    assert.equal(server.status, 'ready');
    assert.deepEqual(server.tools.map((tool) => tool.name), ['echo', 'add', 'fail', 'slow', 'pid']);
    assert.ok(manager.isSettled());

    const echo = server.tools[0];
    assert.equal(echo.description, 'Gives the text back.');
    assert.deepEqual(echo.params, [{ name: 'text', type: 'string', required: true, description: 'What to repeat.' }]);
    assert.equal(echo.readOnly, true);
    assert.equal(server.tools[1].params[2].type, '"fast"|"exact"');

    assert.deepEqual(await manager.call({ server: 'fake', tool: 'echo', args: { text: 'hi' } }), { text: 'echo: hi', isError: false });
    assert.deepEqual(await manager.call({ server: 'fake', tool: 'add', args: { a: 2, b: 3 } }), { text: '5', isError: false });
  });
});

test('a tool that reports an error comes back as an error result, not an exception', async () => {
  await withManager([stdioServer()], async (manager) => {
    assert.deepEqual(await manager.call({ server: 'fake', tool: 'fail', args: {} }), { text: 'it failed on purpose', isError: true });
  });
});

test('names the problem when the server or the tool does not exist', async () => {
  await withManager([stdioServer()], async (manager) => {
    await assert.rejects(manager.call({ server: 'nope', tool: 'echo', args: {} }), /no MCP server called "nope"/);
    await assert.rejects(manager.call({ server: 'fake', tool: 'missing', args: {} }), /no tool called "missing".*echo, add/);
  });
});

test('enabled_tools and disabled_tools decide what the model is offered and may call', async () => {
  await withManager([stdioServer({ enabledTools: ['echo', 'add', 'fail'], disabledTools: ['fail'] })], async (manager) => {
    assert.deepEqual(manager.snapshot()[0].tools.map((tool) => tool.name), ['echo', 'add']);
    await assert.rejects(manager.call({ server: 'fake', tool: 'fail', args: {} }), /no tool called "fail"/);
  });
});

test('a call that takes too long times out, and one can be stopped', async () => {
  await withManager([stdioServer()], async (manager) => {
    await assert.rejects(
      manager.call({ server: 'fake', tool: 'slow', args: { ms: 5000 }, timeoutMs: 150 }),
      (error) => error instanceof McpError && error.code === 'timeout' && /did not answer/.test(error.message),
    );
    const controller = new AbortController();
    const call = manager.call({ server: 'fake', tool: 'slow', args: { ms: 5000 }, signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(call, (error) => error.code === 'aborted');
    // The server still works afterwards.
    assert.equal((await manager.call({ server: 'fake', tool: 'echo', args: { text: 'again' } })).text, 'echo: again');
  });
});

test('a command that does not exist fails that server only', async () => {
  await withManager([stdioServer({ name: 'broken', command: 'dsx-no-such-command-xyz', args: [] }), stdioServer()], async (manager) => {
    const [broken, fine] = manager.snapshot();
    assert.equal(broken.status, 'failed');
    assert.match(broken.error, /was not found|stopped/);
    assert.equal(fine.status, 'ready');
    await assert.rejects(manager.call({ server: 'broken', tool: 'x', args: {} }), /not running/);
  });
});

test('a server that is switched off or has a config error is listed but never started', async () => {
  await withManager([stdioServer({ name: 'off', disabled: true }), stdioServer({ name: 'bad', error: 'It has no command.' })], async (manager) => {
    const [off, bad] = manager.snapshot();
    assert.equal(off.status, 'disabled');
    assert.equal(bad.status, 'failed');
    assert.equal(bad.error, 'It has no command.');
    assert.ok(manager.isSettled());
  });
});

test('a server that dies after it started is shown as failed, and starts again on the next configure', async () => {
  const changes = [];
  const manager = createMcpManager({ onChange: () => changes.push(manager.snapshot()[0] && manager.snapshot()[0].status) });
  try {
    const server = stdioServer();
    await manager.configure({ servers: [server], cwd: process.cwd() });
    const pid = Number((await manager.call({ server: 'fake', tool: 'pid', args: {} })).text);
    process.kill(pid);
    const deadline = Date.now() + 5000;
    while (manager.snapshot()[0].status === 'ready' && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(manager.snapshot()[0].status, 'failed');
    assert.match(manager.snapshot()[0].error, /stopped/);
    await manager.configure({ servers: [server], cwd: process.cwd() });
    assert.equal(manager.snapshot()[0].status, 'ready');
    assert.equal((await manager.call({ server: 'fake', tool: 'echo', args: { text: 'back' } })).text, 'echo: back');
  } finally {
    manager.closeAll();
  }
});

test('the same server is not started twice', async () => {
  await withManager([stdioServer()], async (manager) => {
    const first = (await manager.call({ server: 'fake', tool: 'pid', args: {} })).text;
    await manager.configure({ servers: [stdioServer()], cwd: process.cwd() });
    assert.equal((await manager.call({ server: 'fake', tool: 'pid', args: {} })).text, first);
  });
});

test('closeAll ends the server processes', async () => {
  const manager = createMcpManager();
  await manager.configure({ servers: [stdioServer()], cwd: process.cwd() });
  const pid = Number((await manager.call({ server: 'fake', tool: 'pid', args: {} })).text);
  manager.closeAll();
  const deadline = Date.now() + 5000;
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

// ---- Streamable HTTP ----------------------------------------------------------------------------

function startHttpServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [FAKE, '--http', '0'], { stdio: ['ignore', 'pipe', 'inherit'] });
    child.on('error', reject);
    child.stdout.setEncoding('utf8').on('data', (text) => {
      const match = /listening (\d+)/.exec(text);
      if (match) resolve({ url: `http://127.0.0.1:${match[1]}/mcp`, stop: () => child.kill() });
    });
  });
}

test('talks to a streamable HTTP server, with JSON and event stream answers', async () => {
  const http = await startHttpServer();
  try {
    const server = { name: 'web', source: 'codex', transport: 'http', url: http.url, headers: { Authorization: 'Bearer secret' }, startupTimeoutMs: 10000, toolTimeoutMs: 10000, enabledTools: null, disabledTools: [] };
    await withManager([server], async (manager) => {
      assert.equal(manager.snapshot()[0].status, 'ready');
      assert.equal(manager.snapshot()[0].tools.length, 5);
      assert.deepEqual(await manager.call({ server: 'web', tool: 'echo', args: { text: 'over http' } }), { text: 'echo: over http', isError: false });
    });
  } finally {
    http.stop();
  }
});

test('an HTTP server that refuses the token says how to fix it', async () => {
  const http = await startHttpServer();
  try {
    const server = { name: 'web', source: 'codex', transport: 'http', url: http.url, headers: {}, startupTimeoutMs: 10000, toolTimeoutMs: 10000, enabledTools: null, disabledTools: [] };
    await withManager([server], async (manager) => {
      assert.equal(manager.snapshot()[0].status, 'failed');
      assert.match(manager.snapshot()[0].error, /HTTP 401.*token/);
    });
  } finally {
    http.stop();
  }
});

test('an HTTP server that is not there fails cleanly', async () => {
  const server = { name: 'web', source: 'codex', transport: 'http', url: 'http://127.0.0.1:1/mcp', headers: {}, startupTimeoutMs: 5000, toolTimeoutMs: 5000, enabledTools: null, disabledTools: [] };
  await withManager([server], async (manager) => {
    assert.equal(manager.snapshot()[0].status, 'failed');
    assert.match(manager.snapshot()[0].error, /Cannot reach/);
  });
});

// ---- What the model reads -----------------------------------------------------------------------

test('a result is turned into text', () => {
  assert.deepEqual(formatCallResult({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }), { text: 'a\nb', isError: false });
  assert.deepEqual(formatCallResult({ isError: true, content: [{ type: 'text', text: 'bad' }] }), { text: 'bad', isError: true });
  assert.match(formatCallResult({ content: [{ type: 'image', mimeType: 'image/png', data: 'AAAA' }] }).text, /image.*image\/png.*3 bytes, not shown/);
  assert.equal(formatCallResult({ content: [{ type: 'resource', resource: { uri: 'file:///x', text: 'inside' } }] }).text, 'inside');
  assert.match(formatCallResult({ content: [{ type: 'resource_link', uri: 'file:///x', name: 'X' }] }).text, /resource file:\/\/\/x \(X\)/);
  assert.equal(formatCallResult({ content: [], structuredContent: { n: 1 } }).text, '{\n  "n": 1\n}');
  assert.equal(formatCallResult(undefined).text, '');
});

test('a tool is summarised in a fixed small size', () => {
  const properties = {};
  for (let index = 0; index < 40; index += 1) properties[`p${index}`] = { type: ['string', 'null'], description: 'x'.repeat(500) };
  properties.list = { type: 'array', items: { type: 'integer' } };
  properties.either = { anyOf: [{ type: 'string' }, { type: 'number' }] };
  const summary = summarizeTool({ name: 't', description: 'd '.repeat(1000), inputSchema: { type: 'object', properties, required: ['p0'] } });
  assert.ok(summary.description.length <= 400);
  assert.equal(summary.params.length, 30);
  assert.equal(summary.moreParams, 12);
  assert.ok(summary.params.every((param) => param.description.length <= 120));
  assert.deepEqual(summary.params[0], { name: 'p0', type: 'string|null', required: true, description: summary.params[0].description });
  assert.equal(summarizeTool({ name: 't', inputSchema: { properties: { list: properties.list, either: properties.either } } }).params.map((p) => p.type).join(), 'array<integer>,string|number');
  assert.deepEqual(summarizeTool({ name: 'bare' }).params, []);
});

// ---- Windows commands ---------------------------------------------------------------------------

test('on Windows a bare command that is really a .cmd file is found on the PATH and started', { skip: process.platform !== 'win32' }, async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'dsx-cmd-'));
  // Like npx.cmd: a batch file that starts node, with a space in the path of what it runs.
  fs.writeFileSync(path.join(folder, 'dsx-fake-npx.cmd'), `@echo off\r\n"${process.execPath}" %*\r\n`);
  const env = { ...process.env, PATH: `${folder}${path.delimiter}${process.env.PATH}` };
  const manager = createMcpManager({ env });
  try {
    await manager.configure({ servers: [stdioServer({ command: 'dsx-fake-npx', args: [FAKE] })], cwd: process.cwd() });
    assert.equal(manager.snapshot()[0].status, 'ready', manager.snapshot()[0].error);
    assert.equal((await manager.call({ server: 'fake', tool: 'echo', args: { text: 'via cmd' } })).text, 'echo: via cmd');
  } finally {
    manager.closeAll();
  }
});
