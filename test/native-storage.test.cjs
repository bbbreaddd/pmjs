'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { temporaryDirectory } = require('./helpers/temp.cjs');
const { createStorage } = require('../runner/storage.cjs');
const { installStorage } = require('../runner/native-storage.cjs');

test('plugin storage paths use isolated storage and preserve overridden filenames', t => {
  const root = temporaryDirectory('native-plugin-storage-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const storage = createStorage(root), runtime = { scope: {} };
  const native = { compression: {
    compressLZString: text => Buffer.from(text).toString('base64'),
    decompressLZString: text => Buffer.from(text, 'base64').toString()
  } };
  const manager = installStorage(runtime, native, storage);
  const original = manager.localFilePath;
  manager.localFilePath = function(id) {
    return id === 'Persistent' ? path.join(this.localFileDirectoryPath(), 'persistent.rpgsave') : original.call(this, id);
  };
  assert.equal(manager.load('Persistent'), null);
  manager.save('Persistent', '{"switches":[true]}');
  assert.equal(manager.exists('Persistent'), true);
  assert.equal(manager.load('Persistent'), '{"switches":[true]}');
  assert.equal(storage.readText('persistent.rpgsave'), Buffer.from('{"switches":[true]}').toString('base64'));
  assert.match(manager.localFilePath(-1), /config\.rpgsave$/);
  assert.match(manager.localFilePath(0), /global\.rpgsave$/);
  assert.match(manager.localFilePath(2), /file2\.rpgsave$/);
  manager.remove('Persistent'); assert.equal(manager.exists('Persistent'), false);
  manager.localFilePath = () => path.join(root, '..', 'escaped.rpgsave');
  assert.throws(() => manager.save(1, '{}'), /invalid save path/);
});
