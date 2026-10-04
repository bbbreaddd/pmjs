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
  const { temporaryDirectory } = require('./helpers/temp.cjs');
  const directory = temporaryDirectory('pmjs-mz-save-contract-');
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


test('MZ compressed save strings survive UTF-8 writes, restart and backup recovery', t => {
  const { createStorage } = require('../runner/storage.cjs');
  const { deflateSync, inflateSync } = require('node:zlib');
  const { temporaryDirectory } = require('./helpers/temp.cjs');
  const directory = temporaryDirectory('pmjs-mz-compressed-save-');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const context = vm.createContext({ Buffer, Utils: {}, StorageManager: {},
    NativeHost: { storage: createStorage(directory) }, PMJS: { config: {} } });
  vm.runInContext(fs.readFileSync(path.join(__dirname,
    '../js/pmjs-web/filesystem.js'), 'utf8'), context);
  vm.runInContext(source, context);
  const contents = { '@': 'Game_System', title: '日本語 / café / 🌙',
    variables: [null, 12, { enabled: true }], inventory: { 3: 2 } };
  const compressed = deflateSync(JSON.stringify(contents), { level: 1 });
  assert.ok(compressed.some(byte => byte > 127));
  // MZ writes its compressed binary string with Node's default UTF-8 encoding.
  const zip = compressed.toString('latin1');
  const save = context.StorageManager.fileDirectoryPath() + 'file1.rmmzsave';
  context.fsModule.writeFileSync(save, zip);
  context.NativeHost.storage = createStorage(directory);
  const restored = context.fsModule.readFileSync(save, 'utf8');
  assert.equal(restored, zip);
  assert.deepEqual(JSON.parse(inflateSync(Buffer.from(restored, 'latin1')).toString('utf8')), contents);
  assert.deepEqual(fs.readFileSync(path.join(directory, 'file1.rmmzsave')), Buffer.from(zip, 'utf8'));
  context.fsModule.renameSync(save, save + '_');
  context.fsModule.writeFileSync(save, 'interrupted replacement');
  context.NativeHost.storage = createStorage(directory);
  context.fsModule.unlinkSync(save);
  context.fsModule.renameSync(save + '_', save);
  assert.equal(context.fsModule.readFileSync(save, 'utf8'), zip);
  assert.equal(context.fsModule.existsSync(save + '_'), false);
});
