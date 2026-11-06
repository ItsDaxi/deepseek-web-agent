// Runs in the page's own JavaScript world so it can wrap the XMLHttpRequest calls DeepSeek makes.
// It only rewrites traffic and reports what it sees: it can never start a command by itself.
(function () {
  'use strict';

  const Protocol = window.DsxProtocol;
  const Filter = window.DsxStreamFilter;

  const STREAM_PATHS = [
    '/api/v0/chat/completion',
    '/api/v0/chat/regenerate',
    '/api/v0/chat/continue',
    '/api/v0/chat/edit_message',
    '/api/v0/chat/resume_stream',
  ];
  const HISTORY_PATH = '/api/v0/chat/history_messages';
  const TITLE_PATH = '/api/v0/chat_session/update_title';
  const RESULT_MARKER = new RegExp(`^${Protocol.RESULT_MARKER_PREFIX}(\\S+)$`);
  const LEAKED_TITLE = /\b(dsx|shell tool|tool syntax|system prompt)\b/i;
  const SEND_RETRY_MS = 250;
  const COMPOSER_POLL_MS = 15;
  const SEND_TIMEOUT_MS = 15000;
  const ENTER_ATTEMPTS = 3;
  const TITLE_MAX_CHARS = 40;

  const config = { env: null };
  const requests = new WeakMap();
  const pendingResults = new Map();
  // The instructions already sent in each chat, by session id.
  const extraSent = new Map();
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
    if (typeof body.prompt !== 'string') return rawBody;

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
      body.prompt = Protocol.injectPrompt(body.prompt, config.env, { full, extra, retire });
      if (extra) extraSent.set(request.sessionId, extra);
      if (retire) extraSent.delete(request.sessionId);
      post({ type: 'user-turn' });
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
    return nativeSend.call(this, body);
  };

  // ---- Stream responses ----------------------------------------------------------------------

  function beginStream(xhr, request) {
    activeStreams += 1;
    request.rewriter = Filter.createSseRewriter({
      sessionId: request.sessionId,
      // A resumed stream replays text the user may already have acted on, so it never auto-runs.
      live: request.path !== '/api/v0/chat/resume_stream' && request.path !== '/api/v0/chat/continue',
      rewriteTitle: (title) => fixLeakedTitle(request, title),
      onEvent: post,
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
      const { tools, results } = Filter.rewriteHistory(payload, request.sessionId);
      post({ type: 'history', tools, results });
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
          const { tools, results } = Filter.rewriteHistory(native, requests.get(this).sessionId);
          if (tools.length || results.length) post({ type: 'history', tools, results });
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
        for (let waited = 0; waited < SEND_RETRY_MS && area.value === marker; waited += COMPOSER_POLL_MS) {
          await delay(COMPOSER_POLL_MS);
        }
        // The page solves a proof of work before its request leaves, so an emptied composer is
        // what proves the send was accepted. Sending again here would post the result twice.
        accepted = area.value !== marker || !pendingResults.has(entry.key);
        setComposerValue(area, draft);
        area.removeAttribute('data-dsx-sending');
      } else {
        await delay(SEND_RETRY_MS);
      }
    }
    return !pendingResults.has(entry.key);
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
    } else if (message.type === 'send-result') {
      const body = Protocol.buildResultMessage({ id: message.id, ...message.result });
      pendingResults.set(message.id, Protocol.injectPrompt(body, config.env, { full: false }));
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
      pendingResults.set(key, Protocol.injectPrompt(body, config.env, { full: false }));
      resultQueue.push({ key, ids: results.map((result) => result.id), sessionId: message.sessionId });
      pumpResults();
    }
  });
})();
