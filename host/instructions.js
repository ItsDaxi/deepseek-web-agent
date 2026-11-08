// Finds the instruction files the user keeps for the model: AGENTS.md and CLAUDE.md, in the user's own
// folder (~/.dsx by default) and in the working folder and the folders above it.
//
// Only these two fixed names are read, in fixed places, and nothing here can be pointed elsewhere by the
// model or by the page. The caller decides what to do with the text.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const FILE_NAMES = ['AGENTS.md', 'CLAUDE.md'];
// A file longer than this is cut, and the whole of them together are kept under TOTAL_CHARS by dropping
// the ones furthest from the working folder first.
const MAX_FILE_CHARS = 100_000;
const MAX_TOTAL_CHARS = 300_000;
// How many folders above the working folder are looked at, when the home folder is not among them.
const MAX_LEVELS = 20;

const IS_WINDOWS = process.platform === 'win32';
const same = (a, b) => (IS_WINDOWS ? a.toLowerCase() === b.toLowerCase() : a === b);

// The folders to look in, from the outermost to the working folder itself. Inside the home folder the
// search stops at the home folder; anywhere else it goes up to the top of the drive.
function directoriesFor(cwd, home) {
  const chain = [];
  let dir = path.resolve(cwd);
  for (let level = 0; level < MAX_LEVELS; level += 1) {
    chain.unshift(dir);
    if (home && same(dir, path.resolve(home))) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return chain;
}

function readOne(file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  text = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').trim();
  if (!text) return null;
  const chars = text.length;
  const cut = chars > MAX_FILE_CHARS;
  if (cut) text = `${text.slice(0, MAX_FILE_CHARS)}\n[The rest of this file, ${chars - MAX_FILE_CHARS} characters, is not shown.]`;
  return { text, chars, cut };
}

function realPath(file) {
  try {
    return fs.realpathSync(file);
  } catch {
    return file;
  }
}

// Returns { files, text }. `files` lists what was read, from the furthest to the nearest; `text` is
// what goes to the model, and is empty when there are no files.
function readInstructions({ cwd, home = os.homedir(), userDir = path.join(home, '.dsx') } = {}) {
  const places = [];
  for (const name of FILE_NAMES) places.push({ file: path.join(userDir, name), scope: 'global' });
  if (cwd) {
    for (const dir of directoriesFor(cwd, home)) {
      for (const name of FILE_NAMES) places.push({ file: path.join(dir, name), scope: 'directory' });
    }
  }

  const seen = new Set();
  const found = [];
  for (const place of places) {
    const key = realPath(place.file);
    const id = IS_WINDOWS ? key.toLowerCase() : key;
    if (seen.has(id)) continue;
    seen.add(id);
    const read = readOne(place.file);
    if (read) found.push({ path: place.file, scope: place.scope, ...read });
  }

  // Over the total, the files furthest from the working folder are the ones dropped.
  let budget = MAX_TOTAL_CHARS;
  const kept = [];
  for (let index = found.length - 1; index >= 0; index -= 1) {
    const size = found[index].text.length;
    if (size > budget) continue;
    budget -= size;
    kept.unshift(found[index]);
  }

  if (!kept.length) return { files: [], text: '' };
  const parts = ['These instructions come from files the user keeps. If two of them disagree, the one listed last wins.'];
  for (const entry of kept) {
    const where = entry.scope === 'global' ? 'the user\'s own instructions, for every folder' : 'this folder or one above it';
    parts.push(`Instructions from ${entry.path} (${where}):\n${entry.text}`);
  }
  return {
    files: kept.map(({ path: file, scope, chars, cut }) => ({ path: file, scope, chars, cut })),
    text: parts.join('\n\n'),
  };
}

module.exports = { readInstructions, directoriesFor, FILE_NAMES, MAX_FILE_CHARS, MAX_TOTAL_CHARS };
