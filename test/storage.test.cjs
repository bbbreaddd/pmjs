'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { loadPmjsRuntime } = require('./helpers/runtime-context.cjs');
const { createStorage, createGameFilesystem } = require('../runner/storage.cjs');
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

test('save readers capture files, read bounded bytes and release their descriptor', () => {
  const root = temporaryDirectory('pmjs-save-reader-'), storage = createStorage(root);
  const files = () => fs.readdirSync('/proc/self/fd').length;
  storage.writeText('input', 'abcdef');
  const before = files(), reader = storage.openRead('input', 2);
  assert.equal(files(), before + 1);
  storage.writeText('input', 'replacement'); storage.remove('input');
  assert.equal(reader.read(2).toString(), 'cd');
  assert.equal(reader.read(2).toString(), 'ef');
  assert.equal(reader.read(2).length, 0);
  reader.close(); reader.close(); assert.equal(files(), before);
  assert.equal(storage.openRead('input'), null);
  assert.throws(() => storage.openRead('../input'), /invalid save path/);
});

test('an old native filesystem fails before creating a writable overlay', () => {
  const root = path.join(temporaryDirectory('pmjs-storage-old-addon-'), 'overlay');
  assert.throws(() => createGameFilesystem({}, root), /requires native overlay updates/);
  assert.equal(fs.existsSync(root), false);
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

test('save rename and deletion sync directory entries and propagate sync failures', () => {
  const root = temporaryDirectory('pmjs-storage-durability-');
  const storage = createStorage(root);
  storage.makeDirectory('from'); storage.makeDirectory('to');
  storage.writeText('from/source', 'progress');
  const synced = [];
  const original = fs.fsyncSync;
  fs.fsyncSync = function(descriptor) {
    const filename = fs.readlinkSync('/proc/self/fd/' + descriptor);
    synced.push(path.relative(root, filename));
    return original(descriptor);
  };
  try {
    storage.rename('from/source', 'to/destination');
    assert.deepEqual(synced, ['to', 'from']);
    assert.equal(storage.readText('to/destination'), 'progress');
    synced.length = 0;
    storage.rename('to/destination', 'to/backup');
    assert.deepEqual(synced, ['to']);
    synced.length = 0;
    storage.remove('to/backup');
    assert.deepEqual(synced, ['to']);
    synced.length = 0;
    storage.remove('to/missing');
    assert.deepEqual(synced, []);
    storage.writeText('from/source', 'retained');
    fs.fsyncSync = () => { throw new Error('directory sync failed'); };
    assert.throws(() => storage.rename('from/source', 'to/destination'), /directory sync failed/);
    assert.equal(storage.readText('to/destination'), 'retained');
    assert.throws(() => storage.remove('to/destination'), /directory sync failed/);
    fs.fsyncSync = original;
    storage.writeText('to/destination', 'another save');
    fs.fsyncSync = () => { throw Object.assign(new Error('lost directory'), { code: 'ENOENT' }); };
    assert.throws(() => storage.remove('to/destination'), /lost directory/);
  } finally { fs.fsyncSync = original; }
});

test('creating nested save directories synchronizes their parent entries', () => {
  const root = temporaryDirectory('pmjs-storage-parent-sync-');
  const storage = createStorage(root);
  const original = fs.fsyncSync;
  const synced = [];
  fs.fsyncSync = function(descriptor) {
    if (fs.fstatSync(descriptor).isDirectory()) {
      synced.push(path.relative(root, fs.readlinkSync('/proc/self/fd/' + descriptor)));
    }
    return original(descriptor);
  };
  try {
    storage.writeText('profile/slots/one', 'new save');
    assert.deepEqual(synced, ['profile/slots', 'profile', '', 'profile/slots']);
    assert.equal(storage.readText('profile/slots/one'), 'new save');
  } finally { fs.fsyncSync = original; }
});

for (const disabled of [false, true]) {
  test('MV observes real storage mutations without replacing host methods, cache disabled=' + disabled, async () => {
    const storage = createStorage(temporaryDirectory('pmjs-storage-mv-'));
    storage.writeText('file1.rpgsave', 'old');
    let reads = 0;
    const rawRead = storage.readText;
    storage.readText = function(name) { reads++; return rawRead.call(this, name); };
    const mutations = [storage.writeText, storage.remove, storage.rename, storage.makeDirectory];
    const manager = { localFilePath(id) { return this.localFileDirectoryPath() + 'file' + id + '.rpgsave'; },
      loadFromLocalFile() {}, localFileExists() {},
      remove(id) { storage.remove(this.localFilePath(id).slice(6)); } };
    const remove = manager.remove;
    const ctx = loadPmjsRuntime({
      Buffer, __pmjsBuiltinRequire: require,
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

function localStorageContext() {
  const storage = createStorage(temporaryDirectory('pmjs-storage-paths-'));
  const lz = {
    compressToBase64: value => Buffer.from(value).toString('base64'),
    decompressFromBase64: value => value === null ? null : Buffer.from(value, 'base64').toString('utf8'),
  };
  let guestFs;
  const manager = {
    isLocalMode: () => false,
    localFileDirectoryPath: () => '/game/save/',
    localFilePath(id) {
      const name = id < 0 ? 'config' : id === 0 ? 'global' : 'file' + id;
      return this.localFileDirectoryPath() + name + '.rpgsave';
    },
    loadFromLocalFile() {},
    localFileExists() {},
    saveToLocalFile(id, json) {
      guestFs.writeFileSync(this.localFilePath(id), lz.compressToBase64(json));
    },
    removeLocalFile(id) {
      const filename = this.localFilePath(id);
      if (guestFs.existsSync(filename)) guestFs.unlinkSync(filename);
    },
    backup(id) {
      if (this.localFileExists(id)) {
        const json = this.loadFromLocalFile(id);
        guestFs.writeFileSync(this.localFilePath(id) + '.bak', lz.compressToBase64(json));
      }
    },
    restoreBackup(id) {
      const filename = this.localFilePath(id);
      if (guestFs.existsSync(filename + '.bak')) {
        guestFs.writeFileSync(filename, guestFs.readFileSync(filename + '.bak', 'utf8'));
        guestFs.unlinkSync(filename + '.bak');
      }
    },
    cleanBackup(id) {
      const filename = this.localFilePath(id) + '.bak';
      if (guestFs.existsSync(filename)) guestFs.unlinkSync(filename);
    },
  };
  const context = loadPmjsRuntime({
    Buffer, __pmjsBuiltinRequire: require, NativeHost: { storage }, StorageManager: manager, LZString: lz, queueMicrotask,
  });
  for (const file of ['pmjs-web/filesystem.js', 'pmjs-mv/storage.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../js', file), 'utf8'), context);
  }
  guestFs = context.fsModule;
  return { context, manager, storage, lz };
}

test('MV relocates local storage without replacing plugin filenames', () => {
  const { context, manager, storage, lz } = localStorageContext();
  const originalPath = manager.localFilePath;
  manager.localFilePath = function(id) {
    if (id === 'Profile') return this.localFileDirectoryPath() + 'profile.rpgsave';
    if (id === 7) return this.localFileDirectoryPath() + 'alternate/slot.rpgsave';
    return originalPath.call(this, id);
  };
  const paths = [[-1, 'config.rpgsave'], [0, 'global.rpgsave'], [1, 'file1.rpgsave'],
    ['Profile', 'profile.rpgsave'], [7, 'alternate/slot.rpgsave']];
  for (const [id, filename] of paths) storage.writeText(filename, lz.compressToBase64('existing:' + id));
  context.installNativeStorageManager();
  assert.equal(manager.isLocalMode(), true);
  for (const [id, filename] of paths) {
    assert.equal(manager.localFilePath(id), '/save/' + filename);
    assert.equal(manager.localFileExists(id), true);
    assert.equal(manager.loadFromLocalFile(id), 'existing:' + id);
    manager.saveToLocalFile(id, 'updated:' + id);
    assert.equal(lz.decompressFromBase64(storage.readText(filename)), 'updated:' + id);
  }
  assert.equal(storage.exists('fileProfile.rpgsave'), false);
  assert.equal(storage.exists('file7.rpgsave'), false);
});

test('plugin filenames govern backup, deletion, recovery and restore', () => {
  const { context, manager, storage, lz } = localStorageContext();
  manager.localFilePath = function(id) {
    return this.localFileDirectoryPath() + 'profiles/' + id + '.rpgsave';
  };
  context.installNativeStorageManager();
  for (const id of ['Profile', 7]) {
    const filename = 'profiles/' + id + '.rpgsave';
    manager.saveToLocalFile(id, 'original');
    manager.backup(id);
    assert.equal(lz.decompressFromBase64(storage.readText(filename + '.bak')), 'original');
    storage.remove(filename);
    assert.equal(manager.localFileExists(id), true);
    assert.equal(manager.loadFromLocalFile(id), 'original');
    manager.removeLocalFile(id);
    assert.equal(manager.localFileExists(id), false);
    assert.equal(manager.loadFromLocalFile(id), null);
    assert.equal(storage.exists(filename + '.bak'), true);
    manager.restoreBackup(id);
    assert.equal(manager.loadFromLocalFile(id), 'original');
    assert.equal(storage.exists(filename + '.deleted'), false);
    assert.equal(storage.exists(filename + '.bak'), false);
    manager.backup(id);
    manager.saveToLocalFile(id, 'replacement');
    manager.cleanBackup(id);
    assert.equal(manager.loadFromLocalFile(id), 'replacement');
    assert.equal(storage.exists(filename + '.bak'), false);
  }
});

test('MV reads plugin save paths containing Windows separators without changing the filename', () => {
  const { context, manager, storage, lz } = localStorageContext();
  manager.localFilePath = function(id) { return '/save\\profiles\\slot' + id + '.rpgsave'; };
  storage.writeText('profiles/slot2.rpgsave', lz.compressToBase64('legacy'));
  context.installNativeStorageManager();
  assert.equal(manager.localFileExists(2), true);
  assert.equal(manager.loadFromLocalFile(2), 'legacy');
  manager.saveToLocalFile(2, 'updated');
  manager.backup(2);
  assert.equal(lz.decompressFromBase64(storage.readText('profiles/slot2.rpgsave.bak')), 'updated');
  manager.removeLocalFile(2);
  assert.equal(manager.localFileExists(2), false);
  manager.restoreBackup(2);
  assert.equal(manager.loadFromLocalFile(2), 'updated');
});

test('plugin config and global filenames preserve data and report I/O failures', () => {
  const { context, manager, storage, lz } = localStorageContext();
  manager.localFilePath = function(id) {
    return this.localFileDirectoryPath() + (id < 0 ? 'settings.data' : 'index.data');
  };
  storage.writeText('settings.data', lz.compressToBase64('{"volume":80}'));
  storage.writeText('index.data', lz.compressToBase64('[null,{"title":"saved"}]'));
  context.installNativeStorageManager();
  assert.equal(manager.loadFromLocalFile(-1), '{"volume":80}');
  assert.equal(manager.loadFromLocalFile(0), '[null,{"title":"saved"}]');
  manager.saveToLocalFile(-1, '{"volume":50}');
  const originalRead = storage.readText;
  const originalWrite = storage.writeBytes;
  const ioError = Object.assign(new Error('save storage unavailable'), { code: 'EIO' });
  storage.writeBytes = () => { throw ioError; };
  assert.throws(() => manager.saveToLocalFile(-1, '{}'), error => error === ioError);
  storage.writeBytes = originalWrite;
  assert.equal(lz.decompressFromBase64(storage.readText('settings.data')), '{"volume":50}');
  storage.remove('index.data');
  storage.writeText('index.data', lz.compressToBase64('[null]'));
  storage.readText = () => { throw ioError; };
  assert.throws(() => manager.loadFromLocalFile(0), error => error === ioError);
  storage.readText = originalRead;
  assert.equal(storage.exists('config.rpgsave'), false);
  assert.equal(storage.exists('global.rpgsave'), false);
});
