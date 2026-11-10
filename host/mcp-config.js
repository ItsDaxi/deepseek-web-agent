// Finds the MCP servers the user already set up for Claude Code and for Codex, and reads them into one shape.
//
// Only the user's own files are read, in fixed places: ~/.claude.json (its user servers and the ones of the
// working folder), ~/.codex/config.toml and ~/.dsx/mcp.json. A .mcp.json or .codex/config.toml inside a
// project is NOT read: it would start a program named by a folder the user may have just downloaded.
// When the same name is set up in several places, ~/.dsx/mcp.json wins, then Claude Code, then Codex.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const toml = require('./toml.js');

const IS_WINDOWS = process.platform === 'win32';
// How long a server may take to start and to answer a call, when its config does not say.
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_TOOL_TIMEOUT_MS = 120_000;

const asObject = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
const asStringList = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []);

function asStringMap(value) {
  const out = {};
  for (const [key, item] of Object.entries(asObject(value))) {
    if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') out[key] = String(item);
  }
  return out;
}

// Claude Code lets a value say ${NAME} or ${NAME:-fallback}. An unset name with no fallback is left as it is.
function expandVariables(text, env = process.env) {
  return String(text).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (whole, name, fallback) => {
    if (env[name] !== undefined && env[name] !== '') return env[name];
    return fallback !== undefined ? fallback : whole;
  });
}

function expandMap(map) {
  return Object.fromEntries(Object.entries(map).map(([key, value]) => [key, expandVariables(value)]));
}

function secondsToMs(seconds, millis, fallback) {
  if (Number.isFinite(seconds) && seconds > 0) return Math.round(seconds * 1000);
  if (Number.isFinite(millis) && millis > 0) return Math.round(millis);
  return fallback;
}

// One entry of a Claude Code (or .mcp.json style) file.
function fromClaude(name, entry, source) {
  const raw = asObject(entry);
  const type = typeof raw.type === 'string' ? raw.type : raw.command ? 'stdio' : raw.url ? 'http' : '';
  const base = { name, source, startupTimeoutMs: DEFAULT_STARTUP_TIMEOUT_MS, toolTimeoutMs: DEFAULT_TOOL_TIMEOUT_MS, enabledTools: null, disabledTools: [] };
  if (type === 'stdio') {
    if (typeof raw.command !== 'string' || !raw.command.trim()) return { ...base, transport: 'stdio', error: 'It has no command.' };
    return {
      ...base,
      transport: 'stdio',
      command: expandVariables(raw.command),
      args: asStringList(raw.args).map((arg) => expandVariables(arg)),
      env: expandMap(asStringMap(raw.env)),
    };
  }
  if (type === 'http' || type === 'streamable-http' || type === 'sse') {
    if (typeof raw.url !== 'string' || !raw.url.trim()) return { ...base, transport: 'http', error: 'It has no url.' };
    if (type === 'sse') return { ...base, transport: 'http', url: expandVariables(raw.url), error: 'The old SSE transport is not supported, only stdio and streamable HTTP.' };
    return { ...base, transport: 'http', url: expandVariables(raw.url), headers: expandMap(asStringMap(raw.headers)) };
  }
  return { ...base, transport: type || 'unknown', error: `The server type "${type || 'none'}" is not supported.` };
}

// One [mcp_servers.name] table of Codex's config.toml.
function fromCodex(name, entry, env = process.env) {
  const raw = asObject(entry);
  const base = {
    name,
    source: 'codex',
    startupTimeoutMs: secondsToMs(raw.startup_timeout_sec, raw.startup_timeout_ms, DEFAULT_STARTUP_TIMEOUT_MS),
    toolTimeoutMs: secondsToMs(raw.tool_timeout_sec, null, DEFAULT_TOOL_TIMEOUT_MS),
    enabledTools: Array.isArray(raw.enabled_tools) ? asStringList(raw.enabled_tools) : null,
    disabledTools: asStringList(raw.disabled_tools),
  };
  if (raw.enabled === false) return { ...base, transport: 'stdio', disabled: true };
  if (typeof raw.command === 'string' && raw.command.trim()) {
    return {
      ...base,
      transport: 'stdio',
      command: raw.command,
      args: asStringList(raw.args),
      env: asStringMap(raw.env),
      cwd: typeof raw.cwd === 'string' ? raw.cwd : undefined,
    };
  }
  if (typeof raw.url === 'string' && raw.url.trim()) {
    const headers = asStringMap(raw.http_headers);
    // env_http_headers maps a header to the name of the variable that holds its value.
    for (const [header, variable] of Object.entries(asStringMap(raw.env_http_headers))) {
      if (env[variable]) headers[header] = env[variable];
    }
    if (typeof raw.bearer_token_env_var === 'string' && env[raw.bearer_token_env_var]) {
      headers.Authorization = `Bearer ${env[raw.bearer_token_env_var]}`;
    }
    return { ...base, transport: 'http', url: raw.url, headers };
  }
  return { ...base, transport: 'stdio', error: 'It has neither a command nor a url.' };
}

function readFile(file) {
  try {
    return fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

const samePath = (a, b) => {
  const clean = (value) => path.resolve(String(value)).replace(/[\\/]+$/, '').replace(/\\/g, '/');
  return IS_WINDOWS ? clean(a).toLowerCase() === clean(b).toLowerCase() : clean(a) === clean(b);
};

// Where each config file is. The model is told these paths, so it can edit them when the user asks.
function configPaths({ home = os.homedir(), userDir = path.join(home, '.dsx'), env = process.env } = {}) {
  return {
    userDir,
    instructions: path.join(userDir, 'AGENTS.md'),
    mcp: path.join(userDir, 'mcp.json'),
    claude: env.CLAUDE_CONFIG_DIR ? path.join(env.CLAUDE_CONFIG_DIR, '.claude.json') : path.join(home, '.claude.json'),
    codex: path.join(env.CODEX_HOME || path.join(home, '.codex'), 'config.toml'),
  };
}

// Makes sure ~/.dsx/mcp.json exists, empty, so there is a place for the user (or the model, when asked) to add a
// server. A file that is already there is never touched. Returns true when it was created.
function ensureOwnMcpFile(paths) {
  try {
    if (fs.existsSync(paths.mcp)) return false;
    fs.mkdirSync(paths.userDir, { recursive: true });
    fs.writeFileSync(paths.mcp, `${JSON.stringify({ mcpServers: {} }, null, 2)}
`, { encoding: 'utf8', flag: 'wx' });
    return true;
  } catch {
    return false; // A folder that cannot be written is not a reason to stop listing the servers.
  }
}

// The places to look in, each with how to read it. `cwd` picks the folder entry of ~/.claude.json.
function readSources({ home, cwd, userDir, env }) {
  const { claude: claudeFile, codex: codexFile, mcp: ownFile } = configPaths({ home, userDir, env });
  const errors = [];
  const files = [];
  // Highest priority first.
  const groups = [];

  const attempt = (file, label, read) => {
    try {
      const entries = read();
      if (entries === null) return [];
      files.push({ path: file, kind: label, servers: entries.length });
      return entries;
    } catch (error) {
      errors.push({ path: file, message: error.message });
      return [];
    }
  };

  groups.push(attempt(ownFile, 'dsx', () => {
    const text = readFile(ownFile);
    if (text === null) return null;
    const data = asObject(JSON.parse(text));
    return Object.entries(asObject(data.mcpServers)).map(([name, entry]) => fromClaude(name, entry, 'dsx'));
  }));

  groups.push(attempt(claudeFile, 'claude', () => {
    const text = readFile(claudeFile);
    if (text === null) return null;
    const data = asObject(JSON.parse(text));
    const entries = [];
    const project = cwd ? Object.entries(asObject(data.projects)).find(([folder]) => samePath(folder, cwd)) : null;
    const local = asObject(project && project[1]);
    const disabled = new Set(asStringList(local.disabledMcpServers));
    for (const [name, entry] of Object.entries(asObject(local.mcpServers))) entries.push(fromClaude(name, entry, 'claude'));
    for (const [name, entry] of Object.entries(asObject(data.mcpServers))) entries.push(fromClaude(name, entry, 'claude'));
    return entries.map((server) => (disabled.has(server.name) ? { ...server, disabled: true } : server));
  }));

  groups.push(attempt(codexFile, 'codex', () => {
    const text = readFile(codexFile);
    if (text === null) return null;
    const data = toml.parse(text);
    return Object.entries(asObject(data.mcp_servers)).map(([name, entry]) => fromCodex(name, entry, env));
  }));

  return { groups, errors, files };
}

// Returns { servers, errors, files }. `servers` has one entry per name, with `disabled` or `error` set
// for the ones that cannot run, so the user can be told why a server is missing.
function readMcpConfig({ cwd, home = os.homedir(), userDir = path.join(home, '.dsx'), env = process.env } = {}) {
  const { groups, errors, files } = readSources({ home, cwd, userDir, env });
  const seen = new Set();
  const servers = [];
  for (const group of groups) {
    for (const server of group) {
      if (seen.has(server.name)) continue;
      seen.add(server.name);
      servers.push(server);
    }
  }
  return { servers, errors, files };
}

module.exports = { readMcpConfig, configPaths, ensureOwnMcpFile, fromClaude, fromCodex, expandVariables, DEFAULT_STARTUP_TIMEOUT_MS, DEFAULT_TOOL_TIMEOUT_MS };
