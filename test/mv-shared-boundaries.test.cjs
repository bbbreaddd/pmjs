'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadPmjsRuntime } = require('./helpers/runtime-context.cjs');

const runtime = path.join(__dirname, '..', 'js');
function run(context, file) {
  vm.runInContext(fs.readFileSync(path.join(runtime, file), 'utf8'), context);
}

test('missing primary save recovers from backup without moving the primary during save', () => {
  const files = new Map([['file1.rpgsave.bak', 'old']]);
  const storage = {
    readText: name => files.has(name) ? files.get(name) : null,
    exists: name => files.has(name),
    writeText(name, value) { files.set(name, value); },
    remove(name) { files.delete(name); },
    rename() { throw new Error('save must not rename the primary'); }
  };
  const manager = {
    localFilePath: id => '/save/file' + id + '.rpgsave',
    loadFromLocalFile() {},
    localFileExists() {},
    saveToLocalFile(id, value) { storage.writeText('file' + id + '.rpgsave', value); }
  };
  const sandbox = { NativeHost: { storage }, StorageManager: manager,
    LZString: { decompressFromBase64: value => value },
    queueMicrotask, Promise, setTimeout };
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  run(context, 'pmjs-mv/storage.js');
  assert.equal(manager.localFileExists(1), true);
  assert.equal(manager.loadFromLocalFile(1), 'old');
  manager.saveToLocalFile(1, 'new');
  assert.equal(files.get('file1.rpgsave'), 'new');
  assert.equal(files.get('file1.rpgsave.bak'), 'old');
  assert.equal(manager.loadFromLocalFile(1), 'new');
});

test('native input wraps the guest replacement at the post-plugin boundary', () => {
  const events = [];
  const hooks = {};
  const input = { _currentState: {}, update() { events.push('stock'); } };
  const sandbox = {
    Input: input,
    PMJS: { phases: { on(name, owner, callback) { hooks[name] = callback; } } },
    NativeHost: { input: { down: action => action === 'ok', pressed: () => false,
      consumePressed() { events.push('consumed'); } } }
  };
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  run(context, 'pmjs-rpgmaker/input.js');
  input.update = function() { events.push('guest'); };
  hooks.afterGuestPlugins();
  input.update();
  assert.deepEqual(events, ['guest', 'consumed']);
  assert.equal(input.update._pmjsNativeBridge, true);
});

test('diagnostics inspect methods after plugins without replacing setup', () => {
  const hooks = {};
  const hits = [];
  const setup = function() {};
  const sandbox = {
    nativeCompatibilityStrict: true, nativeCompatibilityVerbose: false,
    nativeCompatibilityHit: (...args) => hits.push(args),
    PluginManager: { setup },
    PMJS: { phases: { on(name, owner, callback) { hooks[name] = callback; } } }
  };
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  run(context, 'pmjs-mv/diagnostics.js');
  assert.equal(sandbox.PluginManager.setup, setup);
  hooks.afterPlugins();
  assert.ok(hits.some(([kind, name]) => kind === 'compat.missingClass' && name === 'Bitmap'));
});

test('native map resources release after a guest replaces Scene_Map.terminate', () => {
  const calls = [];
  function Scene_Map() {}
  Scene_Map.prototype.terminate = function() { calls.push('stock'); };
  const ctx = loadPmjsRuntime({
    Scene_Map,
    SceneManager: function() {}, DataManager: function() {},
    Game_Map: function() {}, Scene_Boot: function() {},
    Spriteset_Map: function() {}, Window_Base: function() {},
    nativeBootPhase() {},
    NativeHost: { render: {
      releaseTileLayer(handle) { calls.push('tile:' + handle); },
      releaseMesh(handle) { calls.push('mesh:' + handle); }
    } }
  });
  run(ctx, 'pmjs-mv/images.js');
  ctx.PMJS.plugins.execute('ReplaceTerminate', () => {
    Scene_Map.prototype.terminate = function() { calls.push('guest'); return 'done'; };
  });
  ctx.PMJS.methods.install();
  const scene = new Scene_Map();
  const sharedChild = { _pmjsNativeLayer: 12, __pmjsNativeMesh: 34, children: [] };
  scene._spriteset = { children: [sharedChild, sharedChild] };
  assert.equal(scene.terminate(), 'done');
  assert.deepEqual(calls, ['guest', 'tile:12', 'mesh:34']);
  assert.equal(sharedChild._pmjsNativeLayer, 0);
  assert.equal(sharedChild.__pmjsNativeMesh, 0);
  assert.equal(scene.terminate(), 'done');
  assert.deepEqual(calls, ['guest', 'tile:12', 'mesh:34', 'guest']);
  assert.deepEqual(Array.from(ctx.PMJS.methods.dump().find(
    entry => entry.key === 'Scene_Map.terminate').mutations,
    entry => entry.plugin), ['ReplaceTerminate']);
});
