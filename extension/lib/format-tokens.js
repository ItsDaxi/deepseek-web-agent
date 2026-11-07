// Writes a token count short: 999 -> "999", 1606 -> "1.6K", 125000 -> "125K", 1200000 -> "1.2M".
// It lives apart from context-usage.js because Chrome injects a file once per extension, and the page
// hook (main world) already takes that one: the content script needs its own copy of this.
(function (root) {
  'use strict';

  function trimZero(text) {
    return text.replace(/\.0$/, '');
  }

  function formatTokens(count) {
    const value = Math.max(0, Math.round(Number(count) || 0));
    if (value < 1000) return String(value);
    if (value < 100000) return `${trimZero((value / 1000).toFixed(1))}K`;
    if (value < 999500) return `${Math.round(value / 1000)}K`;
    return `${trimZero((value / 1000000).toFixed(1))}M`;
  }

  const api = { formatTokens };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DsxFormatTokens = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
