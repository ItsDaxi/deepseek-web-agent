// Removes tool syntax from DeepSeek's responses before the page can render it, and reports the
// tool calls it finds. Works on the live SSE stream and on the history_messages JSON.
(function (root) {
  'use strict';

  const isNode = typeof module !== 'undefined' && module.exports;
  const Protocol = isNode ? require('./protocol.js') : root.DsxProtocol;
  const ContextUsage = isNode ? require('./context-usage.js') : root.DsxContextUsage;

  const OPEN_TAG = new RegExp(`<dsx:(${Protocol.TOOL_NAMES.join('|')})\\b`);

  // Tail of the buffer that may still grow into an opening tag, optionally wrapped in a code fence.
  const TAG_PREFIX = '<(?:d(?:s(?:x(?::[a-z]*)?)?)?)?';
  const HOLD_BACK = new RegExp(
    `(?:(?:^|\\n)[ \\t]*\`{1,3}[\\w-]*[ \\t]*(?:\\r?\\n[ \\t]*)?(?:${TAG_PREFIX})?|${TAG_PREFIX})$`,
  );
  const FENCE_BEFORE_TAG = /(^|\n)[ \t]*`{3,}[\w-]*[ \t]*\r?\n[ \t]*$/;
  const PARTIAL_CLOSE = /<\/?(?:d(?:s(?:x(?::[a-z]*)?)?)?)?$/;
  const STRIPPED_PLACEHOLDER = '[tool call]';

  function sentinel(id) {
    return `\n\n\`\`\`dsx-tool\n${Protocol.SENTINEL_PREFIX}${id}\n\`\`\`\n\n`;
  }

  // File content must survive exactly, apart from the line breaks around the tags themselves.
  function cleanBody(tool, text) {
    if (tool === 'write' || tool === 'edit') return text.replace(/^\r?\n/, '').replace(/\r?\n$/, '');
    return text.replace(/^\s*\r?\n/, '').replace(/\s+$/, '');
  }

  // mode "call": replaces every tool call with a sentinel. Text between calls is held back until
  // the next call proves it was narration and not output the model made up, and text after the
  // last call is dropped. mode "strip": replaces every tool call with a placeholder (reasoning).
  function createToolScanner({ mode = 'call', nextId, startAfter = false, onOpen, onPartial, onCall, onIncomplete } = {}) {
    let buffer = '';
    let state = startAfter ? 'after' : 'text';
    let current = null;
    let held = '';

    function complete(body) {
      if (mode === 'call') {
        if (onCall) onCall({ ...current, command: cleanBody(current.tool, body) });
        state = 'after';
      } else {
        state = 'text';
      }
      current = null;
    }

    function openCall(source, output) {
      buffer = buffer.slice(source.index + source[0].length);
      state = 'attributes';
      if (mode === 'call') {
        const id = nextId();
        current = { id, tool: source[1] };
        if (onOpen) onOpen(current);
        return output + sentinel(id);
      }
      current = { tool: source[1] };
      return output + STRIPPED_PLACEHOLDER;
    }

    function push(text) {
      buffer += text;
      let output = '';

      for (;;) {
        if (state === 'after') {
          const open = OPEN_TAG.exec(buffer);
          if (!open) {
            const hold = HOLD_BACK.exec(buffer);
            const end = hold ? hold.index : buffer.length;
            held += buffer.slice(0, end);
            buffer = buffer.slice(end);
            return output;
          }
          held += buffer.slice(0, open.index).replace(FENCE_BEFORE_TAG, '$1');
          output += held;
          held = '';
          output = openCall(open, output);
          continue;
        }

        if (state === 'text') {
          const open = OPEN_TAG.exec(buffer);
          if (!open) {
            const hold = HOLD_BACK.exec(buffer);
            const end = hold ? hold.index : buffer.length;
            output += buffer.slice(0, end);
            buffer = buffer.slice(end);
            return output;
          }
          output += buffer.slice(0, open.index).replace(FENCE_BEFORE_TAG, '$1');
          output = openCall(open, output);
          continue;
        }

        if (state === 'attributes') {
          const end = buffer.indexOf('>');
          if (end === -1) return output;
          const source = buffer.slice(0, end);
          current.attributes = Protocol.parseAttributes(source);
          buffer = buffer.slice(end + 1);
          if (source.trimEnd().endsWith('/')) complete('');
          else state = 'command';
          continue;
        }

        // state === 'command'
        const closeTag = `</dsx:${current.tool}>`;
        const close = buffer.indexOf(closeTag);
        if (close === -1) {
          if (onPartial && current.id) {
            onPartial({ ...current, command: cleanBody(current.tool, buffer.replace(PARTIAL_CLOSE, '')) });
          }
          return output;
        }
        const body = buffer.slice(0, close);
        buffer = buffer.slice(close + closeTag.length);
        complete(body);
      }
    }

    function flush() {
      let output = '';
      if (state === 'text') {
        output = buffer;
      } else if (state === 'after') {
        // Nothing followed the last call, so what was held back is the model's own made-up output.
        held = '';
      } else if (current && current.id && onIncomplete) {
        onIncomplete({ ...current, command: cleanBody(current.tool, buffer) });
      }
      buffer = '';
      state = 'after';
      current = null;
      return output;
    }

    return { push, flush };
  }

  // DeepSeek ends a reply with a TIP fragment ("This response is AI-generated, for reference only."). It is
  // a notice, not part of the answer, so it is removed before the page ever sees it. Done in place because
  // the page applies the patch it is handed.
  function dropNotices(fragments) {
    for (let index = fragments.length - 1; index >= 0; index -= 1) {
      if (fragments[index] && fragments[index].type === 'TIP') fragments.splice(index, 1);
    }
  }

  function isContentPath(path) {
    return /^response\/fragments\/-?\d+\/content$/.test(path);
  }

  // Rewrites an append-only SSE stream into another append-only stream, because the page parses
  // xhr.responseText cumulatively and must never see earlier text change.
  function createSseRewriter({ sessionId, live = true, rewriteTitle, onEvent = () => {} } = {}) {
    let partialLine = '';
    let namedEvent = null;
    let skipBlankLine = false;
    let path = null;
    let messageId = null;
    let callCount = 0;
    let scanner = null;
    let fragmentType = null;
    let toolCalled = false;
    let finished = false;
    // DeepSeek streams the reasoning one token per chunk, so counting chunks counts tokens. Checked
    // against the model's own tokenizer: every chunk of a recorded reply was exactly one token. A
    // replayed stream sends its text in big pieces, so what it counts is marked as not exact.
    let thinkTokens = 0;
    let thinkOpen = false;
    // Everything the model wrote, reasoning and answer, counted the same way. The first one also marks
    // when the reply began, and the end of the stream reports the total, for the stats line.
    let outputTokens = 0;
    let firstTokenSeen = false;
    // What the model wrote as its answer, as it wrote it. A helper's report is the answer of its last reply.
    let answer = '';
    let errorSeen = false;

    function nextId() {
      callCount += 1;
      return `${String(sessionId || 'chat').slice(0, 8)}-${messageId === null ? 'x' : messageId}-${callCount}`;
    }

    function callScanner() {
      return createToolScanner({
        mode: 'call',
        nextId,
        onOpen: (call) => {
          toolCalled = true;
          onEvent({ type: 'tool-open', id: call.id, tool: call.tool, sessionId, live });
        },
        onPartial: (call) => onEvent({ type: 'tool-partial', id: call.id, tool: call.tool, sessionId, command: call.command, attributes: call.attributes, live }),
        onCall: (call) => onEvent({ type: 'tool-call', id: call.id, tool: call.tool, sessionId, command: call.command, attributes: call.attributes || {}, live }),
        onIncomplete: (call) => onEvent({ type: 'tool-incomplete', id: call.id, tool: call.tool, sessionId, command: call.command, attributes: call.attributes || {}, live }),
      });
    }

    function reportThink(done) {
      if (thinkTokens === 0) return;
      onEvent({ type: 'think-tokens', sessionId, messageId, tokens: thinkTokens, exact: live, done });
    }

    function endThink() {
      if (!thinkOpen) return;
      thinkOpen = false;
      reportThink(true);
    }

    function countThinkToken() {
      thinkOpen = true;
      thinkTokens += 1;
      reportThink(false);
    }

    function countOutputToken() {
      outputTokens += 1;
      if (firstTokenSeen) return;
      firstTokenSeen = true;
      onEvent({ type: 'first-token', sessionId, messageId, live });
    }

    function beginFragment(type) {
      if (fragmentType === 'THINK' && type !== 'THINK') endThink();
      fragmentType = type;
      if (type === 'THINK') {
        scanner = createToolScanner({ mode: 'strip' });
      } else if (type === 'RESPONSE') {
        scanner = callScanner();
        if (toolCalled) scanner.flush();
      } else {
        scanner = null;
      }
    }

    function flushFragment() {
      if (!scanner) return '';
      const text = scanner.flush();
      if (!text) return '';
      return `data: ${JSON.stringify({ p: 'response/fragments/-1/content', o: 'APPEND', v: text })}\n\n`;
    }

    function rewriteFragments(fragments) {
      forEachFragment(fragments);
      dropNotices(fragments);
    }

    function forEachFragment(fragments) {
      fragments.forEach((fragment, index) => {
        beginFragment(fragment.type);
        if (fragment.type === 'THINK' && typeof fragment.content === 'string' && fragment.content !== '') countThinkToken();
        if ((fragment.type === 'THINK' || fragment.type === 'RESPONSE') && typeof fragment.content === 'string' && fragment.content !== '') countOutputToken();
        if (fragment.type === 'RESPONSE' && typeof fragment.content === 'string') answer += fragment.content;
        if (scanner && typeof fragment.content === 'string') {
          let content = scanner.push(fragment.content);
          if (index < fragments.length - 1) content += scanner.flush();
          fragment.content = content;
        }
      });
    }

    // DeepSeek ends a reply with the token total of the whole chat so far.
    function reportUsage(patch) {
      if (!Array.isArray(patch.v)) return;
      const entry = patch.v.find((item) => item && item.p === 'accumulated_token_usage');
      if (entry && Number.isFinite(entry.v) && entry.v > 0) onEvent({ type: 'usage', sessionId, tokens: entry.v });
    }

    function rewritePatch(line, patch) {
      if (patch.p !== undefined) path = patch.p;

      if (patch.p === undefined && patch.v && typeof patch.v === 'object' && patch.v.response) {
        rewriteFragments(patch.v.response.fragments || []);
        return `data: ${JSON.stringify(patch)}\n`;
      }

      if (path === 'response/fragments' && Array.isArray(patch.v)) {
        const prefix = flushFragment();
        rewriteFragments(patch.v);
        return `${prefix}data: ${JSON.stringify(patch)}\n`;
      }

      if (path === 'response/status' || (path === 'response' && patch.o === 'BATCH')) {
        endThink();
        reportUsage(patch);
        return `${flushFragment()}${line}\n`;
      }

      if (isContentPath(path) && typeof patch.v === 'string' && patch.o !== 'SET' && scanner) {
        if (fragmentType === 'THINK' && patch.v !== '') countThinkToken();
        if ((fragmentType === 'THINK' || fragmentType === 'RESPONSE') && patch.v !== '') countOutputToken();
        if (fragmentType === 'RESPONSE') answer += patch.v;
        const text = scanner.push(patch.v);
        if (text === '' && patch.p === undefined) {
          skipBlankLine = true;
          return '';
        }
        return `data: ${JSON.stringify({ ...patch, v: text })}\n`;
      }

      return `${line}\n`;
    }

    function rewriteNamedEvent(line, data) {
      let parsed = null;
      try {
        parsed = JSON.parse(data);
      } catch {
        return `${line}\n`;
      }
      if (namedEvent === 'ready') {
        messageId = parsed.response_message_id;
        onEvent({ type: 'stream-ready', sessionId, messageId, live });
      } else if (namedEvent === 'hint' && parsed.type === 'error') {
        // DeepSeek refuses a message inside a normal 200 answer: "parallel_chat_limit" when a third chat
        // generates at once, "rate_limit_reached" when messages come too fast. The page shows the text and a
        // retry button; this reports the reason so a helper can wait and try again.
        errorSeen = true;
        onEvent({ type: 'stream-error', sessionId, messageId, reason: parsed.finish_reason || 'error', message: parsed.content || '', live });
      } else if (namedEvent === 'title' && rewriteTitle && typeof parsed.content === 'string') {
        const title = rewriteTitle(parsed.content);
        if (title !== parsed.content) return `data: ${JSON.stringify({ ...parsed, content: title })}\n`;
      }
      return `${line}\n`;
    }

    function rewriteLine(rawLine) {
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;

      if (line === '') {
        namedEvent = null;
        if (skipBlankLine) {
          skipBlankLine = false;
          return '';
        }
        return '\n';
      }
      if (line.startsWith('event:')) {
        namedEvent = line.slice(6).trim();
        // Anything held back has to reach the page before it treats the message as closed.
        const prefix = ['close', 'finish', 'error'].includes(namedEvent) ? flushFragment() : '';
        return `${prefix}${line}\n`;
      }
      if (!line.startsWith('data:')) return `${line}\n`;

      const data = line.slice(5).trim();
      if (namedEvent) return rewriteNamedEvent(line, data);

      let patch = null;
      try {
        patch = JSON.parse(data);
      } catch {
        return `${line}\n`;
      }
      return rewritePatch(line, patch);
    }

    return {
      feed(chunk) {
        partialLine += chunk;
        const lines = partialLine.split('\n');
        partialLine = lines.pop();
        return lines.map(rewriteLine).join('');
      },
      end() {
        if (finished) return '';
        finished = true;
        const rest = partialLine ? rewriteLine(partialLine) : '';
        partialLine = '';
        endThink();
        onEvent({ type: 'reply-end', sessionId, messageId, live, tokens: outputTokens, think: thinkTokens, toolCalled, answer, failed: errorSeen });
        return rest + flushFragment();
      },
    };
  }

  // Rewrites a parsed history_messages payload in place. Returns the tool calls and results found
  // so that cards can be rebuilt after a page reload, without ever executing anything again.
  function rewriteHistory(payload, fallbackSessionId) {
    const data = payload && payload.data && payload.data.biz_data;
    const messages = data && data.chat_messages;
    const tools = [];
    const results = [];
    if (!Array.isArray(messages)) return { tools, results, tokens: null, sessionId: fallbackSessionId };

    const sessionId = (data.chat_session && data.chat_session.id) || fallbackSessionId;
    const tokens = ContextUsage.latestUsage(messages, data.chat_session && data.chat_session.current_message_id);

    const rewriteUserText = (text) => {
      const stripped = Protocol.stripInjected(text);
      const found = Protocol.parseResultMessages(stripped);
      if (!found.length) return stripped;
      results.push(...found);
      return `${Protocol.RESULT_MARKER_PREFIX}${found.map((result) => result.id).join('+')}`;
    };

    const rewriteAssistant = (message) => {
      let callCount = 0;
      const nextId = () => {
        callCount += 1;
        return `${String(sessionId || 'chat').slice(0, 8)}-${message.message_id}-${callCount}`;
      };
      const rewriteText = (text, mode) => {
        const scanner = createToolScanner({
          mode,
          nextId,
          onCall: (call) => tools.push({ id: call.id, tool: call.tool, sessionId, command: call.command, attributes: call.attributes || {} }),
          onIncomplete: (call) => tools.push({ id: call.id, tool: call.tool, sessionId, command: call.command, attributes: call.attributes || {}, incomplete: true }),
        });
        return scanner.push(text) + scanner.flush();
      };
      if (Array.isArray(message.fragments)) dropNotices(message.fragments);
      for (const fragment of message.fragments || []) {
        if (typeof fragment.content !== 'string') continue;
        if (fragment.type === 'RESPONSE') fragment.content = rewriteText(fragment.content, 'call');
        else if (fragment.type === 'THINK') fragment.content = rewriteText(fragment.content, 'strip');
      }
      if (typeof message.content === 'string') message.content = rewriteText(message.content, 'call');
      if (typeof message.thinking_content === 'string') {
        message.thinking_content = rewriteText(message.thinking_content, 'strip');
      }
    };

    for (const message of messages) {
      if (message.role === 'USER') {
        for (const fragment of message.fragments || []) {
          if (typeof fragment.content === 'string') fragment.content = rewriteUserText(fragment.content);
        }
        if (typeof message.content === 'string') message.content = rewriteUserText(message.content);
      } else if (message.role === 'ASSISTANT') {
        rewriteAssistant(message);
      }
    }
    return { tools, results, tokens, sessionId };
  }

  const api = { createToolScanner, createSseRewriter, rewriteHistory };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DsxStreamFilter = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
