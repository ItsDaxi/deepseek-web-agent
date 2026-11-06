// Decides whether a newer release exists. It only compares version numbers: fetching them is the
// background script's job, and the link shown to the user is always built here from a tag that
// passed the strict pattern below, never taken from the network response as it is.
(function (root) {
  'use strict';

  const REPO = 'ItsDaxi/deepseek-web-agent';
  const API_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
  // Only plain release tags such as v1.2.3 count. A pre-release suffix is rejected on purpose.
  const VERSION = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/;

  function parseVersion(text) {
    const match = VERSION.exec(String(text === undefined || text === null ? '' : text).trim());
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
  }

  function compare(a, b) {
    for (let index = 0; index < 3; index += 1) {
      if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
    }
    return 0;
  }

  function releaseUrl(tag) {
    return `https://github.com/${REPO}/releases/tag/${tag}`;
  }

  // What the page should know: whether the latest tag is newer than the installed version.
  function status(installedVersion, latestTag) {
    const installed = parseVersion(installedVersion);
    const latest = parseVersion(latestTag);
    if (!installed || !latest || compare(latest, installed) <= 0) return { available: false };
    const tag = String(latestTag).trim();
    return { available: true, tag, url: releaseUrl(tag) };
  }

  const api = { REPO, API_URL, parseVersion, compare, releaseUrl, status };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DsxUpdateCheck = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
