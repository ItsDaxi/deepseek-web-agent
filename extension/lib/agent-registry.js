// The list of helpers (sub-agents) the background script keeps for each chat that asked for them: what
// each is called, how far it got, how many tokens it used and where its chat is. The page shows this list
// in its Agents menu. It is kept after a helper ends, so the list survives a reload of the page and a
// finished helper can still be opened.
(function (root) {
  'use strict';

  // Only this many helpers are kept for one tab. The oldest finished ones go first.
  const MAX_PER_OWNER = 20;
  const ACTIVE_STATES = new Set(['queued', 'running']);

  function createAgentRegistry({ maxPerOwner = MAX_PER_OWNER } = {}) {
    const entries = new Map();

    function add(entry) {
      const created = {
        description: '',
        state: 'queued',
        input: null,
        output: 0,
        steps: 0,
        sessionId: null,
        tabId: null,
        startedAt: null,
        endedAt: null,
        ...entry,
      };
      entries.set(created.id, created);
      prune(created.owner);
      return created;
    }

    function update(id, patch) {
      const entry = entries.get(id);
      if (!entry) return null;
      Object.assign(entry, patch);
      return entry;
    }

    function owned(owner) {
      return [...entries.values()].filter((entry) => entry.owner === owner);
    }

    function prune(owner) {
      const mine = owned(owner);
      for (const entry of mine) {
        if (mine.length <= maxPerOwner) return;
        if (ACTIVE_STATES.has(entry.state)) continue;
        entries.delete(entry.id);
        mine.splice(mine.indexOf(entry), 1);
      }
    }

    // What the page needs to draw the list, and nothing of the task text or the tab.
    function snapshot(owner) {
      return owned(owner).map((entry) => ({
        id: entry.toolId,
        description: entry.description,
        state: entry.state,
        startedAt: entry.startedAt,
        endedAt: entry.endedAt,
        input: entry.input,
        output: entry.output,
        steps: entry.steps,
        sessionId: entry.sessionId,
        hasTab: entry.tabId !== null,
      }));
    }

    // Takes one finished helper off the list. A helper that is queued or working cannot be removed: it
    // is stopped from its card, and then it is finished.
    function dismiss(owner, toolId) {
      const entry = owned(owner).find((candidate) => candidate.toolId === toolId);
      if (!entry || ACTIVE_STATES.has(entry.state)) return false;
      entries.delete(entry.id);
      return true;
    }

    // Takes every finished helper of a tab off the list, and says how many it was.
    function clearFinished(owner) {
      let removed = 0;
      for (const entry of owned(owner)) {
        if (ACTIVE_STATES.has(entry.state)) continue;
        entries.delete(entry.id);
        removed += 1;
      }
      return removed;
    }

    return {
      add,
      update,
      dismiss,
      clearFinished,
      snapshot,
      get: (id) => entries.get(id) || null,
      findByTool: (owner, toolId) => owned(owner).find((entry) => entry.toolId === toolId) || null,
      remove: (id) => entries.delete(id),
      removeOwner: (owner) => { for (const entry of owned(owner)) entries.delete(entry.id); },
    };
  }

  const api = { createAgentRegistry, MAX_PER_OWNER };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DsxAgentRegistry = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
