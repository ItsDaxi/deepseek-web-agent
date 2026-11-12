// The task list the model keeps for itself: it writes the whole list each time, one task to a line, and the
// page shows it above the composer for as long as the chat is open.
//
//   [x] done
//   [~] being worked on
//   [ ] still to do
(function (root) {
  'use strict';

  const MAX_TASKS = 30;
  const MAX_TASK_CHARS = 200;
  const DONE = new Set(['x', '✓', '✔', 'v']);
  const ACTIVE = new Set(['~', '>', '-', '*', '/']);
  // A line starts with an optional list bullet or number, then a box such as [x], then the text.
  const BOX = /^\s*(?:[-*+]\s+|\d+[.)]\s+)?\[\s*([^\]]?)\s*\]\s*(.*)$/;
  const BULLET = /^\s*(?:[-*+]\s+|\d+[.)]\s+)?(.*)$/;

  function statusOf(mark) {
    const lower = mark.toLowerCase();
    if (DONE.has(lower)) return 'done';
    if (ACTIVE.has(lower)) return 'active';
    return 'pending';
  }

  // The tasks in `text`, in order. A line without a box counts as a task still to do, and blank lines are
  // skipped. Anything past the limits is cut rather than refused, so a long list still shows.
  function parseTodos(text) {
    const tasks = [];
    for (const line of String(text || '').split(/\r?\n/)) {
      if (!line.trim()) continue;
      const boxed = BOX.exec(line);
      const label = boxed ? boxed[2] : BULLET.exec(line)[1];
      const clean = label.trim().slice(0, MAX_TASK_CHARS);
      if (!clean) continue;
      tasks.push({ text: clean, status: boxed ? statusOf(boxed[1]) : 'pending' });
      if (tasks.length >= MAX_TASKS) break;
    }
    // Only one task is being worked on at a time: the first one keeps the mark.
    let seen = false;
    for (const task of tasks) {
      if (task.status !== 'active') continue;
      if (seen) task.status = 'pending';
      seen = true;
    }
    return tasks;
  }

  function countDone(tasks) {
    return tasks.filter((task) => task.status === 'done').length;
  }

  // What the model is told once the list is saved.
  function describeSaved(tasks) {
    if (!tasks.length) return 'The task list is now empty.';
    const done = countDone(tasks);
    const active = tasks.find((task) => task.status === 'active');
    const rest = done === tasks.length ? 'Every task is done.' : active ? `Working on: ${active.text}` : 'No task is marked as being worked on.';
    return `Task list saved: ${done} of ${tasks.length} done. ${rest}`;
  }

  // The short title of the card in the chat.
  function titleOf(tasks) {
    return tasks.length ? `Tasks ${countDone(tasks)}/${tasks.length}` : 'Tasks cleared';
  }

  const api = { parseTodos, countDone, describeSaved, titleOf, MAX_TASKS };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DsxTodo = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
