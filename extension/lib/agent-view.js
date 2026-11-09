// What the Agents menu shows for the helpers of the open chat: which ones belong to it, and the line of
// text for each. Pure functions, so the figures and wording can be tested without a page.
(function (root) {
  'use strict';

  const PREFIX_CHARS = 8;
  const WORKING = new Set(['queued', 'running']);
  const STATE_WORDS = { failed: 'Failed', stopped: 'Stopped', timeout: 'Timed out' };

  // A helper's call id starts with the first 8 characters of the chat that wrote it, so the helpers of
  // the chat that is open are the ones whose id starts the same way. A new chat has no id yet and no helpers.
  function visibleAgents(list, sessionId) {
    if (!sessionId || !Array.isArray(list)) return [];
    const prefix = `${String(sessionId).slice(0, PREFIX_CHARS)}-`;
    return list.filter((entry) => typeof entry.id === 'string' && entry.id.startsWith(prefix));
  }

  // { title, meta, state, clickable } for one row. `now` is the time in ms; a running helper counts up to it.
  function describeAgent(entry, now, { formatTokens, formatDuration }) {
    const title = entry.description || 'Helper';
    const started = entry.startedAt === null || entry.startedAt === undefined ? null : entry.startedAt;
    const clickable = Boolean(entry.sessionId) || (entry.state === 'running' && Boolean(entry.hasTab));

    if (entry.state === 'queued') {
      return { title, meta: 'Waiting for a free place', state: 'queued', clickable: false };
    }

    const parts = [];
    if (STATE_WORDS[entry.state]) parts.push(STATE_WORDS[entry.state]);
    if (entry.output > 0) {
      parts.push(entry.input !== null && entry.input !== undefined
        ? `Input ${formatTokens(entry.input)} tok · Output ${formatTokens(entry.output)} tok`
        : `Output ${formatTokens(entry.output)} tok`);
    } else if (entry.state === 'running') {
      parts.push('Starting');
    }
    if (started !== null) {
      const end = entry.state === 'running' ? now : entry.endedAt || now;
      parts.push(formatDuration(Math.max(0, end - started)));
    }
    return { title, meta: parts.join(' · '), state: entry.state, clickable };
  }

  // The tooltip of the Agents button: "2 working · 1 done".
  function summaryText(list) {
    if (!list.length) return '';
    const working = list.filter((entry) => WORKING.has(entry.state)).length;
    const failed = list.filter((entry) => entry.state === 'failed' || entry.state === 'timeout').length;
    const done = list.filter((entry) => entry.state === 'ok').length;
    const parts = [];
    if (working) parts.push(`${working} working`);
    if (done) parts.push(`${done} done`);
    if (failed) parts.push(`${failed} failed`);
    const stopped = list.length - working - done - failed;
    if (stopped) parts.push(`${stopped} stopped`);
    return parts.join(' · ');
  }

  function isWorking(list) {
    return list.some((entry) => WORKING.has(entry.state));
  }

  const api = { visibleAgents, describeAgent, summaryText, isWorking };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DsxAgentView = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
