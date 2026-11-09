#!/usr/bin/env node
// Lists the SHA-256 of every version of evil.txt the project has committed, one per line.
//
//   node installer/evil-history.js
//
// The setup ships this list. An update replaces the evil.txt a user already has only when it is
// identical to one of these, which means the user never edited it. A file that matches none of them
// is the user's own and is left alone.
//
// The text is normalized before it is hashed (no byte order mark, Windows line endings made plain),
// so a copy that git or an editor converted still matches. Setup.cs normalizes the same way.
'use strict';

const crypto = require('crypto');
const path = require('path');
const { execFileSync } = require('child_process');

function normalize(buffer) {
  let bytes = buffer;
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) bytes = bytes.subarray(3);
  const out = [];
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0x0d && bytes[i + 1] === 0x0a) continue;
    out.push(bytes[i]);
  }
  return Buffer.from(out);
}

function hashText(buffer) {
  return crypto.createHash('sha256').update(normalize(buffer)).digest('hex');
}

function git(root, args) {
  return execFileSync('git', args, { cwd: root, maxBuffer: 64 * 1024 * 1024 });
}

// The hash of evil.txt at every commit that touched it.
function historyHashes(root) {
  const commits = git(root, ['log', '--format=%H', '--', 'evil.txt']).toString('utf8').split(/\r?\n/).filter(Boolean);
  const hashes = new Set();
  for (const commit of commits) {
    try {
      hashes.add(hashText(git(root, ['show', `${commit}:evil.txt`])));
    } catch (error) {
      // A commit that deleted the file has nothing to hash.
    }
  }
  return [...hashes];
}

if (require.main === module) {
  process.stdout.write(historyHashes(path.resolve(__dirname, '..')).join('\n') + '\n');
}

module.exports = { normalize, hashText, historyHashes };
