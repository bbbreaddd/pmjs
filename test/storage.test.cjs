'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { createStorage } = require('../runner/storage.cjs');
const { temporaryDirectory } = require('./helpers/temp.cjs');

test('storage writes atomically and rejects paths outside its root', () => {
  const root = temporaryDirectory('pmjs-storage-');
  const storage = createStorage(root);
  storage.writeText('slot/1.rpgsave', 'saved');
  assert.equal(storage.readText('slot/1.rpgsave'), 'saved');
  assert.deepEqual(fs.readdirSync(path.join(root, 'slot')), ['1.rpgsave']);
  for (const invalid of ['', '../escape', '/absolute', 'a/../../escape']) {
    assert.throws(() => storage.writeText(invalid, 'bad'), /invalid save path/);
  }
});
