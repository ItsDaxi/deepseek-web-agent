// Shows how many tokens the model has spent thinking, in the header of each thinking block.
//
// DeepSeek streams the reasoning one token per chunk, so the stream filter counts chunks and this
// only draws the number. It is exact for replies streamed while this page is open. Blocks loaded
// from an earlier visit have no count, so they show none rather than a guess.
(function (root) {
  'use strict';

  // Same markers think-collapse.js relies on: the hashed class names change with every build.
  const CONTAINER = '[style*="--collapsible-area-title-height"]';
  const THINK_CONTENT = '.ds-think-content';
  const MARK = 'data-dsx-think';
  const BADGE = 'data-dsx-tokens';
  const SESSION_ID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

  function createThinkCounter({ format, enabled = () => true } = {}) {
    // Replies of each chat that were streamed here, oldest first.
    const sessions = new Map();
    let latestSession = null;
    let frame = null;

    function entriesOf(sessionId) {
      let entries = sessions.get(sessionId);
      if (!entries) {
        entries = [];
        sessions.set(sessionId, entries);
      }
      return entries;
    }

    // Which chat is on screen. A new chat has no id in its address until its first reply is done.
    function currentEntries() {
      for (const [sessionId, entries] of sessions) {
        if (location.pathname.includes(sessionId)) return entries;
      }
      return !SESSION_ID.test(location.pathname) && latestSession ? sessions.get(latestSession) || [] : [];
    }

    function update({ sessionId, messageId, tokens, exact = true, done = false }) {
      const key = sessionId || 'chat';
      const entries = entriesOf(key);
      let entry = entries.find((item) => item.messageId === messageId);
      if (!entry) {
        entry = { messageId, tokens: 0, exact: true, done: false };
        entries.push(entry);
      }
      entry.tokens = tokens;
      entry.exact = entry.exact && exact;
      entry.done = done;
      latestSession = key;
      schedule();
    }

    // A block holds thinking while its text is on screen. The mark stays when the block is collapsed
    // and the text goes away, so the block can still be told from other collapsible ones.
    function thinkBlocks() {
      for (const container of document.querySelectorAll(CONTAINER)) {
        if (!container.hasAttribute(MARK) && container.querySelector(THINK_CONTENT)) container.setAttribute(MARK, '');
      }
      return [...document.querySelectorAll(`${CONTAINER}[${MARK}]`)];
    }

    // The element that holds the words "Thought for N seconds". Looked up by being the first one with
    // text of its own, because the wording changes with the language and the class names are hashed.
    function titleOf(header) {
      for (const node of header.querySelectorAll('*')) {
        if (node.hasAttribute(BADGE)) continue;
        for (const child of node.childNodes) {
          if (child.nodeType === 3 && child.textContent.trim()) return node;
        }
      }
      return header;
    }

    function drawBadge(container, text) {
      const header = container.firstElementChild;
      if (!header) return;
      let badge = container.querySelector(`[${BADGE}]`);
      if (!text) {
        if (badge) badge.remove();
        return;
      }
      if (!badge) {
        badge = document.createElement('span');
        badge.setAttribute(BADGE, '');
        // Part of the title: same size, weight, font and colour as the words before it.
        badge.style.cssText = 'margin-left:.35em;font:inherit;color:inherit;white-space:nowrap;font-variant-numeric:tabular-nums;pointer-events:none;';
      }
      const title = titleOf(header);
      if (badge.parentElement !== title) title.append(badge);
      if (badge.textContent !== text) badge.textContent = text;
    }

    // The newest block belongs to the newest reply, and so on backwards, which stays right when the
    // page's list drops old blocks from the top as they scroll out of view.
    function apply() {
      frame = null;
      const blocks = thinkBlocks();
      if (!enabled()) {
        for (const container of blocks) drawBadge(container, '');
        return;
      }
      const entries = currentEntries();
      blocks.forEach((container, index) => {
        const entry = entries[entries.length - (blocks.length - index)];
        // "Thinking · 85 tokens" while it thinks, "Thought for 3 seconds · 85 tokens" once it is done.
        const words = entry ? `${format(entry.tokens)} ${entry.tokens === 1 ? 'token' : 'tokens'}` : '';
        drawBadge(container, entry && entry.exact && entry.tokens > 0 ? `· ${words}` : '');
      });
    }

    function schedule() {
      if (!frame) frame = requestAnimationFrame(apply);
    }

    return { update, schedule };
  }

  root.DsxThinkTokens = { createThinkCounter };
})(globalThis);
