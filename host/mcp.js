// A small MCP client: starts the servers the user configured (stdio, or streamable HTTP), asks them for
// their tools and calls them. It has no dependencies, like the rest of the host.
//
// The wire format is JSON-RPC 2.0. A stdio server gets one JSON message per line on its stdin and writes
// one per line on its stdout. An HTTP server gets each message as a POST and answers with JSON or with a
// short event stream.
'use strict';

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PROTOCOL_VERSION = '2025-06-18';
const CLIENT_INFO = { name: 'deepseek-web-agent', version: '1.0.0' };
const IS_WINDOWS = process.platform === 'win32';
const STDERR_KEEP_CHARS = 4000;
const MAX_TOOLS_PER_SERVER = 150;
const MAX_DESCRIPTION_CHARS = 400;
const MAX_PARAM_DESCRIPTION_CHARS = 120;
const MAX_PARAMS_PER_TOOL = 30;
const CLOSE_GRACE_MS = 1500;

const asObject = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
const asArray = (value) => (Array.isArray(value) ? value : []);

function clip(text, limit) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean;
}

class McpError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

// ---- Starting a program -------------------------------------------------------------------------

// On Windows, `npx` is really npx.cmd, which cannot be started without a shell. This finds what a bare name
// means the way the shell would, so a config written for Claude Code or Codex works as it is.
function findOnPath(name, env) {
  const extensions = (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  const folders = (env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
  const hasExtension = /\.[A-Za-z0-9]+$/.test(name);
  for (const folder of folders) {
    const candidates = hasExtension ? [name] : extensions.map((extension) => name + extension);
    for (const candidate of candidates) {
      const file = path.join(folder, candidate);
      try {
        if (fs.statSync(file).isFile()) return file;
      } catch {
        // Not here.
      }
    }
  }
  return null;
}

function quoteForCmd(value) {
  const text = String(value);
  return /[\s"&|<>^()%!]/.test(text) || text === '' ? `"${text.replace(/"/g, '\\"')}"` : text;
}

// Returns the file and the arguments to spawn for a configured command.
function buildInvocation(command, args, env) {
  if (!IS_WINDOWS) return { file: command, args, options: {} };
  let file = command;
  if (!/[\\/]/.test(command)) file = findOnPath(command, env) || command;
  else if (!path.extname(command)) file = findOnPath(command, env) || command;
  if (/\.(cmd|bat)$/i.test(file)) {
    const line = [file, ...args].map(quoteForCmd).join(' ');
    return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], options: { windowsVerbatimArguments: true } };
  }
  return { file, args, options: {} };
}

function terminate(child) {
  if (!child || child.exitCode !== null || !child.pid) return;
  if (IS_WINDOWS) {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
    return;
  }
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
  const timer = setTimeout(() => {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }, CLOSE_GRACE_MS);
  timer.unref();
}

// ---- A connection to one server -----------------------------------------------------------------

// Shared by both transports: numbering of requests, and the answers that come back for them.
class Connection {
  constructor() {
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
    this.closeReason = '';
  }

  // Resolves with the `result` of the answer. `signal` aborts the wait and tells the server to stop.
  request(method, params, { timeoutMs = 30_000, signal } = {}) {
    if (this.closed) return Promise.reject(new McpError(this.closeReason || 'The server is not running.', 'closed'));
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      let timer = null;
      // Ends the HTTP request behind this call when the wait is given up.
      const transfer = new AbortController();
      const cleanup = () => {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        this.pending.delete(id);
      };
      const cancel = (error) => {
        cleanup();
        transfer.abort();
        this.notify('notifications/cancelled', { requestId: id, reason: error.message }).catch(() => {});
        reject(error);
      };
      const onAbort = () => cancel(new McpError('Stopped.', 'aborted'));
      timer = setTimeout(() => cancel(new McpError(`The server did not answer ${method} within ${Math.round(timeoutMs / 1000)} seconds.`, 'timeout')), timeoutMs);
      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }
      this.pending.set(id, {
        resolve: (value) => {
          cleanup();
          resolve(value);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      });
      this.post({ jsonrpc: '2.0', id, method, params }, transfer.signal).catch((error) => {
        if (this.pending.has(id)) this.pending.get(id).reject(error);
      });
    });
  }

  notify(method, params) {
    return this.post({ jsonrpc: '2.0', method, ...(params ? { params } : {}) });
  }

  // A message from the server: an answer to one of ours, or a request the client has to answer.
  receive(message) {
    if (!message || typeof message !== 'object') return;
    if (message.id !== undefined && message.method === undefined) {
      const waiting = this.pending.get(message.id);
      if (!waiting) return;
      if (message.error) waiting.reject(new McpError(message.error.message || 'The server reported an error.', message.error.code));
      else waiting.resolve(message.result);
      return;
    }
    if (message.id !== undefined && message.method !== undefined) {
      // The server asking us something. Only ping is answered; this client offers no roots, sampling or prompts.
      const reply = message.method === 'ping' ? { result: {} } : { error: { code: -32601, message: 'Method not found' } };
      this.post({ jsonrpc: '2.0', id: message.id, ...reply }).catch(() => {});
    }
  }

  fail(reason) {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = reason;
    for (const waiting of [...this.pending.values()]) waiting.reject(new McpError(reason, 'closed'));
    this.pending.clear();
    if (this.onClose) this.onClose(reason);
  }

  async initialize(timeoutMs) {
    const result = await this.request('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO }, { timeoutMs });
    this.protocolVersion = (result && result.protocolVersion) || PROTOCOL_VERSION;
    await this.notify('notifications/initialized');
    return result;
  }

  async listTools(timeoutMs) {
    const tools = [];
    let cursor;
    for (let page = 0; page < 20; page += 1) {
      const result = asObject(await this.request('tools/list', cursor ? { cursor } : {}, { timeoutMs }));
      tools.push(...asArray(result.tools));
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    return tools;
  }

  callTool(name, args, options) {
    return this.request('tools/call', { name, arguments: args }, options);
  }
}

class StdioConnection extends Connection {
  constructor(server, { cwd, env = process.env } = {}) {
    super();
    this.stderr = '';
    const childEnv = { ...env, ...(server.env || {}) };
    const invocation = buildInvocation(server.command, server.args || [], childEnv);
    const workdir = server.cwd && fs.existsSync(server.cwd) ? server.cwd : cwd && fs.existsSync(cwd) ? cwd : os.homedir();
    this.child = spawn(invocation.file, invocation.args, {
      cwd: workdir,
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: !IS_WINDOWS,
      ...invocation.options,
    });
    let pendingText = '';
    this.child.stdout.setEncoding('utf8').on('data', (chunk) => {
      pendingText += chunk;
      let end = pendingText.indexOf('\n');
      while (end !== -1) {
        const line = pendingText.slice(0, end).trim();
        pendingText = pendingText.slice(end + 1);
        end = pendingText.indexOf('\n');
        if (!line) continue;
        let message = null;
        try {
          message = JSON.parse(line);
        } catch {
          continue; // A server may print a log line on stdout; it is not a message.
        }
        this.receive(message);
      }
    });
    this.child.stderr.setEncoding('utf8').on('data', (chunk) => {
      this.stderr = (this.stderr + chunk).slice(-STDERR_KEEP_CHARS);
    });
    this.child.stdin.on('error', () => {});
    this.child.on('error', (error) => this.fail(error.code === 'ENOENT' ? `The command "${server.command}" was not found.` : error.message));
    this.child.on('close', (code) => {
      const detail = this.stderr.trim().split('\n').slice(-3).join(' ').trim();
      this.fail(`The server stopped${code === null ? '' : ` (exit ${code})`}${detail ? `: ${clip(detail, 300)}` : '.'}`);
    });
  }

  post(message) {
    if (this.closed) return Promise.reject(new McpError(this.closeReason || 'The server is not running.', 'closed'));
    return new Promise((resolve, reject) => {
      this.child.stdin.write(`${JSON.stringify(message)}\n`, (error) => (error ? reject(new McpError(error.message, 'closed')) : resolve()));
    });
  }

  close() {
    this.onClose = null;
    this.fail('The server was closed.');
    try {
      this.child.stdin.end();
    } catch {
      // Already gone.
    }
    terminate(this.child);
  }
}

// Reads a text/event-stream body until `accept` returns true for a message, then stops reading.
async function readEvents(response, onMessage) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) text += decoder.decode(value, { stream: !done }).replace(/\r\n?/g, '\n');
      let end = text.indexOf('\n\n');
      while (end !== -1) {
        const block = text.slice(0, end);
        text = text.slice(end + 2);
        end = text.indexOf('\n\n');
        const data = block.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).replace(/^ /, '')).join('\n');
        if (!data) continue;
        let message = null;
        try {
          message = JSON.parse(data);
        } catch {
          continue;
        }
        if (onMessage(message) === true) return;
      }
      if (done) return;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

class HttpConnection extends Connection {
  constructor(server) {
    super();
    this.url = server.url;
    this.headers = server.headers || {};
    this.sessionId = null;
    this.controller = new AbortController();
  }

  async post(message, signal) {
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...this.headers,
    };
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    if (this.protocolVersion) headers['MCP-Protocol-Version'] = this.protocolVersion;
    // The request ends when the call is given up, or when the connection is closed.
    const stop = new AbortController();
    const abort = () => stop.abort();
    this.controller.signal.addEventListener('abort', abort, { once: true });
    if (signal) signal.addEventListener('abort', abort, { once: true });
    try {
      await this.send(message, headers, stop.signal);
    } finally {
      this.controller.signal.removeEventListener('abort', abort);
      if (signal) signal.removeEventListener('abort', abort);
    }
  }

  async send(message, headers, signal) {
    let response;
    try {
      response = await fetch(this.url, { method: 'POST', headers, body: JSON.stringify(message), signal });
    } catch (error) {
      if (error.name === 'AbortError') throw new McpError('Stopped.', 'aborted');
      throw new McpError(`Cannot reach ${this.url}: ${error.cause && error.cause.message ? error.cause.message : error.message}`, 'network');
    }
    const session = response.headers.get('mcp-session-id');
    if (session) this.sessionId = session;
    if (response.status === 401 || response.status === 403) {
      throw new McpError(`The server refused the request (HTTP ${response.status}). Put a token in its headers; signing in through a browser is not supported here.`, 'auth');
    }
    if (!response.ok) {
      const body = clip(await response.text().catch(() => ''), 300);
      throw new McpError(`HTTP ${response.status} from the server${body ? `: ${body}` : '.'}`, 'http');
    }
    if (response.status === 202 || message.id === undefined) {
      await response.body?.cancel().catch(() => {});
      return;
    }
    const type = response.headers.get('content-type') || '';
    try {
      if (type.includes('text/event-stream')) {
        await readEvents(response, (incoming) => {
          this.receive(incoming);
          return incoming.id === message.id && incoming.method === undefined;
        });
      } else {
        const body = await response.json();
        for (const incoming of Array.isArray(body) ? body : [body]) this.receive(incoming);
      }
    } catch (error) {
      if (error.name === 'AbortError') throw new McpError('Stopped.', 'aborted');
      throw error;
    }
    // The answer to a request comes in this very response. If it did not, there is nothing left to wait for.
    const waiting = this.pending.get(message.id);
    if (waiting) waiting.reject(new McpError('The server ended its response without an answer.', 'network'));
  }

  close() {
    this.onClose = null;
    this.fail('The server was closed.');
    if (this.sessionId) {
      fetch(this.url, { method: 'DELETE', headers: { ...this.headers, 'Mcp-Session-Id': this.sessionId }, signal: AbortSignal.timeout(2000) }).catch(() => {});
    }
    this.controller.abort();
  }
}

function connect(server, options) {
  if (server.transport === 'http') return new HttpConnection(server);
  return new StdioConnection(server, options);
}

// ---- What the model is told about a tool, and what comes back from a call -----------------------

function typeOf(property) {
  const schema = asObject(property);
  if (Array.isArray(schema.enum) && schema.enum.length) {
    const values = schema.enum.slice(0, 8).map((value) => JSON.stringify(value)).join('|');
    return schema.enum.length > 8 ? `${values}|…` : values;
  }
  const alternatives = asArray(schema.anyOf).length ? schema.anyOf : asArray(schema.oneOf);
  if (alternatives.length) return [...new Set(alternatives.map(typeOf))].join('|');
  if (Array.isArray(schema.type)) return schema.type.join('|');
  if (schema.type === 'array') return `array<${schema.items ? typeOf(schema.items) : 'any'}>`;
  return typeof schema.type === 'string' ? schema.type : 'any';
}

// A short, fixed-size description of a tool: enough to call it, and small enough to put in a prompt.
function summarizeTool(tool) {
  const schema = asObject(tool.inputSchema);
  const required = new Set(asArray(schema.required));
  const entries = Object.entries(asObject(schema.properties));
  return {
    name: String(tool.name),
    description: clip(tool.description || tool.title || '', MAX_DESCRIPTION_CHARS),
    params: entries.slice(0, MAX_PARAMS_PER_TOOL).map(([name, property]) => ({
      name,
      type: typeOf(property),
      required: required.has(name),
      description: clip(asObject(property).description, MAX_PARAM_DESCRIPTION_CHARS),
    })),
    moreParams: Math.max(entries.length - MAX_PARAMS_PER_TOOL, 0),
    readOnly: asObject(tool.annotations).readOnlyHint === true,
  };
}

// The text of a call's result, the way the model should read it.
function formatCallResult(result) {
  const data = asObject(result);
  const parts = [];
  for (const item of asArray(data.content)) {
    const block = asObject(item);
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    else if (block.type === 'image' || block.type === 'audio') parts.push(`[${block.type}, ${block.mimeType || 'unknown type'}, ${Math.round(((block.data || '').length * 3) / 4)} bytes, not shown]`);
    else if (block.type === 'resource_link') parts.push(`[resource ${block.uri || ''}${block.name ? ` (${block.name})` : ''}]`);
    else if (block.type === 'resource') {
      const resource = asObject(block.resource);
      parts.push(typeof resource.text === 'string' ? resource.text : `[resource ${resource.uri || ''}, ${resource.mimeType || 'binary'}, not shown]`);
    }
  }
  if (!parts.length && data.structuredContent !== undefined) parts.push(JSON.stringify(data.structuredContent, null, 2));
  return { text: parts.join('\n'), isError: data.isError === true };
}

// ---- All the servers ----------------------------------------------------------------------------

function signatureOf(server) {
  return JSON.stringify([server.transport, server.command, server.args, server.env, server.cwd, server.url, server.headers]);
}

function allowedTool(server, name) {
  if (server.enabledTools && !server.enabledTools.includes(name)) return false;
  return !(server.disabledTools || []).includes(name);
}

// Keeps the servers that were started, by name, until the host ends. `onChange` is called whenever one of
// them starts, fails or stops, so the extension can show the tools as soon as they are known.
function createMcpManager({ onChange = () => {}, env = process.env } = {}) {
  const entries = new Map();
  // The config of the latest `configure`: the servers that exist for the folder the user is working in.
  let current = [];

  function entryFor(server, cwd) {
    const signature = signatureOf(server);
    const known = entries.get(server.name);
    if (known && known.signature === signature && known.status !== 'failed') return known;
    if (known && known.connection) known.connection.close();

    const entry = { name: server.name, signature, server, status: 'starting', error: null, tools: [], connection: null, ready: null };
    entries.set(server.name, entry);
    entry.ready = (async () => {
      try {
        entry.connection = connect(server, { cwd, env });
        // A server that dies after it started is shown as failed, so the model is not offered its tools.
        entry.connection.onClose = (reason) => {
          if (entry.status !== 'ready') return;
          entry.status = 'failed';
          entry.error = reason;
          onChange();
        };
        await entry.connection.initialize(server.startupTimeoutMs);
        const tools = await entry.connection.listTools(server.startupTimeoutMs);
        entry.tools = tools.filter((tool) => tool && typeof tool.name === 'string' && allowedTool(server, tool.name));
        entry.status = 'ready';
      } catch (error) {
        entry.status = 'failed';
        entry.error = error.message;
        if (entry.connection) entry.connection.close();
      }
      onChange();
    })();
    return entry;
  }

  return {
    // Starts what is not running yet, for the servers of this config. Resolves when none is still starting.
    configure({ servers, cwd }) {
      current = servers;
      const waiting = [];
      for (const server of servers) {
        if (server.disabled || server.error) continue;
        waiting.push(entryFor(server, cwd).ready);
      }
      onChange();
      return Promise.all(waiting).then(() => undefined);
    },

    // What the model may use, one entry per configured server.
    snapshot() {
      return current.map((server) => {
        const base = { name: server.name, source: server.source, transport: server.transport };
        if (server.disabled) return { ...base, status: 'disabled', error: null, tools: [], moreTools: 0 };
        if (server.error) return { ...base, status: 'failed', error: server.error, tools: [], moreTools: 0 };
        const entry = entries.get(server.name);
        if (!entry) return { ...base, status: 'starting', error: null, tools: [], moreTools: 0 };
        const tools = entry.tools.map(summarizeTool);
        return {
          ...base,
          status: entry.status,
          error: entry.error,
          tools: tools.slice(0, MAX_TOOLS_PER_SERVER),
          moreTools: Math.max(tools.length - MAX_TOOLS_PER_SERVER, 0),
        };
      });
    },

    isSettled() {
      return current.every((server) => {
        const entry = entries.get(server.name);
        return server.disabled || server.error || (entry && entry.status !== 'starting');
      });
    },

    // Calls a tool and returns { text, isError }. Throws an McpError when the call could not be made.
    async call({ server: name, tool, args, timeoutMs, signal }) {
      const configured = current.find((server) => server.name === name);
      if (!configured || configured.disabled || configured.error) throw new McpError(`There is no MCP server called "${name}".`, 'unknown');
      const entry = entries.get(name);
      if (!entry) throw new McpError(`The MCP server "${name}" has not started.`, 'unknown');
      if (entry.status === 'starting') await entry.ready;
      if (entry.status !== 'ready') throw new McpError(`The MCP server "${name}" is not running${entry.error ? `: ${entry.error}` : '.'}`, 'closed');
      if (!entry.tools.some((item) => item.name === tool)) {
        const names = entry.tools.map((item) => item.name).slice(0, 40).join(', ');
        throw new McpError(`The server "${name}" has no tool called "${tool}".${names ? ` Its tools are: ${names}.` : ''}`, 'unknown');
      }
      const result = await entry.connection.callTool(tool, args, { timeoutMs: timeoutMs || configured.toolTimeoutMs, signal });
      return formatCallResult(result);
    },

    closeAll() {
      for (const entry of entries.values()) if (entry.connection) entry.connection.close();
      entries.clear();
    },
  };
}

module.exports = {
  createMcpManager,
  connect,
  summarizeTool,
  formatCallResult,
  buildInvocation,
  McpError,
  MAX_TOOLS_PER_SERVER,
  PROTOCOL_VERSION,
};
