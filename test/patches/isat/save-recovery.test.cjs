'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');
const { createStorage } = require('../../../runner/storage.cjs');
const { temporaryDirectory } = require('../../helpers/temp.cjs');
const { runModule } = require('../../helpers/runtime-context.cjs');

function fixture(t, { existing = true, previousBackup = false, deleted = false, recognized = true } = {}) {
  const root = temporaryDirectory('isat-save-recovery-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const storage = createStorage(root);
  const encode = value => Buffer.from(value).toString('base64');
  const decode = value => value === null ? null : Buffer.from(value, 'base64').toString();
  const filename = 'slots/custom-1.rpgsave';
  if (existing) storage.writeText(filename, encode('old progress'));
  if (previousBackup) storage.writeText(filename + '.bak', encode('older progress'));
  if (deleted) storage.writeText(filename + '.deleted', '');
  storage.writeText('index.rpgsave', encode('old index'));
  const errors = [], warnings = [], calls = [];
  const context = vm.createContext({ Buffer, __pmjsBuiltinRequire: require, NativeHost: { storage },
    console: { error: error => errors.push(error), warn: message => warnings.push(message) },
    PMJS: { config: {}, optimizations: { register() {}, isEnabled() { return false; } },
      isatMethodHash() { return recognized ?
        '877e1a9f1fea9c52e9d8c4af2cd589d027e872762f35e4a9e0cc82fea48994b8' : 'foreign'; },
      phases: { on(_phase, _owner, install) { install(); } } },
    LZString: { compressToBase64: encode, decompressFromBase64: decode }
  });
  runModule(context, 'js/pmjs-web/filesystem.js');
  const guestFs = context.fsModule;
  const manager = context.StorageManager = {
    localFileDirectoryPath() { return '/save/'; },
    localFilePath(id) { return '/save/' + (id === 0 ? 'index.rpgsave' : filename); },
    loadFromLocalFile() {}, localFileExists() {},
    exists(id) { return this.localFileExists(id); },
    load(id) { return this.loadFromLocalFile(id); },
    save(id, json) { return this.saveToLocalFile(id, json); },
    saveToLocalFile(id, json) { guestFs.writeFileSync(this.localFilePath(id), encode(json)); },
    remove(id) { calls.push('remove'); return this.removeLocalFile(id); },
    removeLocalFile(id) { guestFs.unlinkSync(this.localFilePath(id)); },
    backup(id) {
      calls.push('backup');
      if (this.exists(id)) guestFs.writeFileSync(this.localFilePath(id) + '.bak', encode(this.load(id)));
    },
    restoreBackup(id) {
      calls.push('restore');
      const backup = this.localFilePath(id) + '.bak';
      if (!guestFs.existsSync(backup)) return;
      guestFs.writeFileSync(this.localFilePath(id), guestFs.readFileSync(backup));
      guestFs.unlinkSync(backup);
    }
  };
  runModule(context, 'js/pmjs-mv/storage.js');
  context.installNativeStorageManager();
  const original = function(id) {
    try { manager.backup(id); return this.saveGameWithoutRescue(id); }
    catch (error) {
      errors.push(error);
      try { manager.remove(id); manager.restoreBackup(id); } catch {}
      return false;
    }
  };
  context.Olivia = { MetaControls: { ___DataManager_saveGame___: original } };
  const data = context.DataManager = {
    saveGame(id) {
      calls.push('meta-controls');
      return context.Olivia.MetaControls.___DataManager_saveGame___.call(this, id);
    },
    saveGameWithoutRescue(id) {
      calls.push('save');
      manager.save(id, 'new progress');
      manager.save(0, 'new index');
      return true;
    }
  };
  runModule(context, 'patches/isat/save-recovery.js');
  function failWrites(fail) {
    const write = storage.writeBytes;
    storage.writeBytes = function(name, bytes, options) {
      const error = fail(name);
      if (error) throw error;
      return write.call(this, name, bytes, options);
    };
  }
  return { context, storage, manager, data, calls, errors, warnings, original, filename, decode, failWrites };
}

for (const previousBackup of [false, true]) {
  test('backup failure preserves the original and prior backup, existing backup=' + previousBackup, t => {
    const f = fixture(t, { previousBackup });
    const original = f.storage.readText(f.filename), backup = f.storage.readText(f.filename + '.bak');
    const failure = Object.assign(new Error('backup full'), { code: 'ENOSPC' });
    f.failWrites(name => name.endsWith('.bak') && failure);
    assert.equal(f.data.saveGame(1), false);
    assert.equal(f.storage.readText(f.filename), original);
    assert.equal(f.storage.readText(f.filename + '.bak'), backup);
    assert.equal(f.manager.load(1), 'old progress');
    assert.equal(f.storage.exists(f.filename + '.deleted'), false);
    assert.deepEqual(f.calls, ['meta-controls', 'backup']);
    assert.deepEqual(f.errors, [failure]);
  });
}

test('failed slot write and failed restoration retain the original and completed backup', t => {
  const f = fixture(t), failure = Object.assign(new Error('slot full'), { code: 'ENOSPC' });
  f.failWrites(name => name === f.filename && failure);
  assert.equal(f.data.saveGame(1), false);
  assert.equal(f.manager.load(1), 'old progress');
  assert.equal(f.decode(f.storage.readText(f.filename + '.bak')), 'old progress');
  assert.equal(f.storage.exists(f.filename + '.deleted'), false);
  assert.deepEqual(f.calls, ['meta-controls', 'backup', 'save', 'restore']);
  assert.deepEqual(f.errors, [failure, failure]);
});

test('a failed index write restores the previous slot without deleting it first', t => {
  const f = fixture(t), failure = new Error('index full');
  f.failWrites(name => name === 'index.rpgsave' && failure);
  assert.equal(f.data.saveGame(1), false);
  assert.equal(f.manager.load(1), 'old progress');
  assert.equal(f.manager.load(0), 'old index');
  assert.equal(f.storage.exists(f.filename + '.bak'), false);
  assert.equal(f.storage.exists(f.filename + '.deleted'), false);
  assert.deepEqual(f.calls, ['meta-controls', 'backup', 'save', 'restore']);
  assert.deepEqual(f.errors, [failure]);
});

test('a failed rollback preserves both the new primary and the previous progress', t => {
  const f = fixture(t), indexFailure = new Error('index failed'), rollbackFailure = new Error('restore failed');
  let slotWrites = 0;
  f.failWrites(name => name === 'index.rpgsave' ? indexFailure :
    name === f.filename && ++slotWrites > 1 ? rollbackFailure : false);
  assert.equal(f.data.saveGame(1), false);
  assert.equal(f.manager.load(1), 'new progress');
  assert.equal(f.decode(f.storage.readText(f.filename + '.bak')), 'old progress');
  assert.equal(f.storage.exists(f.filename + '.deleted'), false);
  assert.deepEqual(f.errors, [indexFailure, rollbackFailure]);
});

test('a new slot remains recoverable if its index write fails', t => {
  const f = fixture(t, { existing: false });
  f.failWrites(name => name === 'index.rpgsave' && new Error('index failed'));
  assert.equal(f.data.saveGame(1), false);
  assert.equal(f.manager.load(1), 'new progress');
  assert.equal(f.manager.load(0), 'old index');
  assert.equal(f.storage.exists(f.filename + '.deleted'), false);
});

test('successful saves retain MetaControls, plugin filenames, and the backup for ordinary cleanup', t => {
  const f = fixture(t);
  assert.equal(f.data.saveGame(1), true);
  assert.equal(f.manager.load(1), 'new progress');
  assert.equal(f.manager.load(0), 'new index');
  assert.equal(f.decode(f.storage.readText(f.filename + '.bak')), 'old progress');
  assert.deepEqual(f.calls, ['meta-controls', 'backup', 'save']);
  assert.deepEqual(f.errors, []);
});

test('unrecognized save handlers are retained and reported', t => {
  const f = fixture(t, { recognized: false });
  assert.equal(f.context.Olivia.MetaControls.___DataManager_saveGame___, f.original);
  assert.match(f.warnings[0], /unrecognized save handler/);
});


test('a failed new save does not restore a deliberately deleted slot from a stale backup', t => {
  const f = fixture(t, { existing: false, previousBackup: true, deleted: true });
  assert.equal(f.manager.exists(1), false);
  f.failWrites(name => name === 'index.rpgsave' && new Error('index failed'));
  assert.equal(f.data.saveGame(1), false);
  assert.equal(f.manager.load(1), 'new progress');
  assert.equal(f.decode(f.storage.readText(f.filename + '.bak')), 'older progress');
  assert.deepEqual(f.calls, ['meta-controls', 'backup', 'save']);
});
