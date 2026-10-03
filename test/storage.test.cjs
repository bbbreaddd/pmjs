'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { loadPmjsRuntime } = require('./helpers/runtime-context.cjs');
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

test('storage generation covers mutations and stays unchanged for reads', () => {
  const storage = createStorage(temporaryDirectory('pmjs-storage-generation-'));
  const initial = storage.generation();
  storage.writeText('source', 'first');
  assert.equal(storage.generation(), initial + 1);
  storage.readText('source');
  storage.exists('source');
  storage.isDirectory('source');
  storage.readDirectory('missing');
  assert.equal(storage.generation(), initial + 1);
  storage.makeDirectory('folder');
  storage.rename('source', 'folder/destination');
  storage.remove('folder/destination');
  storage.remove('already-missing');
  assert.equal(storage.generation(), initial + 5);
  assert.throws(() => storage.rename('missing', 'target'), /ENOENT/);
  assert.equal(storage.generation(), initial + 6);
});

for (const disabled of [false, true]) {
  test('MV observes real storage mutations without replacing host methods, cache disabled=' + disabled, async () => {
    const storage = createStorage(temporaryDirectory('pmjs-storage-mv-'));
    storage.writeText('file1.rpgsave', 'old');
    let reads = 0;
    const rawRead = storage.readText;
    storage.readText = function(name) { reads++; return rawRead.call(this, name); };
    const mutations = [storage.writeText, storage.remove, storage.rename, storage.makeDirectory];
    const manager = { localFilePath() {}, loadFromLocalFile() {}, localFileExists() {},
      remove(id) { storage.remove(this.localFilePath(id).slice(6)); } };
    const remove = manager.remove;
    const ctx = loadPmjsRuntime({
      Buffer,
      NativeHost: { storage },
      PMJS_GAME_CONFIG: { disableOptimizations: disabled ? ['storage.read-burst-coalesce'] : [] },
      StorageManager: manager,
      LZString: { decompressFromBase64: value => value },
      queueMicrotask,
    });
    for (const file of ['pmjs-web/storage.js', 'pmjs-web/filesystem.js', 'pmjs-mv/storage.js']) {
      vm.runInContext(fs.readFileSync(path.join(__dirname, '../js', file), 'utf8'), ctx);
    }
    ctx.installNativeStorageManager();
    assert.deepEqual([storage.writeText, storage.remove, storage.rename, storage.makeDirectory], mutations);
    assert.equal(manager.remove, remove);
    assert.equal(manager.loadFromLocalFile(1), 'old');
    assert.equal(manager.loadFromLocalFile(1), 'old');
    assert.equal(reads, disabled ? 2 : 1);
    ctx.fsModule.writeFileSync('/save/file1.rpgsave', 'filesystem');
    assert.equal(manager.loadFromLocalFile(1), 'filesystem');
    storage.writeText('replacement', 'renamed');
    storage.rename('replacement', 'file1.rpgsave');
    assert.equal(manager.loadFromLocalFile(1), 'renamed');
    assert.equal(manager.localFileExists(1), true);
    manager.remove(1);
    assert.equal(manager.localFileExists(1), false);
    assert.equal(manager.loadFromLocalFile(1), null);
    storage.writeText('file1.rpgsave', 'returned');
    assert.equal(manager.loadFromLocalFile(1), 'returned');
    const before = reads;
    await new Promise(resolve => queueMicrotask(resolve));
    assert.equal(manager.loadFromLocalFile(1), 'returned');
    assert.equal(reads, before + 1);
  });
}
