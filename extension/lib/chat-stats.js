// The figures of the stats line under the composer: how many turns and steps a chat took, how long the
// model spent and how fast it wrote, and how many tokens went in and out.
//
// Nothing is estimated except where it says so. The stream filter counts the chunks the model wrote
// (one token each) and the page hook stamps when a request started, when its first token came and when
// it ended. DeepSeek gives the token total of the chat, and the input is that total minus what the
// model wrote. A chat that was open before this tab saw it has no complete figures, so it shows no input.
(function (root) {
  'use strict';

  const MAX_CHATS = 30;

  function blank(complete) {
    return { turns: 0, steps: 0, llmMs: 0, ttftMs: 0, ttftCount: 0, genMs: 0, genTokens: 0, output: 0, usage: 0, complete };
  }

  // `store` keeps the figures while the tab lives, so a reload of the page does not lose them:
  // { read() -> object | null, write(object) }.
  function createChatStats({ store = null } = {}) {
    const chats = new Map();
    try {
      const saved = store && store.read();
      if (saved && typeof saved === 'object') for (const [id, chat] of Object.entries(saved)) chats.set(id, { ...blank(false), ...chat });
    } catch {
      // Unreadable figures are simply not used.
    }
    // The request of each chat that is being answered right now.
    const open = new Map();

    function save() {
      if (!store) return;
      while (chats.size > MAX_CHATS) chats.delete(chats.keys().next().value);
      try {
        store.write(Object.fromEntries(chats));
      } catch {
        // Storage can be blocked; the figures then last until the page reloads.
      }
    }

    // The newest chat goes last, so the oldest ones are the ones dropped.
    function touch(id, chat) {
      chats.delete(id);
      chats.set(id, chat);
    }

    return {
      // A message the user wrote. `first` is the opening one, which starts the figures from nothing.
      userTurn(id, first) {
        if (!id) return;
        const chat = first ? blank(true) : chats.get(id) || blank(false);
        chat.turns += 1;
        touch(id, chat);
        save();
      },
      streamStart(id, at) {
        if (id) open.set(id, { start: at, first: null });
      },
      firstToken(id, at) {
        const request = open.get(id);
        if (request && request.first === null) request.first = at;
      },
      // `live` is false for a reply the page replays, which was not just written and so is not counted.
      replyEnd(id, at, tokens, live) {
        const request = open.get(id);
        open.delete(id);
        if (!request || !live) return;
        const chat = chats.get(id) || blank(false);
        chat.steps += 1;
        chat.llmMs += Math.max(at - request.start, 0);
        chat.output += tokens || 0;
        if (request.first !== null) {
          chat.ttftMs += Math.max(request.first - request.start, 0);
          chat.ttftCount += 1;
          chat.genMs += Math.max(at - request.first, 0);
          // The first token ends the wait and starts the clock, so the speed counts the ones after it.
          chat.genTokens += Math.max((tokens || 0) - 1, 0);
        }
        touch(id, chat);
        save();
      },
      // The token total DeepSeek counted for the whole chat after its newest message.
      usage(id, tokens) {
        const chat = chats.get(id);
        if (!chat || !(tokens > 0) || chat.usage === tokens) return;
        chat.usage = tokens;
        save();
      },
      // The figures to show, or null when the chat has no finished step yet.
      summary(id) {
        const chat = chats.get(id);
        if (!chat || chat.steps === 0) return null;
        return {
          turns: chat.turns,
          steps: chat.steps,
          llmMs: chat.llmMs,
          ttftMs: chat.ttftCount ? chat.ttftMs / chat.ttftCount : null,
          tokensPerSecond: chat.genMs > 0 && chat.genTokens > 0 ? chat.genTokens / (chat.genMs / 1000) : null,
          output: chat.output,
          input: chat.complete && chat.usage > chat.output ? chat.usage - chat.output : null,
        };
      },
    };
  }

  function formatDuration(ms) {
    const seconds = Math.max(0, ms) / 1000;
    if (seconds < 60) return `${seconds.toFixed(1)}s`;
    const minutes = Math.floor(seconds / 60);
    return `${minutes}m ${Math.round(seconds - minutes * 60)}s`;
  }

  // "2 turns · 3 steps | LLM 7.5s | TTFT avg 1.5s · 68 tok/s | Input 23.3K tok · Output 407 tok".
  // A figure that is not known is left out, never shown as zero.
  function formatStats(summary, formatTokens) {
    if (!summary) return '';
    const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
    const parts = [`${plural(summary.turns, 'turn')} · ${plural(summary.steps, 'step')}`, `LLM ${formatDuration(summary.llmMs)}`];
    if (summary.ttftMs !== null) {
      const speed = summary.tokensPerSecond ? ` · ${Math.round(summary.tokensPerSecond)} tok/s` : '';
      parts.push(`TTFT avg ${formatDuration(summary.ttftMs)}${speed}`);
    }
    if (summary.output > 0) {
      parts.push(summary.input !== null
        ? `Input ${formatTokens(summary.input)} tok · Output ${formatTokens(summary.output)} tok`
        : `Output ${formatTokens(summary.output)} tok`);
    }
    return parts.join(' | ');
  }

  const api = { createChatStats, formatStats, formatDuration };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DsxChatStats = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
