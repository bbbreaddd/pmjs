'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readStoredJson } = require('../runner/native-mv.cjs');

test('an empty save directory does not invoke the decoder on a missing file', () => {
  const storage = { readText() { return null; } };
  const codec = { decompressFromBase64() { throw new Error('missing file passed to decoder'); } };
  assert.deepEqual(readStoredJson(storage, codec, 'config.rpgsave', {}), {});
  assert.deepEqual(readStoredJson(storage, codec, 'global.rpgsave', []), []);
});
