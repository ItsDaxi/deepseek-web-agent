// Keeps count of the helpers (sub-agents) that work at the same time. DeepSeek lets an account generate
// in two chats at once and refuses a third with "parallel_chat_limit". The main chat is idle while its
// helpers work, because it ended its reply with the call that started them, so the pool allows two
// helpers and the rest wait in line.
//
// The pool knows nothing about the browser: opening and closing the helper's tab is done by the
// functions it is given, which keeps the rules here testable on their own.
(function (root) {
  'use strict';

  const MAX_ACTIVE = 2;
  const JOB_TIMEOUT_MS = 20 * 60 * 1000;

  // open(job) starts the helper and resolves once it exists; close(job) ends it.
  // onUpdate(job, state) reports 'queued' and 'running'; onDone(job, result) reports the end, once.
  function createAgentPool({
    open,
    close,
    onUpdate = () => {},
    onDone = () => {},
    maxActive = MAX_ACTIVE,
    timeoutMs = JOB_TIMEOUT_MS,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  }) {
    const jobs = new Map();
    const waiting = [];

    function activeCount() {
      let count = 0;
      for (const job of jobs.values()) if (job.state === 'running') count += 1;
      return count;
    }

    function startNext() {
      while (waiting.length && activeCount() < maxActive) {
        const job = waiting.shift();
        if (job.state !== 'queued') continue;
        job.state = 'running';
        onUpdate(job, 'running');
        job.timer = setTimer(() => finish(job.id, { status: 'timeout', text: 'The helper took too long and was stopped.' }), timeoutMs);
        Promise.resolve()
          .then(() => open(job))
          .catch((error) => finish(job.id, { status: 'failed', text: `The helper could not start: ${error && error.message ? error.message : error}` }));
      }
    }

    function submit(job) {
      if (jobs.has(job.id)) return;
      const entry = { ...job, state: 'queued', timer: null };
      jobs.set(entry.id, entry);
      waiting.push(entry);
      // A job that has to wait is told so, with how many helpers are ahead of it.
      if (activeCount() >= maxActive) onUpdate(entry, 'queued');
      startNext();
    }

    // Ends a job once. A second call for the same job changes nothing.
    function finish(id, result) {
      const job = jobs.get(id);
      if (!job || job.state === 'done') return false;
      const wasRunning = job.state === 'running';
      job.state = 'done';
      jobs.delete(id);
      if (job.timer !== null) clearTimer(job.timer);
      if (wasRunning) {
        try {
          Promise.resolve(close(job)).catch(() => {});
        } catch {
          // The tab may already be gone.
        }
      }
      onDone(job, result);
      startNext();
      return true;
    }

    function cancel(id) {
      return finish(id, { status: 'stopped', text: 'The helper was stopped.' });
    }

    // The tab that asked is gone, so nobody is waiting for what its helpers find.
    function cancelOwnedBy(owner) {
      for (const job of [...jobs.values()]) {
        if (job.owner === owner) finish(job.id, { status: 'stopped', text: 'The chat that started this helper was closed.' });
      }
    }

    return {
      submit,
      finish,
      cancel,
      cancelOwnedBy,
      get: (id) => jobs.get(id) || null,
      active: activeCount,
      queued: () => waiting.filter((job) => job.state === 'queued').length,
    };
  }

  const api = { createAgentPool, MAX_ACTIVE, JOB_TIMEOUT_MS };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DsxAgentPool = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
