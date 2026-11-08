'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
// Written as a code point, so the editor cannot drop it.
const BOM = String.fromCharCode(0xFEFF);
const { readInstructions, directoriesFor, MAX_FILE_CHARS, MAX_TOTAL_CHARS } = require('../../host/instructions.js');

// A fake home with a project two folders down, and the user's own folder beside it.
function makeTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsx-instructions-'));
  const home = path.join(root, 'home');
  const project = path.join(home, 'work', 'app');
  const userDir = path.join(home, '.dsx');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(userDir, { recursive: true });
  const write = (dir, name, text) => fs.writeFileSync(path.join(dir, name), text);
  return { root, home, project, userDir, write, clean: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('the folders to look in run from the home folder down to the working folder', () => {
  const home = path.resolve('/h');
  assert.deepEqual(directoriesFor(path.join(home, 'a', 'b'), home), [home, path.join(home, 'a'), path.join(home, 'a', 'b')]);
  assert.deepEqual(directoriesFor(home, home), [home]);
  // Outside the home folder the search goes up to the top of the drive, and stops there.
  const outside = directoriesFor(path.resolve('/x/y'), path.resolve('/h'));
  assert.equal(outside[outside.length - 1], path.resolve('/x/y'));
  assert.equal(outside[0], path.parse(path.resolve('/x/y')).root);
});

test('nothing is found when there are no files', () => {
  const tree = makeTree();
  try {
    assert.deepEqual(readInstructions({ cwd: tree.project, home: tree.home, userDir: tree.userDir }), { files: [], text: '' });
  } finally {
    tree.clean();
  }
});

test('the user folder comes first, then the folders from the outermost to the nearest', () => {
  const tree = makeTree();
  try {
    tree.write(tree.userDir, 'AGENTS.md', 'global agents');
    tree.write(tree.userDir, 'CLAUDE.md', 'global claude');
    tree.write(tree.home, 'AGENTS.md', 'home agents');
    tree.write(path.join(tree.home, 'work'), 'CLAUDE.md', 'work claude');
    tree.write(tree.project, 'AGENTS.md', 'project agents');
    tree.write(tree.project, 'CLAUDE.md', 'project claude');

    const found = readInstructions({ cwd: tree.project, home: tree.home, userDir: tree.userDir });
    assert.deepEqual(found.files.map((file) => file.scope), ['global', 'global', 'directory', 'directory', 'directory', 'directory']);
    assert.deepEqual(found.files.map((file) => path.basename(file.path)), ['AGENTS.md', 'CLAUDE.md', 'AGENTS.md', 'CLAUDE.md', 'AGENTS.md', 'CLAUDE.md']);
    const order = ['global agents', 'global claude', 'home agents', 'work claude', 'project agents', 'project claude'].map((text) => found.text.indexOf(text));
    assert.ok(order.every((at, index) => at > 0 && (index === 0 || at > order[index - 1])), String(order));
    // Each text says where it comes from, and the nearest wins.
    assert.match(found.text, /If two of them disagree, the one listed last wins/);
    assert.ok(found.text.includes(`Instructions from ${path.join(tree.project, 'AGENTS.md')}`));
  } finally {
    tree.clean();
  }
});

test('empty files, folders named like a file, and a missing working folder are skipped', () => {
  const tree = makeTree();
  try {
    tree.write(tree.project, 'AGENTS.md', BOM + '  \r\n  ');
    fs.mkdirSync(path.join(tree.project, 'CLAUDE.md'));
    assert.equal(readInstructions({ cwd: tree.project, home: tree.home, userDir: tree.userDir }).text, '');
    tree.write(tree.userDir, 'AGENTS.md', 'still found');
    assert.match(readInstructions({ cwd: path.join(tree.project, 'gone'), home: tree.home, userDir: tree.userDir }).text, /still found/);
    // No working folder at all: only the user's own files.
    assert.match(readInstructions({ home: tree.home, userDir: tree.userDir }).text, /still found/);
  } finally {
    tree.clean();
  }
});

test('a byte order mark and Windows line endings are cleaned up', () => {
  const tree = makeTree();
  try {
    tree.write(tree.project, 'AGENTS.md', BOM + 'Be brief.\r\nAnswer in Italian.\r\n');
    const found = readInstructions({ cwd: tree.project, home: tree.home, userDir: tree.userDir });
    assert.ok(found.text.endsWith('Be brief.\nAnswer in Italian.'), found.text);
    assert.equal(found.text.includes('\r'), false);
    assert.equal(found.text.includes(BOM), false);
  } finally {
    tree.clean();
  }
});

test('the same file is read once, even when two paths lead to it', () => {
  const tree = makeTree();
  try {
    // The working folder is the home folder, and the user folder is inside it: no file repeats.
    tree.write(tree.home, 'AGENTS.md', 'only once');
    const found = readInstructions({ cwd: tree.home, home: tree.home, userDir: tree.home });
    assert.equal(found.files.length, 1);
    assert.equal(found.text.split('only once').length - 1, 1);
  } finally {
    tree.clean();
  }
});

test('a long file is cut, and the files furthest away are dropped first when they are too many', () => {
  const tree = makeTree();
  try {
    tree.write(tree.project, 'AGENTS.md', 'x'.repeat(MAX_FILE_CHARS + 500));
    const cut = readInstructions({ cwd: tree.project, home: tree.home, userDir: tree.userDir });
    assert.equal(cut.files[0].cut, true);
    assert.equal(cut.files[0].chars, MAX_FILE_CHARS + 500);
    assert.match(cut.text, /500 characters, is not shown/);

    // Four files of the largest size are more than the total allows: the furthest one goes.
    const each = Math.floor(MAX_TOTAL_CHARS / 3) + 100;
    tree.write(tree.userDir, 'AGENTS.md', 'g'.repeat(each));
    tree.write(tree.home, 'AGENTS.md', 'h'.repeat(each));
    tree.write(path.join(tree.home, 'work'), 'AGENTS.md', 'w'.repeat(each));
    tree.write(tree.project, 'AGENTS.md', 'p'.repeat(each));
    const many = readInstructions({ cwd: tree.project, home: tree.home, userDir: tree.userDir });
    assert.ok(many.text.length <= MAX_TOTAL_CHARS + 2000, String(many.text.length));
    assert.equal(many.files[many.files.length - 1].path, path.join(tree.project, 'AGENTS.md'));
    assert.ok(many.files.every((file) => file.path !== path.join(tree.userDir, 'AGENTS.md')) || many.files.length === 4);
  } finally {
    tree.clean();
  }
});
