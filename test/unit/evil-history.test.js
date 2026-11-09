'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { normalize, hashText, historyHashes } = require('../../installer/evil-history.js');

test('a byte order mark and Windows line endings do not change the hash', () => {
  const plain = Buffer.from('one\ntwo\n');
  assert.equal(hashText(Buffer.from('one\r\ntwo\r\n')), hashText(plain));
  assert.equal(hashText(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), plain])), hashText(plain));
  assert.deepEqual(normalize(Buffer.from('a\rb\r\n')), Buffer.from('a\rb\n'));
});

test('a changed text has another hash', () => {
  assert.notEqual(hashText(Buffer.from('one\ntwo\n')), hashText(Buffer.from('one\ntwo!\n')));
});

test('the history holds sha-256 hashes of the committed evil.txt', () => {
  const hashes = historyHashes(path.resolve(__dirname, '..', '..'));
  assert.ok(hashes.length >= 1);
  for (const hash of hashes) assert.match(hash, /^[0-9a-f]{64}$/);
});
