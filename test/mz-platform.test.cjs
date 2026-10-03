'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.resolve(__dirname,
  '../js/pmjs-mz/platform.js'), 'utf8');

function runWith(host, fonts) {
  const context = vm.createContext({
    globalThis: null,
    NativeHost: host,
    PMJS: fonts ? { fonts: {} } : {},
    Utils: {},
  });
  context.globalThis = context;
  vm.runInContext(source, context, { filename: 'pmjs-mz/platform.js' });
  return context.Utils;
}

test('MZ platform capabilities reflect native services', () => {
  const utils = runWith({ render: {}, scene: {}, media: {}, storage: {} }, true);
  assert.equal(utils.canUseWebGL(), true);
  assert.equal(utils.canUseWebAudioAPI(), true);
  assert.equal(utils.canUseCssFontLoading(), true);
  assert.equal(utils.canUseIndexedDB(), true);
  assert.equal(utils.canPlayOgg(), true);
  assert.equal(utils.canPlayWebm(), true);
});

test('MZ platform capabilities do not claim missing native services', () => {
  const utils = runWith({}, false);
  assert.equal(utils.canUseWebGL(), false);
  assert.equal(utils.canUseWebAudioAPI(), false);
  assert.equal(utils.canUseCssFontLoading(), false);
  assert.equal(utils.canUseIndexedDB(), false);
  assert.equal(utils.canPlayOgg(), false);
  assert.equal(utils.canPlayWebm(), false);
});

test('MZ local save paths resolve through the native storage filesystem', t => {
  const { createStorage } = require('../runner/storage.cjs');
  const os = require('node:os');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pmjs-mz-save-contract-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const storage = createStorage(directory);
  const context = vm.createContext({ Buffer, Utils: {}, StorageManager: {},
    NativeHost: { storage }, PMJS: { config: {} } });
  vm.runInContext(fs.readFileSync(path.join(__dirname,
    '../js/pmjs-web/filesystem.js'), 'utf8'), context);
  vm.runInContext(source, context);
  assert.equal(context.StorageManager.isLocalMode(), true);
  assert.equal(context.StorageManager.fileDirectoryPath(), '/save/');
  const save = context.StorageManager.fileDirectoryPath() + 'file1.rmmzsave';
  const bytes = Buffer.from([0, 255, 128, 42]);
  context.fsModule.writeFileSync(save, bytes);
  const restartedStorage = createStorage(directory);
  assert.deepEqual(restartedStorage.readBytes('file1.rmmzsave'), bytes);
  context.NativeHost.storage = restartedStorage;
  context.fsModule.renameSync(save, save + '_');
  context.fsModule.writeFileSync(save, '日本語 / café / 🌙', 'utf8');
  assert.equal(context.fsModule.readFileSync(save, 'utf8'), '日本語 / café / 🌙');
  context.fsModule.unlinkSync(save);
  context.fsModule.renameSync(save + '_', save);
  assert.deepEqual(context.fsModule.readFileSync(save), bytes);
});
