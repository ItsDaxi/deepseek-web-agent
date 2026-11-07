'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { formatTokens } = require('../../extension/lib/format-tokens.js');

test('token counts are shortened to a few characters', () => {
  assert.equal(formatTokens(0), '0');
  assert.equal(formatTokens(999), '999');
  assert.equal(formatTokens(1000), '1K');
  assert.equal(formatTokens(1234), '1.2K');
  assert.equal(formatTokens(1606), '1.6K');
  assert.equal(formatTokens(12345), '12.3K');
  assert.equal(formatTokens(99990), '100K');
  assert.equal(formatTokens(125000), '125K');
  assert.equal(formatTokens(890880), '891K');
  assert.equal(formatTokens(999600), '1M');
  assert.equal(formatTokens(1200000), '1.2M');
  assert.equal(formatTokens(undefined), '0');
});
