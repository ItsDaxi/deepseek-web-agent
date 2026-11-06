'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseVersion, compare, status, releaseUrl, REPO, API_URL } = require('../../extension/lib/update-check.js');

test('parses plain versions, with or without the v', () => {
  assert.deepEqual(parseVersion('v1.2.3'), [1, 2, 3]);
  assert.deepEqual(parseVersion('0.10.0'), [0, 10, 0]);
  assert.deepEqual(parseVersion(' v2.0.1 '), [2, 0, 1]);
});

test('rejects anything that is not a plain version', () => {
  for (const bad of ['', 'latest', 'v1.2', 'v1.2.3-beta', 'v1.2.3.4', '1.2.x', 'v1.2.3\n<script>', null, undefined, 12]) {
    assert.equal(parseVersion(bad), null, String(bad));
  }
});

test('compares numbers, not text', () => {
  assert.equal(compare([0, 10, 0], [0, 9, 0]), 1);
  assert.equal(compare([1, 0, 0], [1, 0, 0]), 0);
  assert.equal(compare([0, 1, 9], [0, 2, 0]), -1);
});

test('reports an update only for a newer release', () => {
  assert.deepEqual(status('0.1.0', 'v0.2.0'), { available: true, tag: 'v0.2.0', url: releaseUrl('v0.2.0') });
  assert.deepEqual(status('0.9.0', 'v0.10.0').available, true);
  assert.equal(status('0.2.0', 'v0.2.0').available, false);
  assert.equal(status('0.3.0', 'v0.2.0').available, false);
});

test('an unusable tag or version never produces a notice', () => {
  assert.equal(status('0.1.0', 'v0.2.0-beta').available, false);
  assert.equal(status('0.1.0', null).available, false);
  assert.equal(status('dev', 'v9.9.9').available, false);
});

test('the link is built from the checked tag and points at this repository', () => {
  const { url } = status('0.1.0', 'v0.2.0');
  assert.equal(url, `https://github.com/${REPO}/releases/tag/v0.2.0`);
  assert.ok(API_URL.startsWith('https://api.github.com/repos/'));
});
