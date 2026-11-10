'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readMcpConfig, configPaths, ensureOwnMcpFile, fromClaude, fromCodex, expandVariables } = require('../../host/mcp-config.js');

function makeHome(files) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsx-mcp-config-'));
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(home, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  }
  return home;
}

const read = (home, cwd, env = {}) => readMcpConfig({ home, cwd, userDir: path.join(home, '.dsx'), env });

test('reads the user servers and the folder servers of ~/.claude.json', () => {
  const cwd = path.join(os.tmpdir(), 'some-project');
  const home = makeHome({
    '.claude.json': {
      mcpServers: { alpha: { type: 'stdio', command: 'npx', args: ['-y', 'alpha'], env: { KEY: 'v' } } },
      projects: {
        [cwd.replace(/\\/g, '/')]: { mcpServers: { beta: { command: 'node', args: ['b.js'] } }, disabledMcpServers: ['alpha'] },
        'C:/elsewhere': { mcpServers: { gamma: { command: 'node' } } },
      },
    },
  });
  const { servers, errors } = read(home, cwd);
  assert.deepEqual(errors, []);
  assert.deepEqual(servers.map((server) => server.name), ['beta', 'alpha']);
  const [beta, alpha] = servers;
  assert.equal(beta.command, 'node');
  assert.equal(beta.transport, 'stdio');
  assert.equal(alpha.disabled, true, 'a server the project turned off is marked, not dropped');
  assert.deepEqual(alpha.env, { KEY: 'v' });
});

test('reads ~/.codex/config.toml, with its timeouts and tool filters', () => {
  const home = makeHome({
    '.codex/config.toml': `
[mcp_servers.docs]
command = "npx"
args = ["-y", "docs-mcp"]
startup_timeout_sec = 90
tool_timeout_sec = 15
enabled_tools = ["search"]
[mcp_servers.docs.env]
TOKEN = "abc"

[mcp_servers.remote]
url = "https://example.com/mcp"
bearer_token_env_var = "REMOTE_TOKEN"
http_headers = { "X-One" = "1" }

[mcp_servers.off]
command = "x"
enabled = false
`,
  });
  const { servers } = read(home, undefined, { REMOTE_TOKEN: 'tok' });
  const byName = Object.fromEntries(servers.map((server) => [server.name, server]));
  assert.equal(byName.docs.source, 'codex');
  assert.equal(byName.docs.startupTimeoutMs, 90000);
  assert.equal(byName.docs.toolTimeoutMs, 15000);
  assert.deepEqual(byName.docs.enabledTools, ['search']);
  assert.deepEqual(byName.docs.env, { TOKEN: 'abc' });
  assert.equal(byName.remote.transport, 'http');
  assert.deepEqual(byName.remote.headers, { 'X-One': '1', Authorization: 'Bearer tok' });
  assert.equal(byName.off.disabled, true);
});

test('the same name in several places is used once: ~/.dsx first, then Claude Code, then Codex', () => {
  const home = makeHome({
    '.dsx/mcp.json': { mcpServers: { one: { command: 'dsx-one' } } },
    '.claude.json': { mcpServers: { one: { command: 'claude-one' }, two: { command: 'claude-two' } } },
    '.codex/config.toml': '[mcp_servers.one]\ncommand = "codex-one"\n[mcp_servers.two]\ncommand = "codex-two"\n[mcp_servers.three]\ncommand = "codex-three"\n',
  });
  const { servers } = read(home);
  const commands = Object.fromEntries(servers.map((server) => [server.name, server.command]));
  assert.deepEqual(commands, { one: 'dsx-one', two: 'claude-two', three: 'codex-three' });
});

test('a project .mcp.json or .codex/config.toml is never read', () => {
  const project = makeHome({
    '.mcp.json': { mcpServers: { planted: { command: 'calc.exe' } } },
    '.codex/config.toml': '[mcp_servers.planted2]\ncommand = "calc.exe"\n',
  });
  const home = makeHome({});
  assert.deepEqual(read(home, project).servers, []);
});

test('a broken file is reported and the others still load', () => {
  const home = makeHome({
    '.claude.json': '{ not json',
    '.codex/config.toml': '[mcp_servers.ok]\ncommand = "fine"\n',
  });
  const { servers, errors } = read(home);
  assert.deepEqual(servers.map((server) => server.name), ['ok']);
  assert.equal(errors.length, 1);
  assert.ok(errors[0].path.endsWith('.claude.json'));
});

test('missing files are not an error', () => {
  const { servers, errors, files } = read(makeHome({}));
  assert.deepEqual([servers, errors, files], [[], [], []]);
});

test('CODEX_HOME and CLAUDE_CONFIG_DIR move the files', () => {
  const home = makeHome({});
  const other = makeHome({ '.claude.json': { mcpServers: { c: { command: 'c' } } }, 'cfg/config.toml': '[mcp_servers.x]\ncommand = "x"\n' });
  const { servers } = read(home, undefined, { CLAUDE_CONFIG_DIR: other, CODEX_HOME: path.join(other, 'cfg') });
  assert.deepEqual(servers.map((server) => server.name).sort(), ['c', 'x']);
});

test('${NAME} and ${NAME:-fallback} are expanded for Claude style entries only', () => {
  const env = { HOME_DIR: '/h' };
  assert.equal(expandVariables('${HOME_DIR}/x ${NOPE:-fb} ${NOPE}', env), '/h/x fb ${NOPE}');
  process.env.DSX_TEST_VAR = 'expanded';
  try {
    assert.equal(fromClaude('a', { command: '${DSX_TEST_VAR}', args: ['${DSX_TEST_VAR}'] }, 'claude').command, 'expanded');
    assert.equal(fromCodex('a', { command: '${DSX_TEST_VAR}' }).command, '${DSX_TEST_VAR}');
  } finally {
    delete process.env.DSX_TEST_VAR;
  }
});

test('entries that cannot run say why', () => {
  assert.match(fromClaude('a', { type: 'stdio' }, 'claude').error, /no command/);
  assert.match(fromClaude('a', { type: 'sse', url: 'https://x' }, 'claude').error, /SSE/);
  assert.match(fromClaude('a', { type: 'websocket' }, 'claude').error, /not supported/);
  assert.match(fromCodex('a', {}).error, /neither a command nor a url/);
  assert.equal(fromClaude('a', { url: 'https://x/mcp' }, 'claude').transport, 'http');
});

test('an empty ~/.dsx/mcp.json is created when there is none, and an existing one is never touched', () => {
  const home = makeHome({});
  const paths = configPaths({ home, userDir: path.join(home, '.dsx'), env: {} });
  assert.equal(fs.existsSync(paths.userDir), false);
  assert.equal(ensureOwnMcpFile(paths), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(paths.mcp, 'utf8')), { mcpServers: {} });
  assert.deepEqual(read(home).servers, [], 'the empty file adds no server');
  fs.writeFileSync(paths.mcp, '{"mcpServers":{"mine":{"command":"x"}}}');
  assert.equal(ensureOwnMcpFile(paths), false);
  assert.deepEqual(read(home).servers.map((server) => server.name), ['mine']);
});

test('a folder that cannot be created is not an error', () => {
  const home = makeHome({ blocker: 'a file where the folder should go' });
  assert.equal(ensureOwnMcpFile(configPaths({ home, userDir: path.join(home, 'blocker', '.dsx'), env: {} })), false);
});
