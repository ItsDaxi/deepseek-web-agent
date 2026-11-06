'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');

const HOST = path.join(__dirname, '..', '..', 'host', 'host.js');
const IS_WINDOWS = process.platform === 'win32';

function startHost() {
  const child = spawn(process.execPath, [HOST], { stdio: ['pipe', 'pipe', 'inherit'] });
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
    send(message) {
      const payload = Buffer.from(JSON.stringify(message));
      const header = Buffer.alloc(4);
      header.writeUInt32LE(payload.length);
      child.stdin.write(Buffer.concat([header, payload]));
    },
    waitFor(predicate, timeoutMs = 30000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out: ${JSON.stringify(messages)}`)), timeoutMs);
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
    messages,
    stop() {
      child.stdin.end();
    },
  };
}

function outputOf(host, id) {
  return host.messages.filter((m) => m.type === 'output' && m.id === id).map((m) => m.data).join('');
}

const exited = (id) => (message) => message.type === 'exit' && message.id === id;

test('hello reports the environment', async () => {
  const host = startHost();
  host.send({ type: 'hello' });
  const hello = await host.waitFor((m) => m.type === 'hello');
  assert.equal(hello.platform, process.platform);
  assert.ok(hello.shells.includes(hello.defaultShell));
  // The host names the version of the extension files beside it, so the browser can tell when it is behind.
  const { version } = JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname, '..', '..', 'extension', 'manifest.json'), 'utf8'));
  assert.equal(hello.extensionVersion, version);
  host.stop();
});

test('a successful command streams output and exits 0', async () => {
  const host = startHost();
  host.send({ type: 'exec', id: 'ok', command: 'echo hello' });
  const exit = await host.waitFor(exited('ok'));
  assert.equal(exit.status, 'ok');
  assert.equal(exit.code, 0);
  assert.match(outputOf(host, 'ok'), /hello/);
  host.stop();
});

test('a failing command reports its exit code', async () => {
  const host = startHost();
  host.send({ type: 'exec', id: 'fail', command: 'exit 7' });
  const exit = await host.waitFor(exited('fail'));
  assert.equal(exit.status, 'failed');
  assert.equal(exit.code, 7);
  host.stop();
});

test('non-ASCII output survives', async () => {
  const host = startHost();
  host.send({ type: 'exec', id: 'utf8', command: 'Write-Output "caffè €"'.replace('Write-Output', IS_WINDOWS ? 'Write-Output' : 'echo') });
  await host.waitFor(exited('utf8'));
  assert.match(outputOf(host, 'utf8'), /caffè €/);
  host.stop();
});

test('cmd.exe runs with UTF-8 and its own exit code', { skip: !IS_WINDOWS }, async () => {
  const host = startHost();
  host.send({ type: 'exec', id: 'cmd', shell: 'cmd', command: 'echo from cmd & exit /b 4' });
  const exit = await host.waitFor(exited('cmd'));
  assert.equal(exit.code, 4);
  assert.match(outputOf(host, 'cmd'), /from cmd/);
  host.stop();
});

test('cwd is honored and a missing one fails cleanly', async () => {
  const host = startHost();
  const dir = os.tmpdir();
  host.send({ type: 'exec', id: 'cwd', cwd: dir, command: IS_WINDOWS ? '(Get-Location).Path' : 'pwd' });
  await host.waitFor(exited('cwd'));
  assert.ok(outputOf(host, 'cwd').toLowerCase().includes(path.basename(dir).toLowerCase()));

  host.send({ type: 'exec', id: 'nocwd', cwd: path.join(dir, 'dsx-does-not-exist'), command: 'echo x' });
  const exit = await host.waitFor(exited('nocwd'));
  assert.equal(exit.status, 'spawn_error');
  assert.match(exit.error, /not found/);
  host.stop();
});

const SLEEP = IS_WINDOWS ? 'Start-Sleep -Seconds 60' : 'sleep 60';

test('a timeout kills the command', async () => {
  const host = startHost();
  host.send({ type: 'exec', id: 'slow', command: SLEEP, timeoutMs: 1500 });
  const exit = await host.waitFor(exited('slow'));
  assert.equal(exit.status, 'timeout');
  assert.ok(exit.durationMs < 20000);
  host.stop();
});

test('kill stops a running command', async () => {
  const host = startHost();
  host.send({ type: 'exec', id: 'stop', command: SLEEP });
  await host.waitFor((m) => m.type === 'started' && m.id === 'stop');
  host.send({ type: 'kill', id: 'stop' });
  const exit = await host.waitFor(exited('stop'));
  assert.equal(exit.status, 'stopped');
  host.stop();
});

function answerFolderDialog(folder) {
  const script = path.join(__dirname, '..', 'helpers', 'answer-folder-dialog.ps1');
  return new Promise((resolve, reject) => {
    const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script];
    if (folder) args.push('-Path', folder);
    const child = spawn('powershell.exe', args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let errors = '';
    child.stderr.on('data', (chunk) => { errors += chunk; });
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(errors))));
  });
}

const picked = (id) => (message) => message.type === 'folder-picked' && message.id === id;

// These open a real dialog on the screen, so they only run when asked for: DSX_TEST_DIALOG=1.
const skipDialogTests = !IS_WINDOWS || !process.env.DSX_TEST_DIALOG;

test('the native folder dialog returns the chosen folder', { skip: skipDialogTests }, async () => {
  const host = startHost();
  const folder = os.tmpdir();
  host.send({ type: 'pick-folder', id: 'pick-1', start: os.homedir() });
  await answerFolderDialog(folder);
  const result = await host.waitFor(picked('pick-1'));
  assert.equal(result.error, null);
  assert.equal(result.path.toLowerCase(), folder.toLowerCase());
  host.stop();
});

test('cancelling the native folder dialog changes nothing', { skip: skipDialogTests }, async () => {
  const host = startHost();
  host.send({ type: 'pick-folder', id: 'pick-2', start: path.join(os.tmpdir(), 'dsx-does-not-exist') });
  await answerFolderDialog(null);
  const result = await host.waitFor(picked('pick-2'));
  assert.equal(result.path, null);
  assert.equal(result.error, null);
  host.stop();
});

test('an unsupported shell is refused', async () => {
  const host = startHost();
  host.send({ type: 'exec', id: 'bad', shell: 'nope', command: 'echo x' });
  const exit = await host.waitFor(exited('bad'));
  assert.equal(exit.status, 'spawn_error');
  host.stop();
});

const LOOP = IS_WINDOWS
  ? 'for ($i = 0; $i -lt 200; $i++) { Write-Output "tick $i"; Start-Sleep -Milliseconds 100 }'
  : 'for i in $(seq 1 200); do echo "tick $i"; sleep 0.1; done';

test('a background command answers at once and keeps its output for a poll', async () => {
  const host = startHost();
  host.send({ type: 'exec', id: 'bg', background: true, command: LOOP });
  const started = await host.waitFor(exited('bg'));
  assert.equal(started.status, 'ok');
  assert.match(started.job, /^job-\d+$/);
  assert.equal(started.started, true);

  await new Promise((resolve) => setTimeout(resolve, 700));
  host.send({ type: 'exec', id: 'p1', tool: 'poll', job: started.job, waitMs: 0 });
  const poll = await host.waitFor(exited('p1'));
  assert.equal(poll.status, 'running');
  assert.equal(poll.running, true);
  assert.match(poll.output, /tick \d+/);

  // A poll consumes what it reports: the next one only sees new output.
  host.send({ type: 'exec', id: 'p2', tool: 'poll', job: started.job, waitMs: 0 });
  const next = await host.waitFor(exited('p2'));
  const firstTick = Number(/tick (\d+)/.exec(poll.output)[1]);
  if (next.output) {
    const nextTick = Number(/tick (\d+)/.exec(next.output)[1]);
    assert.ok(nextTick > firstTick);
  }

  host.send({ type: 'exec', id: 'pkill', tool: 'kill', job: started.job });
  const killed = await host.waitFor(exited('pkill'));
  assert.equal(killed.status, 'stopped');
  host.stop();
});

test('a poll waits for output, and a finished job reports its exit', async () => {
  const host = startHost();
  const command = IS_WINDOWS ? 'Start-Sleep -Milliseconds 400; Write-Output done' : 'sleep 0.4; echo done';
  host.send({ type: 'exec', id: 'bg2', background: true, command });
  const started = await host.waitFor(exited('bg2'));

  host.send({ type: 'exec', id: 'wait2', tool: 'poll', job: started.job, waitMs: 10000 });
  const poll = await host.waitFor(exited('wait2'));
  assert.match(poll.output, /done/);

  host.send({ type: 'exec', id: 'late', tool: 'poll', job: started.job, waitMs: 0 });
  const late = await host.waitFor(exited('late'));
  assert.equal(late.running, false);
  assert.equal(late.status, 'ok');
  assert.equal(late.code, 0);

  // A finished job stays readable for a while, and an unknown one fails cleanly.
  host.send({ type: 'exec', id: 'again', tool: 'poll', job: started.job, waitMs: 0 });
  const again = await host.waitFor(exited('again'));
  assert.equal(again.status, 'ok');
  assert.equal(again.output, '');

  host.send({ type: 'exec', id: 'gone', tool: 'poll', job: 'job-404', waitMs: 0 });
  const gone = await host.waitFor(exited('gone'));
  assert.equal(gone.status, 'spawn_error');
  host.stop();
});

test('a job can be stopped from its card, with no call waiting for the answer', async () => {
  const host = startHost();
  host.send({ type: 'exec', id: 'bg3', background: true, command: LOOP });
  const started = await host.waitFor(exited('bg3'));
  await new Promise((resolve) => setTimeout(resolve, 300));

  host.send({ type: 'killJob', job: started.job });
  // The message carries no id, so the only sign is that the job stops answering.
  await new Promise((resolve) => setTimeout(resolve, 200));
  host.send({ type: 'exec', id: 'after', tool: 'poll', job: started.job, waitMs: 0 });
  const after = await host.waitFor(exited('after'));
  assert.equal(after.status, 'spawn_error');
  host.stop();
});

test('polling an unknown job fails cleanly', async () => {
  const host = startHost();
  host.send({ type: 'exec', id: 'nope', tool: 'poll', job: 'job-999', waitMs: 0 });
  const exit = await host.waitFor(exited('nope'));
  assert.equal(exit.status, 'spawn_error');
  assert.match(exit.error, /job-999/);
  host.stop();
});
