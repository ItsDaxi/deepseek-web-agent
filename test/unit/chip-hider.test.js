'use strict';

// What the page draws for a file the model read is hidden while it is on its way, and shown again if it is
// still there afterwards. The page is a small tree of fake nodes.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createChipHider } = require('../../extension/lib/chip-hider.js');

class Fake {
  constructor(name, text = '') {
    this.localName = name;
    this.own = text;
    this.children = [];
    this.parentElement = null;
    this.attributes = new Set();
    this.connected = true;
  }
  add(...nodes) {
    for (const node of nodes) {
      node.parentElement = this;
      this.children.push(node);
    }
    return this;
  }
  remove() {
    this.parentElement.children = this.parentElement.children.filter((node) => node !== this);
    this.parentElement = null;
    this.connected = false;
  }
  get isConnected() {
    return this.connected;
  }
  get textContent() {
    return this.own + this.children.map((node) => node.textContent).join('');
  }
  querySelectorAll() {
    return this.children.flatMap((node) => [node, ...node.querySelectorAll()]);
  }
  contains(node) {
    return node === this || this.children.some((child) => child.contains(node));
  }
  setAttribute(name) {
    this.attributes.add(name);
  }
  removeAttribute(name) {
    this.attributes.delete(name);
  }
  hidden() {
    return this.attributes.has('data-dsx-hidden');
  }
}

// A composer as the page draws it: a box with a toolbar and a text area, and no files yet.
function composer() {
  const box = new Fake('div');
  const area = new Fake('textarea');
  const toolbar = new Fake('div').add(new Fake('button', 'Send'));
  box.add(new Fake('div').add(area), toolbar);
  return { box, area, toolbar };
}

function setup() {
  const page = composer();
  globalThis.MutationObserver = class { observe() {} disconnect() {} };
  const hider = createChipHider({ getArea: () => page.area, look: { composerBoxOf: () => page.box } });
  return { ...page, hider };
}

test('the thumbnail of an image and the container the page made for it are hidden, and the rest is not', () => {
  const { box, area, toolbar, hider } = setup();
  assert.equal(hider.start(['shot.png']), true);
  const image = new Fake('img');
  const strip = new Fake('div').add(new Fake('div').add(image, new Fake('button', 'x')));
  box.children[0].add(strip);
  hider.sweep();
  assert.ok(strip.hidden(), 'the strip goes with its thumbnail');
  assert.ok(!area.hidden() && !toolbar.hidden() && !box.hidden() && !box.children[0].hidden(), 'the text area and the toolbar stay');
  hider.release();
  assert.ok(!strip.hidden(), 'it is shown again when released');
});

test('a document card is found by the name of the file', () => {
  const { box, hider } = setup();
  hider.start(['paper.pdf']);
  const card = new Fake('div').add(new Fake('span', 'paper'), new Fake('span', '.pdf'));
  box.add(card);
  hider.sweep();
  assert.ok(card.hidden());
});

test('a thumbnail drawn as a background image is found too', () => {
  const { box, hider } = setup();
  hider.start(['shot.png']);
  const thumb = new Fake('div');
  thumb.style = { backgroundImage: 'url("blob:https://chat.deepseek.com/1234")' };
  const strip = new Fake('div').add(thumb);
  box.add(strip);
  hider.sweep();
  assert.ok(strip.hidden());
});

test('something new that has nothing to do with the file is left alone', () => {
  const { box, toolbar, hider } = setup();
  hider.start(['paper.pdf']);
  const spinner = new Fake('div', 'Thinking');
  toolbar.add(spinner);
  hider.sweep();
  assert.ok(!spinner.hidden() && !toolbar.hidden());
});

test('a container that also holds what was there before is not hidden whole', () => {
  const { box, area, hider } = setup();
  hider.start(['shot.png']);
  // The page puts the thumbnail next to the text area, inside the wrapper that already held it.
  const wrapper = box.children[0];
  const image = new Fake('img');
  wrapper.add(image);
  hider.sweep();
  assert.ok(image.hidden());
  assert.ok(!wrapper.hidden() && !area.hidden());
});

test('release puts back only what is still there, and a page that does not look right is left alone', () => {
  const { box, hider } = setup();
  hider.start(['shot.png']);
  const gone = new Fake('img');
  const stays = new Fake('img');
  box.add(gone, stays);
  hider.sweep();
  gone.remove();
  hider.release();
  assert.ok(!stays.hidden());

  const lost = createChipHider({ getArea: () => null });
  assert.equal(lost.start(['a.png']), false);
  const odd = createChipHider({ getArea: () => ({}), look: { composerBoxOf: () => null } });
  assert.equal(odd.start(['a.png']), false);
});
