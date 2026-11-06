#!/usr/bin/env node
// Native messaging host: runs shell commands on behalf of the extension.
// Framing: each message is a UTF-8 JSON payload prefixed by a 32-bit little-endian length.
'use strict';

const { spawn, spawnSync } = require('child_process');
const { StringDecoder } = require('string_decoder');
const { Worker } = require('worker_threads');
const fs = require('fs');
const os = require('os');
const path = require('path');

const VERSION = '0.1.0';
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_CHUNK_CHARS = 64 * 1024; // Chrome caps host-to-browser messages at 1 MB.
const MAX_STREAMED_CHARS = 5 * 1024 * 1024;
const FLUSH_INTERVAL_MS = 50;
// Output a background job keeps for the next poll, so a noisy server cannot grow without bound.
const MAX_JOB_BUFFER_CHARS = 512 * 1024;
const MAX_JOBS = 32;
const MAX_POLL_WAIT_MS = 60_000;
// A finished job stays readable for a while, so a poll can still fetch its last output.
const JOB_RETENTION_MS = 60_000;
const ANSI_PATTERN = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;

const IS_WINDOWS = process.platform === 'win32';
const running = new Map();
// Background jobs survive their starting call: they stay here, addressed by a short job id,
// until the model kills them or the browser goes away.
const jobsById = new Map();
let jobCounter = 0;

function send(message) {
  const payload = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  process.stdout.write(Buffer.concat([header, payload]));
}

function isOnPath(binary) {
  const probe = IS_WINDOWS ? spawnSync('where', [binary], { windowsHide: true }) : spawnSync('which', [binary]);
  return probe.status === 0;
}

function availableShells() {
  const candidates = IS_WINDOWS ? ['powershell', 'pwsh', 'cmd', 'bash'] : ['bash', 'zsh', 'sh', 'pwsh'];
  return candidates.filter((shell) => (shell === 'cmd' ? IS_WINDOWS : isOnPath(shell)));
}

// The version of the extension files next to this host, which is not always the version the browser
// has loaded: right after an update the files are new and the browser still runs the old ones.
function extensionVersion() {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'extension', 'manifest.json'), 'utf8'));
    return typeof manifest.version === 'string' ? manifest.version : null;
  } catch {
    return null;
  }
}

// The user's own instructions for the model, kept in a text file at the top of the install folder
// (beside host/ and extension/), where an update does not touch it. Only this one fixed file is read.
// DSX_PROMPT_FILE moves it, which is how the tests avoid touching a real one.
const PROMPT_FILE = process.env.DSX_PROMPT_FILE || path.join(__dirname, '..', 'evil.txt');

// The file has no size limit of its own. The browser caps one message from the host at 1 MB, so the
// text travels in pieces of MAX_CHUNK_CHARS, numbered, and the extension joins them again.
function readPromptFile({ id }) {
  const reply = { type: 'prompt-file', id, path: PROMPT_FILE, text: null, error: null, part: 0, parts: 1 };
  let text = '';
  try {
    text = fs.readFileSync(PROMPT_FILE, 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n').trim();
    if (!text) reply.error = 'empty';
  } catch (error) {
    reply.error = error.code === 'ENOENT' ? 'missing' : error.message;
  }
  if (reply.error) {
    send(reply);
    return;
  }
  const parts = Math.ceil(text.length / MAX_CHUNK_CHARS);
  for (let part = 0; part < parts; part += 1) {
    send({ ...reply, text: text.slice(part * MAX_CHUNK_CHARS, (part + 1) * MAX_CHUNK_CHARS), part, parts });
  }
}

function defaultShell() {
  if (IS_WINDOWS) return 'powershell';
  const fromEnv = (process.env.SHELL || '').split('/').pop();
  return ['bash', 'zsh', 'sh'].includes(fromEnv) ? fromEnv : 'sh';
}

// Returns the spawn arguments for a command in the requested shell, forcing UTF-8 output on Windows.
function buildInvocation(shell, command) {
  switch (shell) {
    case 'powershell':
    case 'pwsh': {
      const prelude =
        "$ProgressPreference='SilentlyContinue';" +
        '[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);' +
        '$OutputEncoding=[Text.UTF8Encoding]::new($false);';
      // The encoded form avoids every quoting problem between Node and PowerShell.
      const encoded = Buffer.from(`${prelude}\n${command}`, 'utf16le').toString('base64');
      const policy = IS_WINDOWS ? ['-ExecutionPolicy', 'Bypass'] : [];
      return {
        file: shell === 'pwsh' ? 'pwsh' : 'powershell.exe',
        args: ['-NoLogo', '-NoProfile', '-NonInteractive', ...policy, '-EncodedCommand', encoded],
      };
    }
    case 'cmd':
      return {
        file: 'cmd.exe',
        args: ['/d', '/s', '/c', `"chcp 65001>nul & ${command}"`],
        windowsVerbatimArguments: true,
      };
    case 'bash':
    case 'zsh':
    case 'sh':
      return { file: shell, args: ['-c', command] };
    default:
      return null;
  }
}

function killTree(child) {
  if (!child.pid) return;
  if (IS_WINDOWS) {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

// `sink` receives the text: a foreground call streams it to the tab, a background job keeps it.
function createOutputPump(id, sink = (data) => send({ type: 'output', id, data })) {
  const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
  let pending = '';
  let total = 0;
  let truncated = false;
  let timer = null;

  function flush() {
    timer = null;
    while (pending) {
      sink(pending.slice(0, MAX_CHUNK_CHARS));
      pending = pending.slice(MAX_CHUNK_CHARS);
    }
  }

  function push(stream, chunk) {
    const text = decoders[stream].write(chunk).replace(ANSI_PATTERN, '').replace(/\r\n/g, '\n');
    if (!text) return;
    if (total >= MAX_STREAMED_CHARS) {
      truncated = true;
      return;
    }
    total += text.length;
    pending += text;
    if (!timer) timer = setTimeout(flush, FLUSH_INTERVAL_MS);
  }

  return {
    push,
    finish() {
      if (timer) clearTimeout(timer);
      flush();
      return truncated;
    },
  };
}

// Spawns the command into `job` and calls `onExit` exactly once, whatever happens to it.
// The caller sets job.stopReason to end it early, and may rely on job.child once onStarted runs.
function spawnCommand({ job, command, shell, cwd, onOutput, onStarted, onExit }) {
  const shellName = shell || defaultShell();
  const invocation = buildInvocation(shellName, command);
  const workdir = cwd || os.homedir();

  if (!invocation) {
    onExit({ status: 'spawn_error', code: null, error: `Unsupported shell: ${shellName}` });
    return null;
  }
  if (!fs.existsSync(workdir)) {
    onExit({ status: 'spawn_error', code: null, error: `Working directory not found: ${workdir}` });
    return null;
  }

  const child = spawn(invocation.file, invocation.args, {
    cwd: workdir,
    env: { ...process.env, NO_COLOR: '1', TERM: 'dumb' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    windowsVerbatimArguments: Boolean(invocation.windowsVerbatimArguments),
    detached: !IS_WINDOWS,
  });

  const pump = createOutputPump(null, onOutput);
  job.child = child;
  onStarted({ pid: child.pid, shell: shellName, cwd: workdir });
  child.stdout.on('data', (chunk) => pump.push('stdout', chunk));
  child.stderr.on('data', (chunk) => pump.push('stderr', chunk));

  let finished = false;
  const finish = (fields) => {
    if (finished) return;
    finished = true;
    onExit({ truncated: pump.finish(), ...fields });
  };
  child.on('error', (error) => finish({ status: 'spawn_error', code: null, error: error.message }));
  child.on('close', (code) => finish({ status: job.stopReason || (code === 0 ? 'ok' : 'failed'), code }));

  return true;
}

function exec({ id, command, shell, cwd, timeoutMs, background }) {
  if (typeof id !== 'string' || typeof command !== 'string' || !command.trim()) {
    send({ type: 'exit', id, status: 'spawn_error', code: null, durationMs: 0, error: 'Invalid exec request.' });
    return;
  }
  if (running.has(id)) return;
  if (background) return execBackground({ id, command, shell, cwd });

  const startedAt = Date.now();
  const job = { child: null, stopReason: null };
  const limit = Math.min(Number(timeoutMs) || DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const timeout = setTimeout(() => {
    job.stopReason = 'timeout';
    if (job.child) killTree(job.child);
  }, limit);

  spawnCommand({
    job,
    command,
    shell,
    cwd,
    onOutput: (data) => send({ type: 'output', id, data }),
    onStarted: (started) => {
      send({ type: 'started', id, ...started });
      running.set(id, job);
    },
    onExit: ({ truncated, ...fields }) => {
      clearTimeout(timeout);
      running.delete(id);
      send({ type: 'exit', id, durationMs: Date.now() - startedAt, truncated, ...fields });
    },
  });
}

// A background job answers at once with its job id and keeps running: its output is buffered
// until the model polls for it. No timeout applies, so a dev server can stay up.
function execBackground({ id, command, shell, cwd }) {
  if (jobsById.size >= MAX_JOBS) {
    send({ type: 'exit', id, status: 'spawn_error', code: null, durationMs: 0, error: `Too many background jobs (${MAX_JOBS}). Stop one with <dsx:kill> first.` });
    return;
  }

  jobCounter += 1;
  const jobId = `job-${jobCounter}`;
  const startedAt = Date.now();
  const job = { id: jobId, command, buffer: '', truncated: false, status: 'running', code: null, done: false, startedAt, child: null, waiters: [] };

  function notify() {
    const waiters = job.waiters;
    job.waiters = [];
    for (const waiter of waiters) waiter();
  }

  const spawned = spawnCommand({
    job,
    command,
    shell,
    cwd,
    onOutput: (data) => {
      job.buffer += data;
      if (job.buffer.length > MAX_JOB_BUFFER_CHARS) {
        job.buffer = job.buffer.slice(-MAX_JOB_BUFFER_CHARS);
        job.truncated = true;
      }
      notify();
    },
    onStarted: ({ pid, shell: shellName, workdir }) => {
      job.pid = pid;
      job.cwd = workdir;
      job.shell = shellName;
    },
    onExit: ({ truncated, ...fields }) => {
      job.status = fields.status;
      job.code = fields.code ?? null;
      job.error = fields.error;
      job.truncated = job.truncated || Boolean(truncated);
      job.done = true;
      job.durationMs = Date.now() - startedAt;
      running.delete(id);
      // The job stays addressable for a while, so a poll can still read its last output.
      const cleanup = setTimeout(() => jobsById.delete(jobId), JOB_RETENTION_MS);
      cleanup.unref();
      notify();
    },
  });

  if (!spawned) return; // spawnCommand already reported the error
  running.set(id, job);
  jobsById.set(jobId, job);
  send({ type: 'exit', id, status: 'ok', code: 0, durationMs: Date.now() - startedAt, job: jobId, started: true, output: '' });
}

// Reports what a background job printed since the last poll. When it has printed nothing yet and
// is still running, waits up to waitMs so the model can follow a server as it starts. A poll that
// gives back output also ends that job's turn, and the next poll starts from there.
function poll({ id, job: jobId, waitMs }) {
  const job = jobsById.get(jobId);
  if (!job) {
    send({ type: 'exit', id, status: 'spawn_error', code: null, durationMs: 0, job: jobId, error: `No background job ${jobId}. It may have ended already.` });
    return;
  }

  const wait = Math.min(Math.max(Number(waitMs) || 0, 0), MAX_POLL_WAIT_MS);
  const reply = () => {
    const output = job.buffer;
    job.buffer = '';
    const running = !job.done;
    send({
      type: 'exit',
      id,
      status: running ? 'running' : job.status,
      code: job.code,
      durationMs: running ? Date.now() - job.startedAt : job.durationMs,
      job: job.id,
      running,
      truncated: job.truncated,
      output,
    });
    };

  if (job.buffer || job.done || wait === 0) {
    reply();
    return;
  }
  const timer = setTimeout(() => {
    job.waiters = job.waiters.filter((waiter) => waiter !== check);
    reply();
  }, wait);
  function check() {
    clearTimeout(timer);
    reply();
  }
  job.waiters.push(check);
}

function killJob({ id, job: jobId }) {
  const job = jobsById.get(jobId);
  if (!job) {
    if (id) send({ type: 'exit', id, status: 'spawn_error', code: null, durationMs: 0, job: jobId, error: `No background job ${jobId}.` });
    return;
  }
  if (job.child) killTree(job.child);
  const output = job.buffer;
  job.buffer = '';
  job.waiters = [];
  jobsById.delete(job.id);
  // Stopped from a card, there is no call waiting for its result.
  if (id) send({ type: 'exit', id, status: 'stopped', code: job.code, durationMs: Date.now() - job.startedAt, job: job.id, output });
}

// The command that shows this platform's native folder dialog and prints the chosen path.
function folderDialogCommand(start) {
  const title = 'Choose working directory';
  if (IS_WINDOWS) {
    const script = path.join(__dirname, 'pick-folder.ps1');
    return {
      file: 'powershell.exe',
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', script, '-Start', start, '-Title', title],
    };
  }
  if (process.platform === 'darwin') {
    return { file: 'osascript', args: ['-e', `POSIX path of (choose folder with prompt "${title}")`] };
  }
  return { file: 'zenity', args: ['--file-selection', '--directory', `--title=${title}`, `--filename=${start}/`] };
}

function pickFolder({ id, start }) {
  if (running.has(id)) return;
  const { file, args } = folderDialogCommand(start && fs.existsSync(start) ? start : os.homedir());
  const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  running.set(id, { child, stopReason: null });

  let output = '';
  let errors = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { errors += chunk; });

  let finished = false;
  const finish = (fields) => {
    if (finished) return;
    finished = true;
    running.delete(id);
    send({ type: 'folder-picked', id, path: null, error: null, ...fields });
  };
  child.on('error', (error) => finish({ error: error.message }));
  child.on('close', (code) => {
    const picked = output.trim();
    if (picked) finish({ path: picked });
    // Cancelling exits non-zero on macOS and Linux and prints nothing useful, so only Windows reports errors here.
    else finish({ error: IS_WINDOWS && code !== 0 ? errors.trim() || `The folder dialog exited with code ${code}.` : null });
  });
}

// Runs a file tool in a worker thread and reports it exactly like a shell command.
function runFileTool(request) {
  const { id, timeoutMs } = request;
  if (running.has(id)) return;
  const startedAt = Date.now();
  const worker = new Worker(path.join(__dirname, 'tools.js'), { workerData: request });
  const job = { worker, stopReason: null };
  running.set(id, job);
  send({ type: 'started', id, cwd: request.cwd || os.homedir() });

  const timeout = setTimeout(() => {
    job.stopReason = 'timeout';
    worker.terminate();
  }, Math.min(Number(timeoutMs) || DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS));

  let finished = false;
  const finish = (fields) => {
    if (finished) return;
    finished = true;
    clearTimeout(timeout);
    running.delete(id);
    send({ type: 'exit', id, durationMs: Date.now() - startedAt, ...fields });
  };
  worker.on('message', ({ status, code, output }) => {
    for (let index = 0; index < output.length; index += MAX_CHUNK_CHARS) {
      send({ type: 'output', id, data: output.slice(index, index + MAX_CHUNK_CHARS) });
    }
    finish({ status, code });
  });
  worker.on('error', (error) => finish({ status: 'spawn_error', code: null, error: error.message }));
  worker.on('exit', () => finish({ status: job.stopReason || 'spawn_error', code: null, error: job.stopReason ? undefined : 'The tool stopped unexpectedly.' }));
}

function stopJob(job) {
  if (job.worker) job.worker.terminate();
  else killTree(job.child);
}

function handle(message) {
  switch (message.type) {
    case 'read-prompt':
      readPromptFile(message);
      break;
    case 'pick-folder':
      try {
        pickFolder(message);
      } catch (error) {
        send({ type: 'folder-picked', id: message.id, path: null, error: error.message });
      }
      break;
    case 'hello':
      send({
        type: 'hello',
        version: VERSION,
        // What this host can do beyond running commands, so an extension newer than the host can say so
        // instead of waiting for an answer that never comes.
        features: ['read-prompt'],
        extensionVersion: extensionVersion(),
        platform: process.platform,
        defaultShell: defaultShell(),
        shells: availableShells(),
        home: os.homedir(),
      });
      break;
    case 'exec':
      if (message.tool === 'poll') poll(message);
      else if (message.tool === 'kill') killJob(message);
      else if (message.tool && message.tool !== 'shell') runFileTool(message);
      else exec(message);
      break;
    case 'kill': {
      const job = running.get(message.id);
      if (job) {
        job.stopReason = 'stopped';
        stopJob(job);
      }
      break;
    }
    case 'killJob':
      killJob({ job: message.job });
      break;
    default:
      break;
  }
}

let buffer = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length >= 4) {
    const size = buffer.readUInt32LE(0);
    if (buffer.length < 4 + size) break;
    const payload = buffer.subarray(4, 4 + size).toString('utf8');
    buffer = buffer.subarray(4 + size);
    try {
      handle(JSON.parse(payload));
    } catch (error) {
      send({ type: 'protocol_error', message: error.message });
    }
  }
});

// The browser closes stdin when the extension disconnects: never leave orphan commands behind.
process.stdin.on('end', () => {
  for (const job of running.values()) stopJob(job);
  process.exit(0);
});
