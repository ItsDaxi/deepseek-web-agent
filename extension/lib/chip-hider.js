// Keeps a file the model read out of the user's sight. The only way to give DeepSeek a file is its own file
// input, and the page shows what goes through it as a thumbnail or a file card above the composer, as if the
// user had attached it. The user did not: the tool card says what happened, so what the page adds to the
// composer for that file is hidden until the message has gone out.
//
// Nothing of the page is moved or removed. What the page draws for the file gets the data-dsx-hidden
// attribute, which page.css turns into display: none, and the attribute comes off again afterwards.
(function (root) {
  'use strict';

  const HIDDEN = 'data-dsx-hidden';
  // A thumbnail is an image, or a box with one as its background.
  const PICTURES = new Set(['img', 'picture', 'canvas', 'video']);

  // The rounded box that holds the text area, the toolbar and the files: the nearest ancestor of the text
  // area that is wide and rounded.
  function composerBoxOf(area) {
    for (let node = area.parentElement, depth = 0; node && depth < 10; node = node.parentElement, depth += 1) {
      if (node.getBoundingClientRect().width < 300) continue;
      if (parseFloat(getComputedStyle(node).borderTopLeftRadius) >= 12) return node;
    }
    return null;
  }

  // `getArea` returns the page's text area. `look` is how the page is read, which a test replaces.
  function createChipHider({ getArea, look = { composerBoxOf } }) {
    let box = null;
    let known = null;
    let names = [];
    let observer = null;
    let timer = 0;
    const marked = new Set();

    // Everything that was in the box before the file went in. What the page adds afterwards is new.
    function allNew(node) {
      for (const inner of node.querySelectorAll('*')) if (known.has(inner)) return false;
      return true;
    }

    // What the page drew for the files: a picture it did not have before, or something new that carries a
    // file's name.
    function found() {
      const list = [];
      for (const node of box.querySelectorAll('*')) {
        if (known.has(node)) continue;
        if (PICTURES.has(node.localName) || /url\(/.test((node.style && node.style.backgroundImage) || '') || names.some((name) => (node.textContent || '').includes(name))) list.push(node);
      }
      return list;
    }

    function sweep() {
      if (!box || !box.isConnected) return;
      const area = getArea();
      for (const node of found()) {
        let chip = node;
        // The container the page made for the files goes with them, as long as it holds nothing else.
        while (chip.parentElement && chip.parentElement !== box && !(area && chip.parentElement.contains(area)) && allNew(chip.parentElement)) {
          chip = chip.parentElement;
        }
        if (chip === box || (area && chip.contains(area)) || chip.localName.startsWith('dsx-')) continue;
        if (!marked.has(chip)) {
          chip.setAttribute(HIDDEN, '');
          marked.add(chip);
        }
      }
    }

    // Puts everything back the way the page left it.
    function release() {
      if (timer) clearTimeout(timer);
      timer = 0;
      if (observer) observer.disconnect();
      observer = null;
      for (const node of marked) if (node.isConnected) node.removeAttribute(HIDDEN);
      marked.clear();
      box = null;
      known = null;
    }

    // Starts watching just before the files go in. Quietly does nothing if the page does not look as expected.
    function start(fileNames) {
      release();
      try {
        const area = getArea();
        box = area ? look.composerBoxOf(area) : null;
        if (!box) return false;
        names = fileNames.filter((name) => typeof name === 'string' && name);
        known = new WeakSet(box.querySelectorAll('*'));
        observer = new MutationObserver(sweep);
        observer.observe(box, { childList: true, subtree: true, characterData: true });
        return true;
      } catch {
        release();
        return false;
      }
    }

    // The page clears the files when the message goes out. A little later whatever is still there is shown, so
    // a file that stayed in the composer is never left hidden.
    function releaseSoon(ms) {
      if (timer) clearTimeout(timer);
      timer = setTimeout(release, ms);
    }

    return { start, release, releaseSoon, sweep };
  }

  const api = { createChipHider, composerBoxOf };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DsxChipHider = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
