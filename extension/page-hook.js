// Runs in the page's own JavaScript world so it can wrap the XMLHttpRequest calls DeepSeek makes.
// It only rewrites traffic and reports what it sees: it can never start a command by itself.
(function () {
  'use strict';

  const Protocol = window.DsxProtocol;
  const Filter = window.DsxStreamFilter;
  const ContextUsage = window.DsxContextUsage;
  const ChipHider = window.DsxChipHider;

  const STREAM_PATHS = [
    '/api/v0/chat/completion',
    '/api/v0/chat/regenerate',
    '/api/v0/chat/continue',
    '/api/v0/chat/edit_message',
    '/api/v0/chat/resume_stream',
  ];
  const HISTORY_PATH = '/api/v0/chat/history_messages';
  const UPLOAD_PATH = '/api/v0/file/upload_file';
  const FILES_PATH = '/api/v0/file/fetch_files';
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

  // `agent` is true in the tab of a helper, whose chat gets no helper tool. `plan` is true while plan mode is on.
  const config = { env: null, thinking: null, agent: false, plan: false };
  // The chats that were told plan mode is on, by session id, so one is told once when it ends.
  const planSent = new Set();
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

  // ---- Deleting chats ------------------------------------------------------------------------
  // The sidebar of the extension can delete chats. DeepSeek's own call is repeated, with the headers the page
  // sends on every API call (the sign-in among them), so it is the same request as the one its own menu makes.
  const DELETE_PATH = '/api/v0/chat_session/delete';
  const DELETE_TIMEOUT_MS = 20000;
  // What the page sends once for a single call and must not be reused: the proof of work of a reply, and the
  // framing of the body.
  const NOT_REUSED = /^(content-|x-ds-pow|accept-encoding$)/i;
  const apiCalls = new WeakSet();
  const apiHeaders = {};

  function rememberHeader(name, value) {
    if (!NOT_REUSED.test(name)) apiHeaders[String(name).toLowerCase()] = String(value);
  }

  // The sign-in, if the page has not made a call yet: its token is kept in the page's storage.
  function storedToken() {
    try {
      const stored = JSON.parse(localStorage.getItem('userToken') || 'null');
      return stored && typeof stored.value === 'string' ? stored.value : '';
    } catch {
      return '';
    }
  }

  function deleteChats(id, ids) {
    const headers = { ...apiHeaders };
    if (!headers.authorization) {
      const token = storedToken();
      if (token) headers.authorization = `Bearer ${token}`;
    }
    const finish = (ok, error) => post({ type: 'chats-deleted', id, ok, error: error || '' });
    if (!headers.authorization) {
      finish(false, 'not signed in');
      return;
    }
    const xhr = new XMLHttpRequest();
    nativeOpen.call(xhr, 'POST', DELETE_PATH, true);
    for (const [name, value] of Object.entries(headers)) nativeSetHeader.call(xhr, name, value);
    nativeSetHeader.call(xhr, 'content-type', 'application/json');
    xhr.timeout = DELETE_TIMEOUT_MS;
    xhr.onload = () => {
      try {
        const payload = JSON.parse(nativeResponseText.call(xhr));
        const code = payload && payload.data && payload.data.biz_code !== undefined ? payload.data.biz_code : payload && payload.code;
        if (xhr.status === 200 && payload && payload.code === 0 && code === 0) finish(true);
        else finish(false, `DeepSeek answered ${xhr.status}, code ${code === undefined ? '?' : code}`);
      } catch {
        finish(false, `DeepSeek answered ${xhr.status}`);
      }
    };
    xhr.onerror = () => finish(false, 'no connection');
    xhr.ontimeout = () => finish(false, 'timed out');
    nativeSend.call(xhr, JSON.stringify({ chat_session_ids: ids }));
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

  // What a message of this chat has to say about plan mode. The plan block goes out with every message while the
  // mode is on, and a chat that had it hears once that it is over.
  function planFlags(sessionId) {
    const key = sessionId || '';
    if (config.plan) {
      planSent.add(key);
      return { plan: true, planRetire: false };
    }
    if (planSent.delete(key)) return { plan: false, planRetire: true };
    return { plan: false, planRetire: false };
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
    // A message that carries files keeps the page's own choice: with some models DeepSeek does not allow search
    // and files together, and the page turns search off then.
    const hasFiles = Array.isArray(body.ref_file_ids) && body.ref_file_ids.length > 0;
    if ('search_enabled' in body && !hasFiles) body.search_enabled = true;
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
      body.prompt = Protocol.injectPrompt(body.prompt, config.env, { full, extra, retire, agents: !config.agent, mcp, mcpRetire, ...planFlags(request.sessionId) });
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
    apiCalls.delete(this);
    if (parsed && parsed.origin === location.origin && parsed.pathname.startsWith('/api/v0/')) apiCalls.add(this);
    if (parsed && parsed.origin === location.origin) {
      if (parsed.pathname === HISTORY_PATH) {
        target = withoutHistoryCache(parsed);
        requests.set(this, { kind: 'history', sessionId: parsed.searchParams.get('chat_session_id') });
      } else if (STREAM_PATHS.includes(parsed.pathname)) {
        requests.set(this, { kind: 'stream', path: parsed.pathname, headers: {}, seen: 0, output: '' });
      } else if (parsed.pathname === UPLOAD_PATH || parsed.pathname === FILES_PATH) {
        // Only watched, to know when the files the model asked to read are uploaded and parsed.
        requests.set(this, { kind: 'file', path: parsed.pathname });
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
    if (apiCalls.has(this)) rememberHeader(name, value);
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
    if (request && request.kind === 'file') watchFileRequest(this, request.path);
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

  // ---- Files the model asked to read -----------------------------------------------------------
  // `read` on an image, a PDF or an Office document does not print anything: the host sends the bytes, and the
  // page's own upload takes them as if the user had picked the file with the paperclip. DeepSeek uploads the file
  // and parses it, and the message that carries the result goes out with it, so the model gets what DeepSeek
  // extracted. This waits until the upload and the parsing are done, which it learns by watching the two
  // requests the page makes for them. Nothing here reads or changes what the page sends.

  const MAX_ATTACHED_FILES = 10;
  const FILE_WAIT_MS = 120000;
  const FILE_FIRST_REQUEST_MS = 6000;
  const FILE_FAILED = {
    FAILED: 'DeepSeek could not read it',
    CONTENT_FILTER: 'DeepSeek refused it',
    CONTENT_TOO_LONG: 'it is too long for the chat',
    CONTENT_EMPTY: 'DeepSeek found nothing to read in it',
    CANCELLED: 'the upload was cancelled',
  };
  const FILE_PENDING = new Set(['PENDING', 'PARSING']);

  const fileWatch = {
    active: false,
    started: 0,
    inflight: 0,
    failure: null,
    statuses: new Map(),
    begin() {
      Object.assign(this, { active: true, started: 0, inflight: 0, failure: null });
      this.statuses.clear();
    },
    end() {
      this.active = false;
    },
    requestStarted(path) {
      if (!this.active || path !== UPLOAD_PATH) return;
      this.started += 1;
      this.inflight += 1;
    },
    requestEnded(path, status, payload) {
      if (!this.active) return;
      const data = payload && payload.data;
      if (path === UPLOAD_PATH) {
        this.inflight = Math.max(0, this.inflight - 1);
        if (status >= 400 || status === 0) this.failure = status ? `the upload failed (${status})` : 'the upload failed';
        else if (data && data.biz_code) this.failure = data.biz_msg || 'DeepSeek refused the upload';
      }
      const files = path === UPLOAD_PATH ? [data && data.biz_data] : data && data.biz_data && data.biz_data.files;
      for (const file of Array.isArray(files) ? files : []) {
        if (file && file.id && typeof file.status === 'string') this.statuses.set(file.id, file.status);
      }
    },
    // `ready` once every upload started has ended and no file is still being parsed; `failure` says why not.
    state(expected) {
      let pending = 0;
      let failure = this.failure;
      for (const status of this.statuses.values()) {
        if (FILE_PENDING.has(status)) pending += 1;
        else if (!failure && FILE_FAILED[status]) failure = FILE_FAILED[status];
      }
      return { failure, ready: this.started >= expected && this.inflight === 0 && pending === 0, started: this.started };
    },
  };

  function watchFileRequest(xhr, path) {
    fileWatch.requestStarted(path);
    xhr.addEventListener('loadend', () => {
      let payload = null;
      try {
        payload = xhr.responseType === 'json' ? nativeResponse.call(xhr) : JSON.parse(nativeResponseText.call(xhr));
      } catch {
        // Not JSON: only the status counts.
      }
      fileWatch.requestEnded(path, xhr.status, payload);
    });
  }

  // The page may use fetch for these two requests instead of XHR, so it is watched the same way. The answer
  // is read from a copy and the page gets its own, untouched.
  const nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    window.fetch = function (input, init) {
      const promise = nativeFetch.apply(this, arguments);
      try {
        const url = parseUrl(typeof input === 'string' ? input : input && input.url);
        if (url && url.origin === location.origin && (url.pathname === UPLOAD_PATH || url.pathname === FILES_PATH)) {
          fileWatch.requestStarted(url.pathname);
          promise.then(
            (response) => response.clone().json().catch(() => null).then((payload) => fileWatch.requestEnded(url.pathname, response.status, payload)),
            () => fileWatch.requestEnded(url.pathname, 0, null),
          );
        }
      } catch {
        // Watching must never get in the page's way.
      }
      return promise;
    };
  }

  function filesOf(results) {
    return results.map((result) => result && result.attachment).filter(Boolean).slice(0, MAX_ATTACHED_FILES);
  }

  function base64ToBytes(text) {
    const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
    const bytes = new Uint8Array(Math.floor(text.length / 4) * 3 - padding);
    const SLICE = 1 << 20; // a multiple of 4, so every slice decodes on its own
    let offset = 0;
    for (let start = 0; start < text.length; start += SLICE) {
      const binary = atob(text.slice(start, start + SLICE));
      for (let index = 0; index < binary.length; index += 1) bytes[offset++] = binary.charCodeAt(index);
    }
    return bytes;
  }

  // The page's hidden file input, the one the paperclip opens.
  function findFileInput() {
    const inputs = [...document.querySelectorAll('input[type="file"]')];
    return inputs.find((input) => /\.pdf\b/i.test(input.accept || '')) || inputs[0] || null;
  }

  // Puts the files into the page's file input, as the file dialog would, and waits until DeepSeek has them.
  // Resolves { ok: true }, or { ok: false, reason } when they could not be attached.
  async function attachFiles(files) {
    const input = findFileInput();
    if (!input) return { ok: false, reason: 'this chat has no file upload' };
    let transfer;
    try {
      transfer = new DataTransfer();
      for (const file of files) transfer.items.add(new File([base64ToBytes(file.data)], file.name, { type: file.mime }));
    } catch (error) {
      return { ok: false, reason: `the file could not be prepared: ${error.message}` };
    }
    fileWatch.begin();
    try {
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      const startedAt = Date.now();
      while (Date.now() - startedAt < FILE_WAIT_MS) {
        const state = fileWatch.state(files.length);
        if (state.failure) return { ok: false, reason: state.failure };
        if (state.ready) return { ok: true };
        // No upload request was seen at all: the page took the files by a way that cannot be watched, so the
        // sending below simply tries until the page lets the message go.
        if (!state.started && Date.now() - startedAt > FILE_FIRST_REQUEST_MS) return { ok: true };
        await delay(200);
      }
      return { ok: false, reason: 'DeepSeek took too long to read it' };
    } finally {
      fileWatch.end();
    }
  }

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

  // How long after a message is sent the page is given to clear the files from its composer.
  const CHIP_RELEASE_MS = 2500;
  const chipHider = ChipHider.createChipHider({ getArea: findComposer });

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
        // Files the model asked to read go into the composer first, so the message that carries the result takes
        // them along. When they cannot be attached the model is told, and the result goes out without them.
        // The page draws them in the composer as if the user had attached them, which is kept out of sight.
        let withFiles = false;
        if (entry.files && entry.files.length) {
          withFiles = true;
          chipHider.start(entry.files.map((file) => file.name));
          post({ type: 'attachment-state', ids: entry.ids, state: 'attaching' });
          const attached = await attachFiles(entry.files);
          entry.files = null;
          if (!attached.ok && pendingResults.has(entry.key)) {
            pendingResults.set(entry.key, `${pendingResults.get(entry.key)}\n\n${Protocol.buildFileFailure(attached.reason)}`);
          }
        }
        if (config.agent) lastSent = { key: entry.key, ids: entry.ids, sessionId: entry.sessionId, body: pendingResults.get(entry.key) };
        const sent = await sendThroughComposer(entry);
        if (withFiles) {
          chipHider.releaseSoon(CHIP_RELEASE_MS);
          post({ type: 'attachment-state', ids: entry.ids, state: 'done' });
        }
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
      config.plan = message.plan === true;
    } else if (message.type === 'send-prompt') {
      // The task is wrapped here because the protocol library only loads in the page's world.
      lastSent = { text: message.task };
      sendText(Protocol.buildHelperTask(message.task)).then((sent) => {
        if (!sent) post({ type: 'prompt-failed' });
      });
    } else if (message.type === 'delete-chats') {
      const ids = Array.isArray(message.ids) ? message.ids.filter((value) => typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value)) : [];
      if (ids.length) deleteChats(message.id, ids);
      else post({ type: 'chats-deleted', id: message.id, ok: false, error: 'no chat' });
    } else if (message.type === 'resend-last') {
      // A result DeepSeek refused is sent again. The opening task is not: its chat has to start over.
      if (lastSent && lastSent.key && lastSent.body) {
        pendingResults.set(lastSent.key, lastSent.body);
        resultQueue.push({ key: lastSent.key, ids: lastSent.ids, sessionId: lastSent.sessionId });
        pumpResults();
      }
    } else if (message.type === 'send-result') {
      const body = Protocol.buildResultMessage({ id: message.id, ...message.result });
      pendingResults.set(message.id, Protocol.injectPrompt(body, config.env, { full: false, agents: !config.agent, ...planFlags(message.sessionId) }));
      resultQueue.push({ key: message.id, ids: [message.id], sessionId: message.sessionId, files: filesOf([message.result]) });
      pumpResults();
    } else if (message.type === 'send-results') {
      // Calls answered together share one message, so the model sees them in one turn.
      const results = message.results || [];
      if (!results.length) return;
      const body = results.length === 1
        ? Protocol.buildResultMessage({ id: results[0].id, ...results[0] })
        : Protocol.buildResultBatch(results);
      const key = results.map((result) => result.id).join('+');
      pendingResults.set(key, Protocol.injectPrompt(body, config.env, { full: false, agents: !config.agent, ...planFlags(message.sessionId) }));
      resultQueue.push({ key, ids: results.map((result) => result.id), sessionId: message.sessionId, files: filesOf(results) });
      pumpResults();
    }
  });
})();
