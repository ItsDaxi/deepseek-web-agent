// Manual probe for the real context window of the DeepSeek web chat. It is not part of the extension
// and not run by `npm test`: it sends a very large message from your own logged-in page.
//
// It sends ONE message of about `tokens` tokens (1,000,000 by default) and reports what DeepSeek did
// with it: whether the page and the server accepted it, how many tokens DeepSeek counted, and which
// of five hidden codes the model could read back. The codes sit near the start, at a quarter, in the
// middle, at three quarters and near the end of the message, so a cut at either end shows up.
//
// The filler is random digits. DeepSeek's tokenizer groups them: a first run of 1,000,003 characters
// was counted as 347,563 tokens, so there are about 2.88 characters per token and that is the default.
// The exact count comes back from DeepSeek as accumulated_token_usage, which also counts the
// extension's hidden prompt, a few thousand tokens when the extension is on.
//
// How to run it:
//   1. Open https://chat.deepseek.com/ on a NEW chat, and set Effort the way you want to test.
//   2. Open the browser console (F12), paste this whole file, and press Enter.
//   3. Run `await dsxContextProbe({ dryRun: true })` first: it builds the message and reports its
//      size without sending anything.
//   4. Run `await dsxContextProbe()`. A reply can take many minutes. When it ends, a file called
//      dsx-context-probe-<time>.json is downloaded and the same report is returned.
//
// If the page refuses the message ("Content is too long (9%)"), the report says so. The page checks the
// length only when you send, and a refused message never reaches the model.
//
// Options: tokens (default 1000000), charsPerToken (default 2.88), dryRun, timeoutMs, allowExistingChat.
(function (root) {
  'use strict';

  const COMPLETION_PATH = '/api/v0/chat/completion';
  const HISTORY_PATH = '/api/v0/chat/history_messages';
  const LINE_DIGITS = 100;
  const MIN_TOKENS = 5000;
  // Measured on DeepSeek: 1,000,003 characters of digits were counted as 347,563 tokens.
  const CHARS_PER_TOKEN = 2.88;
  const START_WAIT_MS = 120000;
  const CLICK_WAIT_MS = 20000;
  const HISTORY_ATTEMPTS = 6;
  const HISTORY_WAIT_MS = 3000;
  const SSE_HEAD_CHARS = 800;
  const SSE_TAIL_CHARS = 3000;
  const WORDS = ['TIGRE', 'MARBLE', 'COBALT', 'LANTERN', 'FALCON', 'ORCHID', 'GLACIER', 'SADDLE'];
  const LABELS = ['A', 'B', 'C', 'D', 'E'];
  const FRACTIONS = [0.001, 0.25, 0.5, 0.75, 0.999];
  const INTRO = 'Below is a very long block of random digits. Five sentences about vault codes are hidden in it. Read everything carefully, then answer the question at the very end.\n\n';
  const QUESTION = '\n\nQuestion: what are the vault codes for rooms A, B, C, D and E, in that order? Reply on one line, exactly like this: A=<code> B=<code> C=<code> D=<code> E=<code>. Say nothing else.';

  // A small seeded generator, so the same options always build the same text.
  function seeded(seed) {
    let state = seed >>> 0;
    return () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function buildMessage({ tokens = 1000000, charsPerToken = CHARS_PER_TOKEN } = {}) {
    if (!(tokens >= MIN_TOKENS)) throw new Error(`tokens must be at least ${MIN_TOKENS}.`);
    const random = seeded(20260101);
    const canaries = LABELS.map((label, index) => {
      const word = WORDS[Math.floor(random() * WORDS.length)];
      const code = `${word}-${String(Math.floor(random() * 9000) + 1000)}`;
      return { label, code, fraction: FRACTIONS[index], sentence: `Remember: the vault code for room ${label} is ${code}.` };
    });
    const overhead = INTRO.length + QUESTION.length + canaries.reduce((sum, canary) => sum + canary.sentence.length + 1, 0);
    const digits = Math.max(LINE_DIGITS, Math.round(tokens * charsPerToken) - overhead);
    // Each line is its digits and a newline, which counts as a character and about a token as well.
    const lines = Math.ceil(digits / (LINE_DIGITS + 1));
    const at = new Map(canaries.map((canary) => [Math.min(lines - 1, Math.floor(canary.fraction * lines)), canary]));

    const parts = [INTRO];
    for (let line = 0; line < lines; line += 1) {
      if (at.has(line)) parts.push(`${at.get(line).sentence}\n`);
      let row = '';
      for (let index = 0; index < LINE_DIGITS; index += 1) row += Math.floor(random() * 10);
      parts.push(`${row}\n`);
    }
    parts.push(QUESTION);
    return { text: parts.join(''), canaries, lines };
  }

  // ---- Everything below needs the DeepSeek page --------------------------------------------------

  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function waitFor(check, timeoutMs, stepMs = 200) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = check();
      if (value) return value;
      if (Date.now() >= deadline) return null;
      await delay(stepMs);
    }
  }

  function findComposer() {
    const areas = [...document.querySelectorAll('textarea')].filter((area) => area.getClientRects().length > 0);
    return areas[areas.length - 1] || null;
  }

  function setComposerValue(area, value) {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(area, value);
    area.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function pressEnter(area) {
    area.focus();
    for (const type of ['keydown', 'keypress', 'keyup']) {
      area.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    }
  }

  function clickSend(area) {
    const scope = area.closest('form') || area.parentElement?.parentElement?.parentElement;
    const buttons = scope ? [...scope.querySelectorAll('button, [role="button"]')] : [];
    const button = buttons[buttons.length - 1];
    if (button) button.click();
  }

  // What the request says about itself, without the message, which is huge.
  function describeRequest(body) {
    try {
      const parsed = JSON.parse(body);
      const { prompt, ...rest } = parsed;
      return { ...rest, promptChars: typeof prompt === 'string' ? prompt.length : null };
    } catch {
      return null;
    }
  }

  // Sees the completion request go by: its headers, its body, and how it ended.
  function watchCompletion() {
    const proto = XMLHttpRequest.prototype;
    const original = { open: proto.open, send: proto.send, setRequestHeader: proto.setRequestHeader };
    const watch = { started: null, finished: null };
    watch.done = new Promise((resolve) => { watch.resolve = resolve; });

    proto.open = function (method, url, ...rest) {
      this.dsxProbe = { url: String(url), headers: {} };
      return original.open.call(this, method, url, ...rest);
    };
    proto.setRequestHeader = function (name, value) {
      if (this.dsxProbe) this.dsxProbe.headers[name] = value;
      return original.setRequestHeader.call(this, name, value);
    };
    proto.send = function (body) {
      const info = this.dsxProbe;
      if (info && !watch.started && new URL(info.url, location.href).pathname === COMPLETION_PATH) {
        const startedAt = Date.now();
        watch.started = { at: startedAt, headers: info.headers, bodyChars: typeof body === 'string' ? body.length : null, request: describeRequest(body) };
        this.addEventListener('loadend', () => {
          let text = '';
          try {
            text = this.responseType === '' || this.responseType === 'text' ? this.responseText : '';
          } catch {
            text = '';
          }
          watch.finished = { status: this.status, statusText: this.statusText, durationMs: Date.now() - startedAt, text };
          watch.resolve();
        });
      }
      return original.send.call(this, body);
    };
    watch.stop = () => Object.assign(proto, original);
    return watch;
  }

  // Notices pop-ups and alerts the page shows, such as "message too long".
  function watchNotices() {
    const seen = [];
    const selector = '[role="alert"], [role="status"], [class*="toast" i]';
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node.nodeType !== 1) continue;
          const targets = node.matches(selector) ? [node] : [...node.querySelectorAll(selector)];
          for (const target of targets) {
            const text = (target.textContent || '').trim().slice(0, 300);
            if (text && !seen.includes(text) && seen.length < 30) seen.push(text);
          }
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return { seen, stop: () => observer.disconnect() };
  }

  // The page refuses a message that is too long with a notice such as "Content is too long (9%)".
  const TOO_LONG = /too long|shorten|exceed|too large|超出|过长/i;

  // The text of such a notice if the page shows one now, else null. Nothing is sent to find it.
  function findLimitNotice() {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.nodeValue.trim();
      if (text.length > 0 && text.length < 200 && TOO_LONG.test(text)) return text;
    }
    return null;
  }

  // The number in brackets of a notice like "Content is too long (9%)", or null.
  function percentOf(notice) {
    const match = /\((\d+(?:\.\d+)?)\s*%\)/.exec(String(notice || ''));
    return match ? Number(match[1]) : null;
  }

  function summarizeStream(text) {
    const counts = [...text.matchAll(/"accumulated_token_usage"\s*:\s*(\d+)|"p"\s*:\s*"[^"]*accumulated_token_usage"\s*,\s*"v"\s*:\s*(\d+)/g)]
      .map((match) => Number(match[1] || match[2]));
    const events = {};
    for (const match of text.matchAll(/^event: (\S+)/gm)) events[match[1]] = (events[match[1]] || 0) + 1;
    // A status arrives as {"p":"quasi_status","v":"FINISHED"} or {"p":"response/status","o":"SET","v":"FINISHED"}.
    const statuses = [...new Set([...text.matchAll(/"p"\s*:\s*"[^"]*status"[^}]*?"v"\s*:\s*"([A-Z_]+)"|"status"\s*:\s*"([A-Z_]+)"/g)].map((match) => match[1] || match[2]))];
    // DeepSeek reports refusals and limits as toast or hint events.
    const messages = [...text.matchAll(/^event: (?:toast|hint|error)\s*\n(?:data: (.*))?/gm)].map((match) => (match[1] || '').slice(0, 400));
    return {
      chars: text.length,
      usage: counts.length ? Math.max(...counts) : null,
      events,
      statuses,
      messages,
      head: text.slice(0, SSE_HEAD_CHARS),
      tail: text.slice(-SSE_TAIL_CHARS),
    };
  }

  // The finished chat as the server keeps it, read with the headers the page itself used.
  async function readChat(sessionId, headers) {
    const clean = Object.fromEntries(Object.entries(headers).filter(([name]) => !name.toLowerCase().startsWith('x-ds-pow')));
    let last = null;
    for (let attempt = 0; attempt < HISTORY_ATTEMPTS; attempt += 1) {
      try {
        const response = await fetch(`${HISTORY_PATH}?chat_session_id=${encodeURIComponent(sessionId)}`, { headers: clean, credentials: 'include' });
        const payload = await response.json();
        const messages = payload?.data?.biz_data?.chat_messages || [];
        const reply = [...messages].reverse().find((message) => message.role === 'ASSISTANT');
        last = { httpStatus: response.status, messages, reply };
        if (reply && (reply.status === 'FINISHED' || reply.status === 'INCOMPLETE')) break;
      } catch (error) {
        last = { error: String(error && error.message ? error.message : error) };
      }
      await delay(HISTORY_WAIT_MS);
    }
    if (!last || !last.reply) return last;
    const fragments = last.reply.fragments || [];
    const text = (type) => fragments.filter((fragment) => fragment.type === type).map((fragment) => fragment.content || '').join('');
    return {
      httpStatus: last.httpStatus,
      status: last.reply.status,
      usage: last.reply.accumulated_token_usage ?? null,
      reply: text('RESPONSE'),
      thinkingChars: text('THINK').length,
      messages: last.messages.map((message) => ({ id: message.message_id, role: message.role, status: message.status, usage: message.accumulated_token_usage ?? null })),
    };
  }

  function download(report, kind = 'context-probe') {
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
    link.download = `dsx-${kind}-${stamp}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    return link.download;
  }

  function verdict(report) {
    if (report.outcome === 'refused-by-page') return `The page refused the message before sending it: "${report.refusal}". Nothing reached the server.`;
    if (report.outcome === 'not-sent') return 'The page never sent the message. See notices and composerCharsAfter.';
    if (report.outcome === 'timeout') return 'The request started but did not finish in time.';
    if (report.http && report.http.status !== 200) return `The server answered ${report.http.status}: the message was refused.`;
    const recalled = report.recall ? Object.values(report.recall).filter(Boolean).length : 0;
    let counted = report.counted ? `DeepSeek counted ${report.counted} tokens. ` : '';
    // The characters per token are an estimate. If DeepSeek counted much less, the test did not reach the size asked for.
    if (report.counted && report.counted < report.requestedTokens * 0.9) {
      counted += `That is less than the ${report.requestedTokens} asked for (${(report.counted / report.messageChars).toFixed(2)} tokens per character): run it again with charsPerToken: ${report.suggestedCharsPerToken}. `;
    }
    if (recalled === LABELS.length) return `${counted}All five codes were read back: the whole message fit.`;
    return `${counted}Only ${recalled} of 5 codes were read back: check which ones, since a missing first code means the start was cut.`;
  }

  async function dsxContextProbe(options = {}) {
    const settings = { tokens: 1000000, charsPerToken: CHARS_PER_TOKEN, dryRun: false, timeoutMs: 30 * 60 * 1000, allowExistingChat: false, ...options };
    const message = buildMessage(settings);
    const report = {
      startedAt: new Date().toISOString(),
      page: location.pathname,
      requestedTokens: settings.tokens,
      messageChars: message.text.length,
      lines: message.lines,
      canaries: message.canaries.map(({ label, code, fraction }) => ({ label, code, fraction })),
    };
    if (settings.dryRun) return { ...report, outcome: 'dry-run', note: 'Nothing was sent.' };
    if (location.pathname !== '/' && !settings.allowExistingChat) {
      throw new Error('Open a NEW chat first (https://chat.deepseek.com/), or pass allowExistingChat: true.');
    }
    const area = findComposer();
    if (!area) throw new Error('The composer was not found.');

    const watch = watchCompletion();
    const notices = watchNotices();
    try {
      setComposerValue(area, message.text);
      report.composerChars = area.value.length;
      await delay(500);
      pressEnter(area);
      // Either the request starts, or the page shows that the message is too long.
      const reached = () => watch.started || notices.seen.find((text) => TOO_LONG.test(text)) || findLimitNotice();
      let started = await waitFor(reached, START_WAIT_MS);
      if (!started) {
        clickSend(area);
        started = await waitFor(reached, CLICK_WAIT_MS);
      }
      if (typeof started === 'string') {
        report.outcome = 'refused-by-page';
        report.refusal = started;
        report.refusalPercent = percentOf(started);
        report.composerCharsAfter = area.value.length;
        setComposerValue(area, '');
      } else if (!started) {
        report.outcome = 'not-sent';
        report.composerCharsAfter = area.value.length;
      } else {
        report.request = started.request;
        report.bodyChars = started.bodyChars;
        const finished = await Promise.race([watch.done.then(() => true), delay(settings.timeoutMs).then(() => false)]);
        if (!finished) report.outcome = 'timeout';
        else {
          report.outcome = 'finished';
          report.http = { status: watch.finished.status, statusText: watch.finished.statusText, durationMs: watch.finished.durationMs };
          report.stream = summarizeStream(watch.finished.text);
          const sessionId = started.request && started.request.chat_session_id;
          if (sessionId) {
            const chat = await readChat(sessionId, started.headers);
            report.chat = chat;
            report.counted = (chat && chat.usage) || report.stream.usage;
            if (chat && typeof chat.reply === 'string') {
              report.recall = Object.fromEntries(message.canaries.map((canary) => [canary.label, chat.reply.includes(canary.code)]));
            }
          } else {
            report.counted = report.stream.usage;
          }
        }
      }
    } finally {
      watch.stop();
      notices.stop();
    }
    report.notices = notices.seen;
    if (report.counted) report.suggestedCharsPerToken = Math.round((report.messageChars / report.counted) * 100) / 100;
    report.verdict = verdict(report);
    report.file = download(report);
    root.dsxContextProbeResult = report;
    console.log(report.verdict, report);
    return report;
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { buildMessage, summarizeStream, percentOf };
  else root.dsxContextProbe = dsxContextProbe;
})(typeof globalThis !== 'undefined' ? globalThis : this);
