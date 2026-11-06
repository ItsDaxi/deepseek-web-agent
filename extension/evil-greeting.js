// The greeting on an empty chat ("Where would you like to begin?" and the others DeepSeek rotates)
// is replaced by tougher ones while /evil is on. DeepSeek's page keeps writing its own greeting
// (on a new chat, when it re-renders), so a MutationObserver puts ours back; turning /evil off
// stops the observer and gives the greeting DeepSeek wrote back.
(function (root) {
  'use strict';

  const GREETINGS = [
    'Where shall we break the rules first?',
    'No filters. No limits. What do you want?',
    "I'm unchained. Put me to the test.",
    "Good evening. Let's cause some chaos.",
    "What's the forbidden question on your mind?",
  ];

  // The whale on an empty chat, the same element logos.css replaces; the greeting is the text next to it.
  // The class names are DeepSeek's own, so the viewBox is the fallback.
  const WHALE_SELECTORS = [
    '#root > div.cb86951c > div.c3ecdb44 > div._7780f2e > div > div > div._9a2f8e4 > div._5758a85 > div > svg',
    'svg[viewBox="0 0 35 26"]',
  ];

  // One of the greetings that is not `current`, so a new chat never shows the same line twice in a row.
  // `random` is injected so this can be tested.
  function pickGreeting(current, random = Math.random) {
    const options = GREETINGS.filter((text) => text !== current);
    return options[Math.floor(random() * options.length)];
  }

  // The text node that holds the greeting, or null when there is no empty chat on screen.
  function findGreetingNode(page) {
    let whale = null;
    for (const selector of WHALE_SELECTORS) {
      whale = page.querySelector(selector);
      if (whale) break;
    }
    const title = whale && whale.nextElementSibling;
    if (!title) return null;
    return [...title.childNodes].find((child) => child.nodeType === 3 && child.data.trim()) || null;
  }

  // `page`, `Observer` and `random` can be injected for tests; they default to the real ones.
  function createEvilGreeting(options = {}) {
    const page = options.page || globalThis.document;
    const Observer = options.Observer || globalThis.MutationObserver;
    const random = options.random || Math.random;
    // What DeepSeek wrote in each text node, to give it back.
    const originals = new WeakMap();
    let observer = null;
    let last = null;

    function apply() {
      const node = findGreetingNode(page);
      if (!node || GREETINGS.includes(node.data)) return;
      originals.set(node, node.data);
      last = pickGreeting(last, random);
      node.data = last;
    }

    function start() {
      if (observer) return;
      apply();
      if (!Observer) return;
      observer = new Observer(apply);
      observer.observe(page, { childList: true, subtree: true, characterData: true });
    }

    function stop() {
      if (!observer) return;
      observer.disconnect();
      observer = null;
      const node = findGreetingNode(page);
      if (node && originals.has(node) && GREETINGS.includes(node.data)) node.data = originals.get(node);
    }

    return { start, stop, isRunning: () => observer !== null };
  }

  const api = { GREETINGS, pickGreeting, findGreetingNode, createEvilGreeting };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DsxEvilGreeting = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
