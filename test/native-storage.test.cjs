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
  const scope = require('node:vm').createContext({ ConfigManager: {}, console: { error() {} } });
  const storage = createStorage(root), runtime = { scope, runScript: source => require('node:vm').runInContext(source, scope) };
  const native = { compression: {
    compressLZString: text => Buffer.from(text).toString('base64'),
    decompressLZString: text => Buffer.from(text, 'base64').toString()
  } };
  const manager = installStorage(runtime, native, storage);
  manager.save(-1, 'broken JSON');
  assert.doesNotThrow(() => scope.ConfigManager.load());
  assert.equal(scope.ConfigManager.bgmVolume, 100);
  assert.equal(scope.ConfigManager.alwaysDash, false);
  Object.defineProperty(scope.ConfigManager, 'commandRemember', { get: () => false });
  let volume = 0;
  Object.defineProperty(scope.ConfigManager, 'bgmVolume', { get: () => volume, set: value => { volume = value; } });
  assert.doesNotThrow(() => scope.ConfigManager.applyData({ commandRemember: true, bgmVolume: 37 }));
  assert.equal(scope.ConfigManager.commandRemember, false);
  assert.equal(volume, 37);
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
  manager.backup('Persistent');
  assert.equal(manager.backupExists('Persistent'), true);
  manager.save('Persistent', 'replacement');
  manager.restoreBackup('Persistent');
  assert.equal(manager.load('Persistent'), '{"switches":[true]}');
  assert.equal(manager.backupExists('Persistent'), false);
  manager.backup('Persistent'); manager.cleanBackup('Persistent');
  assert.equal(manager.backupExists('Persistent'), false);
  manager.remove('Persistent'); assert.equal(manager.exists('Persistent'), false);
  manager.localFilePath = () => path.join(root, '..', 'escaped.rpgsave');
  assert.throws(() => manager.save(1, '{}'), /invalid save path/);
});
