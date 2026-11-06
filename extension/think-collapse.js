// Keeps DeepSeek's "Thought for N seconds" blocks collapsed. The site opens them and has no setting
// to change that, so this clicks the block's own header when it finds one open.
//
// A block is collapsed once as it appears. If you open one yourself it is left alone from then on,
// and after a few tries the script gives up on a block, so it can never fight the page forever.
(function (root) {
  'use strict';

  // The collapsible container is the only element that sets this CSS variable. Its class names are
  // hashes that change with every DeepSeek build, so neither they nor the visible text are used.
  const CONTAINER = '[style*="--collapsible-area-title-height"]';
  // Only blocks that hold thinking text are touched, which leaves other collapsible blocks alone.
  const THINK_CONTENT = '.ds-think-content';
  const FALLBACK_SCAN_MS = 500;
  const COOLDOWN_MS = 600;
  const MAX_AUTO_CLICKS = 3;
  const MIN_BODY_PX = 4;

  function createThinkCollapser({ enabled = () => true } = {}) {
    const states = new WeakMap();
    let frame = null;

    function stateOf(container) {
      let state = states.get(container);
      if (!state) {
        state = { cooldownUntil: 0, clicks: 0, userToggled: false };
        states.set(container, state);
      }
      return state;
    }

    // Open means the thinking text is really on screen. A block can be closed by removing the text,
    // hiding it, or shrinking it to nothing, and each of those counts as closed.
    function isOpen(container, header, content) {
      const visible = typeof content.checkVisibility === 'function'
        ? content.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
        : true;
      const headerHeight = header.getBoundingClientRect().height;
      return visible
        && content.getBoundingClientRect().height >= MIN_BODY_PX
        && container.getBoundingClientRect().height >= headerHeight + MIN_BODY_PX;
    }

    function scan() {
      frame = null;
      if (!enabled() || document.hidden) return;
      const now = performance.now();
      for (const container of document.querySelectorAll(CONTAINER)) {
        const content = container.querySelector(THINK_CONTENT);
        const header = container.firstElementChild;
        if (!content || !header) continue;
        const state = stateOf(container);
        if (state.userToggled || state.clicks >= MAX_AUTO_CLICKS || now < state.cooldownUntil) continue;
        // A block that is not drawn, such as one in a hidden tab, says nothing about its state.
        if (header.getBoundingClientRect().height < 1 || !isOpen(container, header, content)) continue;

        state.clicks += 1;
        state.cooldownUntil = now + COOLDOWN_MS;
        header.click();
      }
    }

    // Runs before the next paint, so a block is collapsed before it is ever drawn open.
    function schedule() {
      if (!frame) frame = requestAnimationFrame(scan);
    }

    // A real click on a block's header is the user's own choice, and it is left alone from then on.
    function onUserClick(event) {
      if (!event.isTrusted || !(event.target instanceof Element)) return;
      const container = event.target.closest(CONTAINER);
      if (container && container.firstElementChild && container.firstElementChild.contains(event.target)) {
        stateOf(container).userToggled = true;
      }
    }

    function start() {
      document.addEventListener('click', onUserClick, true);
      new MutationObserver(schedule).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });
      // The observer misses some changes, such as a state kept in a property, so this backs it up.
      setInterval(schedule, FALLBACK_SCAN_MS);
      schedule();
    }

    return { start, scan: schedule };
  }

  root.DsxThinkCollapse = { createThinkCollapser };
})(globalThis);
