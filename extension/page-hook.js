// Runs in the page's own JavaScript world so it can wrap the XMLHttpRequest calls DeepSeek makes.
// It only rewrites traffic and reports what it sees: it can never start a command by itself.
(function () {
  'use strict';

  const Protocol = window.DsxProtocol;
  const Filter = window.DsxStreamFilter;
  const ContextUsage = window.DsxContextUsage;

  const STREAM_PATHS = [
    '/api/v0/chat/completion',
    '/api/v0/chat/regenerate',
    '/api/v0/chat/continue',
    '/api/v0/chat/edit_message',
    '/api/v0/chat/resume_stream',
  ];
  const HISTORY_PATH = '/api/v0/chat/history_messages';
  const SETTINGS_PATH = '/api/v0/client/settings';
  const MODEL_STORE_KEY = '__ds_remote_feature_store_model';
  const STORE_READ_DELAY_MS = 500;
  const TITLE_PATH = '/api/v0/chat_session/update_title';
  const RESULT_MARKER = new RegExp(`^${Protocol.RESULT_MARKER_PREFIX}(\\S+)$`);
  const LEAKED_TITLE = /\b(dsx|shell tool|tool syntax|system prompt)\b/i;
  const SEND_RETRY_MS = 250;
  const COMPOSER_POLL_MS = 15;
  const SEND_TIMEOUT_MS = 40000;
  const ACCEPT_WAIT_MS = 8000;
  const ENTER_ATTEMPTS = 3;
  const TITLE_MAX_CHARS = 40;

  // `agent` is true in the tab of a helper, whose chat gets no helper tool.
  const config = { env: null, thinking: null, agent: false };
  // The last message a helper's tab sent through the composer, kept so it can be sent again after DeepSeek
  // refused it with a rate limit: { key, body } for a result, { text } for the opening task.
  let lastSent = null;
  const requests = new WeakMap();
  const pendingResults = new Map();
  // The instructions already sent in each chat, by session id.
  const extraSent = new Map();
  // The MCP tool list already sent in each chat, by session id.
  const mcpSent = new Map();
  const resultQueue = [];
  let activeStreams = 0;
  let pumping = false;

  const proto = XMLHttpRequest.prototype;
  const nativeOpen = proto.open;
  const nativeSend = proto.send;
  const nativeSetHeader = proto.setRequestHeader;
  const nativeResponseText = Object.getOwnPropertyDescriptor(proto, 'responseText').get;
  const nativeResponse = Object.getOwnPropertyDescriptor(proto, 'response').get;
  const nativeTextareaValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;

  function post(message) {
    window.postMessage({ source: 'dsx-page', ...message }, location.origin);
  }

  function parseUrl(url) {
    try {
      return new URL(url, location.href);
    } catch {
      return null;
    }
  }

  // ---- Requests ------------------------------------------------------------------------------

  // Asks for the full history so results and tool calls always come back through rewriteHistory,
  // instead of being merged with a local cache that does not hold them.
  function withoutHistoryCache(url) {
    url.searchParams.delete('cache_version');
    url.searchParams.delete('cache_reset_at');
    return url.href;
  }

  function isFirstMessage(path, body) {
    if (path === '/api/v0/chat/completion') return body.parent_message_id === null;
    return path === '/api/v0/chat/edit_message' && Number(body.message_id) === 1;
  }

  function rewriteRequestBody(request, rawBody) {
    let body = null;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return rawBody;
    }
    request.sessionId = body.chat_session_id;
    // The Effort switch decides DeepThink, and Search is always on. The page's own buttons are kept in
    // step with this by the content script, so this only matters when they could not be.
    if (typeof config.thinking === 'boolean' && 'thinking_enabled' in body) body.thinking_enabled = config.thinking;
    if ('search_enabled' in body) body.search_enabled = true;
    if (typeof body.prompt !== 'string') return JSON.stringify(body);

    const marker = RESULT_MARKER.exec(body.prompt.trim());
    if (marker && pendingResults.has(marker[1])) {
      body.prompt = pendingResults.get(marker[1]);
      pendingResults.delete(marker[1]);
      for (const id of marker[1].split('+')) post({ type: 'result-delivered', id });
    } else {
      const full = isFirstMessage(request.path, body);
      if (full) request.firstUserText = body.prompt;
      // The user's own instructions go out once per chat, and again only when their text changes.
      // A chat that was sent some and now has none is told to forget them.
      const wanted = (config.env && config.env.extra) || '';
      const sent = extraSent.get(request.sessionId) || '';
      const extra = wanted && wanted !== sent ? wanted : null;
      const retire = !wanted && Boolean(sent);
      // The tools of the user's MCP servers follow the same rule: once per chat, and again when they change.
      const wantedMcp = Protocol.describeMcp(config.env && config.env.mcp);
      const sentMcp = mcpSent.get(request.sessionId) || '';
      const mcp = wantedMcp && wantedMcp !== sentMcp ? wantedMcp : null;
      const mcpRetire = !wantedMcp && Boolean(sentMcp);
      body.prompt = Protocol.injectPrompt(body.prompt, config.env, { full, extra, retire, agents: !config.agent, mcp, mcpRetire });
      if (extra) extraSent.set(request.sessionId, extra);
      if (retire) extraSent.delete(request.sessionId);
      if (mcp) mcpSent.set(request.sessionId, mcp);
      if (mcpRetire) mcpSent.delete(request.sessionId);
      // `first` is the opening message of a chat, so the stats of a chat can tell it was followed from the start.
      post({ type: 'user-turn', sessionId: request.sessionId, first: full });
    }
    return JSON.stringify(body);
  }

  proto.open = function (method, url, ...rest) {
    const parsed = parseUrl(url);
    let target = url;
    requests.delete(this);
    if (parsed && parsed.origin === location.origin) {
      if (parsed.pathname === HISTORY_PATH) {
        target = withoutHistoryCache(parsed);
        requests.set(this, { kind: 'history', sessionId: parsed.searchParams.get('chat_session_id') });
      } else if (STREAM_PATHS.includes(parsed.pathname)) {
        requests.set(this, { kind: 'stream', path: parsed.pathname, headers: {}, seen: 0, output: '' });
      } else if (parsed.pathname === SETTINGS_PATH && parsed.searchParams.get('scope') === 'model') {
        // Only read, to learn how many tokens a chat can hold. The page gets the answer untouched.
        requests.set(this, { kind: 'settings' });
      }
    }
    return nativeOpen.call(this, method, target, ...rest);
  };

  proto.setRequestHeader = function (name, value) {
    const request = requests.get(this);
    if (request && request.kind === 'stream') request.headers[name] = value;
    return nativeSetHeader.call(this, name, value);
  };

  proto.send = function (body) {
    const request = requests.get(this);
    if (request && request.kind === 'stream') {
      const outgoing = typeof body === 'string' ? rewriteRequestBody(request, body) : body;
      beginStream(this, request);
      return nativeSend.call(this, outgoing);
    }
    if (request && request.kind === 'settings') this.addEventListener('load', () => reportContextLimit(this));
    return nativeSend.call(this, body);
  };

  function reportContextLimit(xhr) {
    try {
      const payload = xhr.responseType === 'json' ? nativeResponse.call(xhr) : JSON.parse(nativeResponseText.call(xhr));
      const tokens = ContextUsage.contextLimit(payload);
      if (tokens) {
        post({ type: 'context-limit', tokens });
        return;
      }
    } catch {
      // Not the answer expected.
    }
    // The page saves its settings after it reads this answer, so its copy is read a moment later.
    setTimeout(reportStoredLimit, STORE_READ_DELAY_MS);
  }

  // The page keeps its model settings in localStorage and often does not download them again, so
  // that copy is the usual source of the limit. Reading it changes nothing.
  function reportStoredLimit() {
    try {
      const tokens = ContextUsage.storedContextLimit(localStorage.getItem(MODEL_STORE_KEY));
      if (tokens) post({ type: 'context-limit', tokens });
    } catch {
      // Storage is unavailable. The meter just shows no limit.
    }
  }

  reportStoredLimit();
  document.addEventListener('DOMContentLoaded', reportStoredLimit);

  // ---- Stream responses ----------------------------------------------------------------------

  // The moments the stats line needs are stamped here, in the page's own clock.
  const TIMED_EVENTS = new Set(['first-token', 'reply-end']);

  function beginStream(xhr, request) {
    activeStreams += 1;
    post({ type: 'stream-start', sessionId: request.sessionId, at: performance.now(), path: request.path });
    request.rewriter = Filter.createSseRewriter({
      sessionId: request.sessionId,
      // A resumed stream replays text the user may already have acted on, so it never auto-runs.
      live: request.path !== '/api/v0/chat/resume_stream' && request.path !== '/api/v0/chat/continue',
      rewriteTitle: (title) => fixLeakedTitle(request, title),
      onEvent: (event) => post(TIMED_EVENTS.has(event.type) ? { ...event, at: performance.now() } : event),
    });
    xhr.addEventListener('readystatechange', () => {
      if (xhr.readyState >= 3) streamView(xhr, request);
    });
    xhr.addEventListener('loadend', () => {
      streamView(xhr, request);
      activeStreams -= 1;
      post({ type: 'stream-end', sessionId: request.sessionId });
      pumpResults();
    });
  }

  function streamView(xhr, request) {
    if (xhr.responseType !== '' && xhr.responseType !== 'text') return '';
    const raw = nativeResponseText.call(xhr);
    const contentType = xhr.getResponseHeader('content-type') || '';
    if (!contentType.includes('text/event-stream')) return raw;
    if (raw.length > request.seen) {
      request.output += request.rewriter.feed(raw.slice(request.seen));
      request.seen = raw.length;
    }
    if (xhr.readyState === 4) request.output += request.rewriter.end();
    return request.output;
  }

  function fixLeakedTitle(request, title) {
    if (!request.firstUserText || !LEAKED_TITLE.test(title)) return title;
    const replacement = request.firstUserText.trim().slice(0, TITLE_MAX_CHARS);
    const xhr = new XMLHttpRequest();
    nativeOpen.call(xhr, 'POST', TITLE_PATH);
    for (const [name, value] of Object.entries(request.headers)) {
      if (!name.toLowerCase().startsWith('x-ds-pow')) nativeSetHeader.call(xhr, name, value);
    }
    nativeSend.call(xhr, JSON.stringify({ chat_session_id: request.sessionId, title: replacement }));
    return replacement;
  }

  // ---- History responses ---------------------------------------------------------------------

  function historyView(xhr, request) {
    if (request.text !== undefined) return request.text;
    const raw = nativeResponseText.call(xhr);
    if (xhr.readyState !== 4) return raw;
    try {
      const payload = JSON.parse(raw);
      const { tools, results, tokens, sessionId } = Filter.rewriteHistory(payload, request.sessionId);
      post({ type: 'history', tools, results, tokens, sessionId });
      request.text = JSON.stringify(payload);
    } catch {
      request.text = raw;
    }
    return request.text;
  }

  function rewrittenText(xhr) {
    const request = requests.get(xhr);
    if (!request) return null;
    if (request.kind === 'history') return historyView(xhr, request);
    if (request.kind === 'stream' && request.rewriter) return streamView(xhr, request);
    return null;
  }

  Object.defineProperty(proto, 'responseText', {
    configurable: true,
    enumerable: true,
    get() {
      const text = rewrittenText(this);
      return text === null ? nativeResponseText.call(this) : text;
    },
  });

  Object.defineProperty(proto, 'response', {
    configurable: true,
    enumerable: true,
    get() {
      if (this.responseType === '' || this.responseType === 'text') {
        const text = rewrittenText(this);
        if (text !== null) return text;
      } else if (this.responseType === 'json' && requests.get(this)?.kind === 'history' && this.readyState === 4) {
        const native = nativeResponse.call(this);
        if (native) {
          const { tools, results, tokens, sessionId } = Filter.rewriteHistory(native, requests.get(this).sessionId);
          if (tools.length || results.length || tokens) post({ type: 'history', tools, results, tokens, sessionId });
        }
        return native;
      }
      return nativeResponse.call(this);
    },
  });

  // ---- Sending results through the page's own composer ---------------------------------------

  function findComposer() {
    const areas = [...document.querySelectorAll('textarea')].filter((area) => area.getClientRects().length > 0);
    return areas[areas.length - 1] || null;
  }

  function setComposerValue(area, value) {
    nativeTextareaValue.call(area, value);
    area.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function pressEnter(area) {
    area.focus();
    for (const type of ['keydown', 'keypress', 'keyup']) {
      area.dispatchEvent(
        new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }),
      );
    }
  }

  function clickSendButton(area) {
    const scope = area.closest('form') || area.parentElement?.parentElement?.parentElement;
    const buttons = scope ? [...scope.querySelectorAll('button, [role="button"]')] : [];
    const button = buttons[buttons.length - 1];
    if (button) button.click();
  }

  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function sendThroughComposer(entry) {
    const deadline = Date.now() + SEND_TIMEOUT_MS;
    const marker = `${Protocol.RESULT_MARKER_PREFIX}${entry.key}`;
    let attempt = 0;
    let accepted = false;
    while (Date.now() < deadline) {
      if (!pendingResults.has(entry.key)) return true;
      const area = findComposer();
      if (!accepted && area && activeStreams === 0) {
        const draft = area.value === marker ? '' : area.value;
        area.setAttribute('data-dsx-sending', '');
        setComposerValue(area, marker);
        await delay(40);
        if (attempt < ENTER_ATTEMPTS) pressEnter(area);
        else clickSendButton(area);
        attempt += 1;
        // The page can spend seconds on its proof of work before the request leaves, with the marker
        // still in the composer. Pressing Enter again in that time sent the bare marker as a second
        // message, and the model answered it with "nothing new", once per extra press. So one press
        // gets a long wait, and only a request that never started is tried again.
        for (
          let waited = 0;
          waited < ACCEPT_WAIT_MS && area.value === marker && pendingResults.has(entry.key) && activeStreams === 0;
          waited += COMPOSER_POLL_MS
        ) {
          await delay(COMPOSER_POLL_MS);
        }
        // An emptied composer, a request that left, or a reply that started all prove the send was
        // accepted. Sending again here would post the result twice.
        accepted = area.value !== marker || !pendingResults.has(entry.key) || activeStreams > 0;
        setComposerValue(area, draft);
        area.removeAttribute('data-dsx-sending');
      } else {
        await delay(SEND_RETRY_MS);
      }
    }
    return !pendingResults.has(entry.key);
  }

  // Sends a plain message, the opening task of a helper, through the composer. Unlike a result it carries
  // its own text, so the hook treats it like anything the user types: it is the first message of its chat
  // and gets the full prompt. Resolves true once the page took it.
  async function sendText(text) {
    const deadline = Date.now() + SEND_TIMEOUT_MS;
    let attempt = 0;
    while (Date.now() < deadline) {
      const area = findComposer();
      if (!area || activeStreams > 0) {
        await delay(SEND_RETRY_MS);
        continue;
      }
      area.setAttribute('data-dsx-sending', '');
      setComposerValue(area, text);
      await delay(120);
      if (attempt < ENTER_ATTEMPTS) pressEnter(area);
      else clickSendButton(area);
      attempt += 1;
      for (let waited = 0; waited < ACCEPT_WAIT_MS && area.value === text && activeStreams === 0; waited += COMPOSER_POLL_MS) {
        await delay(COMPOSER_POLL_MS);
      }
      const accepted = area.value !== text || activeStreams > 0;
      area.removeAttribute('data-dsx-sending');
      if (accepted) return true;
    }
    return false;
  }

  async function pumpResults() {
    if (pumping) return;
    pumping = true;
    try {
      for (;;) {
        const index = resultQueue.findIndex(
          (entry) => !entry.sessionId || location.pathname.includes(entry.sessionId),
        );
        if (index === -1 || activeStreams > 0) break;
        const [entry] = resultQueue.splice(index, 1);
        if (config.agent) lastSent = { key: entry.key, ids: entry.ids, sessionId: entry.sessionId, body: pendingResults.get(entry.key) };
        const sent = await sendThroughComposer(entry);
        if (!sent) {
          pendingResults.delete(entry.key);
          for (const id of entry.ids) post({ type: 'result-failed', id });
        }
        await delay(SEND_RETRY_MS);
      }
    } finally {
      pumping = false;
    }
  }

  // Results for another chat wait until the user comes back to it.
  let lastPath = location.pathname;
  setInterval(() => {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      pumpResults();
    }
  }, 1000);

  // ---- Messages from the content script ------------------------------------------------------

  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data || event.data.source !== 'dsx-content') return;
    const message = event.data;
    if (message.type === 'config') {
      config.env = message.env;
      config.thinking = typeof message.thinking === 'boolean' ? message.thinking : null;
      config.agent = message.agent === true;
    } else if (message.type === 'send-prompt') {
      // The task is wrapped here because the protocol library only loads in the page's world.
      lastSent = { text: message.task };
      sendText(Protocol.buildHelperTask(message.task)).then((sent) => {
        if (!sent) post({ type: 'prompt-failed' });
      });
    } else if (message.type === 'resend-last') {
      // A result DeepSeek refused is sent again. The opening task is not: its chat has to start over.
      if (lastSent && lastSent.key && lastSent.body) {
        pendingResults.set(lastSent.key, lastSent.body);
        resultQueue.push({ key: lastSent.key, ids: lastSent.ids, sessionId: lastSent.sessionId });
        pumpResults();
      }
    } else if (message.type === 'send-result') {
      const body = Protocol.buildResultMessage({ id: message.id, ...message.result });
      pendingResults.set(message.id, Protocol.injectPrompt(body, config.env, { full: false, agents: !config.agent }));
      resultQueue.push({ key: message.id, ids: [message.id], sessionId: message.sessionId });
      pumpResults();
    } else if (message.type === 'send-results') {
      // Calls answered together share one message, so the model sees them in one turn.
      const results = message.results || [];
      if (!results.length) return;
      const body = results.length === 1
        ? Protocol.buildResultMessage({ id: results[0].id, ...results[0] })
        : Protocol.buildResultBatch(results);
      const key = results.map((result) => result.id).join('+');
      pendingResults.set(key, Protocol.injectPrompt(body, config.env, { full: false, agents: !config.agent }));
      resultQueue.push({ key, ids: results.map((result) => result.id), sessionId: message.sessionId });
      pumpResults();
    }
  });
})();
