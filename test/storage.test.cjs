'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { loadPmjsRuntime, runModule } = require('./helpers/runtime-context.cjs');
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

test('asynchronous storage replacement persists and rejects paths outside its root', async () => {
  const root = temporaryDirectory('pmjs-save-async-');
  const storage = createStorage(root);
  await storage.writeTextAsync('runtime/settings.json', 'first');
  await storage.writeTextAsync('runtime/settings.json', 'second');
  assert.equal(storage.readText('runtime/settings.json'), 'second');
  const rename = fs.promises.rename;
  try {
    fs.promises.rename = async () => { throw new Error('rename failed'); };
    await assert.rejects(storage.writeTextAsync('runtime/settings.json', 'third'), /rename failed/);
  } finally { fs.promises.rename = rename; }
  assert.equal(storage.readText('runtime/settings.json'), 'second');
  assert.deepEqual(storage.readDirectory('runtime'), ['settings.json']);
  await assert.rejects(storage.writeTextAsync('../escape', 'bad'), /invalid save path/);
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

function localStorageContext({ storage = createStorage(temporaryDirectory('pmjs-storage-paths-')),
  disabled = false } = {}) {
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
    PMJS_GAME_CONFIG: { disableOptimizations: disabled ? ['storage.read-burst-coalesce'] : [] },
  });
  for (const file of ['pmjs-web/filesystem.js', 'pmjs-mv/storage.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../js', file), 'utf8'), context);
  }
  guestFs = context.fsModule;
  return { context, manager, storage, lz };
}

for (const disabled of [false, true]) {
  test('MV primary read errors propagate with backups and deletion markers, cache disabled=' + disabled, () => {
    for (const backup of [false, true]) {
      for (const deleted of [false, true]) {
        const { context, manager, storage, lz } = localStorageContext({ disabled });
        storage.writeText('file1.rpgsave', lz.compressToBase64('primary'));
        if (backup) storage.writeText('file1.rpgsave.bak', lz.compressToBase64('backup'));
        if (deleted) storage.writeText('file1.rpgsave.deleted', '');
        context.installNativeStorageManager();
        const error = Object.assign(new Error('primary read failed'), { code: 'EIO' });
        const readText = storage.readText;
        storage.readText = function(name) {
          if (name === 'file1.rpgsave') throw error;
          return readText.call(this, name);
        };
        assert.equal(manager.localFileExists(1), true);
        assert.throws(() => manager.loadFromLocalFile(1), caught => caught === error);
        assert.throws(() => manager.loadFromLocalFile(1), caught => caught === error);
        storage.readText = readText;
        assert.equal(manager.loadFromLocalFile(1), 'primary');
      }
    }
  });

  test('MV recovery and deliberate deletion survive restart, cache disabled=' + disabled, () => {
    const { storage, lz } = localStorageContext({ disabled });
    storage.writeText('file1.rpgsave.bak', lz.compressToBase64('backup'));
    function restart() {
      const { context, manager } = localStorageContext({ storage, disabled });
      context.installNativeStorageManager();
      return manager;
    }
    let manager = restart();
    assert.equal(manager.localFileExists(1), true);
    assert.equal(manager.loadFromLocalFile(1), 'backup');
    manager.removeLocalFile(1);
    manager = restart();
    assert.equal(manager.localFileExists(1), false);
    assert.equal(manager.loadFromLocalFile(1), null);
    assert.equal(storage.exists('file1.rpgsave.bak'), true);
    manager.restoreBackup(1);
    manager = restart();
    assert.equal(manager.loadFromLocalFile(1), 'backup');
    assert.equal(storage.exists('file1.rpgsave.deleted'), false);
    manager.removeLocalFile(1);
    manager.saveToLocalFile(1, 'new save');
    assert.equal(restart().loadFromLocalFile(1), 'new save');
    assert.equal(storage.exists('file1.rpgsave.deleted'), false);
  });

  test('MV decompression and backup read errors propagate, cache disabled=' + disabled, () => {
    const { context, manager, storage, lz } = localStorageContext({ disabled });
    storage.writeText('file1.rpgsave', lz.compressToBase64('primary'));
    storage.writeText('file1.rpgsave.bak', lz.compressToBase64('backup'));
    context.installNativeStorageManager();
    const error = new Error('decompression failed');
    const decompress = lz.decompressFromBase64;
    lz.decompressFromBase64 = value => {
      if (value === lz.compressToBase64('primary')) throw error;
      return decompress(value);
    };
    assert.throws(() => manager.loadFromLocalFile(1), caught => caught === error);
    lz.decompressFromBase64 = decompress;
    storage.remove('file1.rpgsave');
    const readText = storage.readText;
    storage.readText = function(name) {
      if (name.endsWith('.bak')) throw error;
      return readText.call(this, name);
    };
    assert.throws(() => manager.loadFromLocalFile(1), caught => caught === error);
  });
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

test('synchronous-burst storage read coalescing preserves stock DataManager object identity and coalesces storage I/O', async () => {
  let storageReads = 0;
  let storageStats = 0;
  let lzDecompresses = 0;

  const sampleGlobalData = {
    1: { title: 'Save 1', playtime: '01:00:00' },
    2: { title: 'Save 2', playtime: '02:00:00' }
  };
  const serializedJson = JSON.stringify(sampleGlobalData);

  let storageGeneration = 0;
  const mockStorage = {
    generation: () => storageGeneration,
    exists(p) {
      storageStats++;

      if (p === 'save/file1.rpgsave' || p === 'file1.rpgsave') return true;
      if (p === 'save/file2.rpgsave' || p === 'file2.rpgsave') return true;
      if (p === 'save/global.rpgsave' || p === 'global.rpgsave') return true;
      return false;
    },
    readText(p) {
      storageReads++;
      if (p === 'save/global.rpgsave' || p === 'global.rpgsave') {
        return 'BASE64_MOCK_GLOBAL';
      }
      return null;
    },
    writeText() { storageGeneration++; },
    remove() { storageGeneration++; },
    rename() { storageGeneration++; }
  };

  const mockLZString = {
    decompressFromBase64(str) {
      lzDecompresses++;
      if (str === 'BASE64_MOCK_GLOBAL') return serializedJson;
      return null;
    }
  };

  const StorageManager = {
    isLocalMode() { return true; },
    localFilePath(savefileId) {
      if (savefileId === 0) return '/save/global.rpgsave';
      return '/save/file' + savefileId + '.rpgsave';
    },
    load(savefileId) {
      return this.loadFromLocalFile(savefileId);
    },
    loadFromLocalFile(savefileId) {
      const p = this.localFilePath(savefileId);
      const relative = p.startsWith('/save/') ? p.slice(6) : p;
      const text = mockStorage.readText(relative);
      return mockLZString.decompressFromBase64(text);
    },
    exists(savefileId) {
      return this.localFileExists(savefileId);
    },
    localFileExists(savefileId) {
      const p = this.localFilePath(savefileId);
      const relative = p.startsWith('/save/') ? p.slice(6) : p;
      return mockStorage.exists(relative);
    },
    saveToLocalFile(savefileId, json) {},
    backup(savefileId) {},
    remove(savefileId) { mockStorage.remove(this.localFilePath(savefileId).slice(6)); }
  };

  const DataManager = {
    maxSavefiles() { return 20; },
    loadGlobalInfo() {
      const json = StorageManager.load(0);
      if (json) {
        const globalInfo = JSON.parse(json);
        for (let i = 1; i <= this.maxSavefiles(); i++) {
          if (!StorageManager.exists(i)) {
            delete globalInfo[i];
          }
        }
        return globalInfo;
      }
      return [];
    }
  };

  const sandbox = {
    NativeHost: { storage: mockStorage },
    PMJS: { optimizations: { isEnabled: () => true } },
    StorageManager: StorageManager,
    DataManager: DataManager,
    LZString: mockLZString,
    queueMicrotask: globalThis.queueMicrotask,
    Promise: globalThis.Promise,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout
  };
  sandbox.globalThis = sandbox;

  const context = vm.createContext(sandbox);

  runModule(context, 'js/pmjs-mv/storage.js');
  vm.runInContext('installNativeStorageManager()', context);

  const a = context.DataManager.loadGlobalInfo();
  const b = context.DataManager.loadGlobalInfo();

  assert.notEqual(a, b, 'Each loadGlobalInfo call must return a fresh, distinct object reference');
  assert.deepEqual(a, b, 'Contents should match');

  a[1].title = 'Mutated by plugin';
  assert.equal(b[1].title, 'Save 1', 'Mutating a must not affect b');

  for (let i = 0; i < 14; i++) {
    context.DataManager.loadGlobalInfo();
  }

  assert.equal(storageReads, 1, 'Only 1 storage read for the entire burst of 16 calls');
  assert.equal(lzDecompresses, 16, 'Every load must call the effective guest decompressor');
  assert.equal(storageStats, 38, 'Missing slots check primary and backup once per burst');

  context.StorageManager.remove(1);
  const c = context.DataManager.loadGlobalInfo();
  assert.equal(storageReads, 2, 'Storage mutation must invalidate burst cache, causing fresh read');
  assert.equal(lzDecompresses, 17, 'Loads continue decoding after a storage mutation');
  assert.equal(storageStats, 76, 'Storage mutation must invalidate burst cache, causing fresh stats');

  await new Promise(resolve => queueMicrotask(resolve));
  const d = context.DataManager.loadGlobalInfo();
  assert.equal(storageReads, 3, 'New microtask turn must execute fresh storage read');
  assert.equal(lzDecompresses, 18, 'Loads continue decoding in the next microtask turn');
  assert.equal(storageStats, 114, 'New microtask turn must execute fresh stats');
});

test('storage read coalescing runs underneath plugin wrappers and respects dynamic localFilePath', () => {
  let physicalReads = 0;
  let physicalStats = 0;
  let pluginLoadCalls = 0;
  let pluginExistsCalls = 0;

  let storageGeneration = 0;
  const mockStorage = {
    generation: () => storageGeneration,
    exists(p) {
      physicalStats++;
      return true;
    },
    readText(p) {
      physicalReads++;
      return p.includes('profileA') ? '{"profile":"A"}' : '{"profile":"B"}';
    },
    writeText() { storageGeneration++; },
    remove() { storageGeneration++; },
    rename() { storageGeneration++; }
  };

  const mockLZString = {
    decompressFromBase64(s) { return s; }
  };

  let activeProfile = 'profileA';

  const StorageManager = {
    isLocalMode() { return true; },
    localFilePath(savefileId) {
      if (savefileId < 0) return '/save/config.rpgsave';
      if (savefileId === 0) return '/save/global.rpgsave';
      return '/save/file' + savefileId + '.rpgsave';
    },
    load(savefileId) {
      return this.loadFromLocalFile(savefileId);
    },
    loadFromLocalFile(savefileId) {
      const p = this.localFilePath(savefileId).slice(6);
      return mockLZString.decompressFromBase64(mockStorage.readText(p));
    },
    exists(savefileId) {
      return this.localFileExists(savefileId);
    },
    localFileExists(savefileId) {
      const p = this.localFilePath(savefileId).slice(6);
      return mockStorage.exists(p);
    },
    saveToLocalFile() {},
    backup() {},
    remove() {}
  };

  let jsonParses = 0;
  const DataManager = {
    maxSavefiles() { return 2; },
    loadGlobalInfo() {
      const json = StorageManager.load(0);
      if (json) {
        jsonParses++;
        return JSON.parse(json);
      }
      return [];
    }
  };

  const sandbox = {
    NativeHost: { storage: mockStorage },
    PMJS: { optimizations: { isEnabled: () => true } },
    StorageManager: StorageManager,
    DataManager: DataManager,
    LZString: mockLZString,
    queueMicrotask: globalThis.queueMicrotask,
    Promise: globalThis.Promise,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout
  };
  sandbox.globalThis = sandbox;

  const context = vm.createContext(sandbox);

  runModule(context, 'js/pmjs-mv/storage.js');
  vm.runInContext('installNativeStorageManager()', context);

  context.StorageManager.localFilePath = function(savefileId) {
    return '/save/' + activeProfile + '/file' + savefileId + '.rpgsave';
  };
  const origLoadFromLocalFile = context.StorageManager.loadFromLocalFile;
  context.StorageManager.loadFromLocalFile = function(savefileId) {
    pluginLoadCalls++;
    return origLoadFromLocalFile.call(this, savefileId);
  };

  const origLocalFileExists = context.StorageManager.localFileExists;
  context.StorageManager.localFileExists = function(savefileId) {
    pluginExistsCalls++;
    return origLocalFileExists.call(this, savefileId);
  };

  const res1 = context.StorageManager.load(1);
  const res2 = context.StorageManager.load(1);

  assert.equal(pluginLoadCalls, 2, 'Plugin wrapper must run on every single StorageManager.load call');
  assert.equal(physicalReads, 1, 'Underneath, low-level physical disk read is coalesced to 1');
  assert.equal(res1, '{"profile":"A"}');
  assert.equal(res2, '{"profile":"A"}');

  const ex1 = context.StorageManager.exists(1);
  const ex2 = context.StorageManager.exists(1);
  assert.equal(pluginExistsCalls, 2, 'Plugin wrapper must run on every single StorageManager.exists call');
  assert.equal(physicalStats, 1, 'Underneath, physical stat is coalesced to 1');

  const g1 = context.DataManager.loadGlobalInfo();
  const g2 = context.DataManager.loadGlobalInfo();
  assert.notEqual(g1, g2, 'Each loadGlobalInfo must return a fresh object');
  assert.equal(jsonParses, 2, 'JSON.parse must run on every loadGlobalInfo call');
  assert.equal(pluginLoadCalls, 4, 'Plugin load wrapper must run on every loadGlobalInfo call');
  assert.equal(physicalReads, 2, 'Only one physical read for the new file0 path across both calls');

  activeProfile = 'profileB';
  const resB = context.StorageManager.load(1);
  assert.equal(pluginLoadCalls, 5, 'Plugin wrapper runs on profile B call');
  assert.equal(physicalReads, 3, 'Switching directory path must perform a physical read for new path');
  assert.equal(resB, '{"profile":"B"}', 'Result must reflect profile B, not stale profile A');

  mockStorage.writeText('profileB/file1.rpgsave', 'something');
  const resAfterWrite = context.StorageManager.load(1);
  assert.equal(pluginLoadCalls, 6);
  assert.equal(physicalReads, 4, 'Direct NativeHost.storage write must invalidate read burst');

  runModule(context, 'js/pmjs-mv/storage.js');
  vm.runInContext('installNativeStorageManager()', context);
  assert.equal(
    context.StorageManager.localFilePath(1),
    '/save/profileB/file1.rpgsave',
    'Reinstall must preserve the plugin localFilePath override');
  const resReinstall = context.StorageManager.load(1);
  assert.equal(pluginLoadCalls, 7, 'Plugin wrapper must still be outermost after reinstall');
  assert.equal(resReinstall, '{"profile":"B"}');
  assert.equal(physicalReads, 4, 'Live burst must survive reinstall (still a hit, no new physical read)');
});

test('storage.read-burst-coalesce disables cleanly via optimization gate', () => {
  function makeStorageContext(disabled = false) {
    let reads = 0;
    const context = {
      PMJS_GAME_CONFIG: disabled ? { disableOptimizations: ['storage.read-burst-coalesce'] } : {},
      NativeHost: {
        storage: {
          generation: () => 0,
          exists: () => true,
          readText: () => { reads++; return 'BASE64_DATA'; },
          writeText: () => {},
          remove: () => {},
          rename: () => {}
        }
      },
      StorageManager: {
        isLocalMode: () => true,
        localFilePath: () => '/save/global.rpgsave',
        loadFromLocalFile: function(id) {
          reads++;
          return '{"test":1}';
        },
        localFileExists: () => true
      },
      LZString: {
        decompressFromBase64: s => s
      },
      queueMicrotask: globalThis.queueMicrotask
    };
    context.globalThis = context;
    vm.createContext(context);
    runModule(context, 'js/pmjs-core/config.js');
    runModule(context, 'js/pmjs-core/optimizations.js');
    runModule(context, 'js/pmjs-mv/storage.js');
    vm.runInContext('installNativeStorageManager()', context);
    return { context, getReads: () => reads };
  }

  // Enabled: reads coalesce in synchronous burst
  const enabled = makeStorageContext(false);
  enabled.context.StorageManager.loadFromLocalFile(0);
  enabled.context.StorageManager.loadFromLocalFile(0);
  assert.equal(enabled.getReads(), 1, 'enabled read-burst-coalesce should coalesce reads to 1');

  // Disabled: reads bypass burst cache every call
  const disabled = makeStorageContext(true);
  disabled.context.StorageManager.loadFromLocalFile(0);
  disabled.context.StorageManager.loadFromLocalFile(0);
  assert.equal(disabled.getReads(), 2, 'disabled read-burst-coalesce should read on every call');
});

test('save paths reject escaping links across sync and async operations and allow internal links', async t => {
  const root = temporaryDirectory('pmjs-links-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const actual = path.join(root, 'actual'), outside = path.join(root, 'outside');
  fs.mkdirSync(actual); fs.mkdirSync(outside);
  fs.symlinkSync(actual, path.join(root, 'save'));
  const storage = createStorage(path.join(root, 'save'));
  storage.writeText('inside/source', 'keep');
  fs.symlinkSync(outside, path.join(actual, 'alias'));
  fs.symlinkSync(path.join(outside, 'missing'), path.join(actual, 'dangling'));
  fs.symlinkSync(path.join(actual, 'inside'), path.join(actual, 'internal'));
  for (const alias of ['alias', 'dangling']) {
    for (const operation of [
      () => storage.writeText(alias + '/new/nested', 'bad'),
      () => storage.writeBytes(alias + '/append', Buffer.from('bad'), { flag: 'a' }),
      () => storage.readBytes(alias + '/file'),
      () => storage.mkdir(alias + '/folder', { recursive: true }),
      () => storage.rename('inside/source', alias + '/destination'),
      () => storage.rename(alias + '/source', 'inside/destination'),
      () => storage.remove(alias + '/file')
    ]) assert.throws(operation, { code: 'EACCES' });
    await assert.rejects(storage.writeTextAsync(alias + '/new', 'bad'), { code: 'EACCES' });
    await assert.rejects(storage.readBytesAsync(alias + '/file'), { code: 'EACCES' });
    await assert.rejects(storage.openReadAsync(alias + '/file'), { code: 'EACCES' });
  }
  storage.writeText('internal/new/nested', 'valid');
  assert.equal(storage.readText('inside/new/nested'), 'valid');
  assert.equal(storage.readText('inside/source'), 'keep');
  assert.deepEqual(fs.readdirSync(outside), []);
});


test('save root access rejects a root link redirected after storage creation', t => {
  const root = temporaryDirectory('pmjs-root-link-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'actual')); fs.mkdirSync(path.join(root, 'outside'));
  const link = path.join(root, 'save');
  fs.symlinkSync(path.join(root, 'actual'), link);
  const storage = createStorage(link);
  fs.unlinkSync(link); fs.symlinkSync(path.join(root, 'outside'), link);
  assert.throws(() => storage.stat('.'), { code: 'EACCES' });
  assert.throws(() => storage.readDirectory(''), { code: 'EACCES' });
});
