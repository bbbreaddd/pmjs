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
  let generation = 0;
  const storage = {
    generation: () => generation,
    readText: name => files.has(name) ? files.get(name) : null,
    exists: name => files.has(name),
    writeText(name, value) { generation++; files.set(name, value); },
    remove(name) { generation++; files.delete(name); },
    rename() { throw new Error('save must not rename the primary'); }
  };
  const manager = {
    localFilePath: id => '/save/file' + id + '.rpgsave',
    loadFromLocalFile() {},
    localFileExists() {},
    saveToLocalFile(id, value) { storage.writeText('file' + id + '.rpgsave', value); }
  };
  const sandbox = { NativeHost: { storage }, StorageManager: manager,
    PMJS: { optimizations: { isEnabled: () => true } },
    LZString: { decompressFromBase64: value => value },
    queueMicrotask, Promise, setTimeout };
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  run(context, 'pmjs-mv/storage.js');
  vm.runInContext('installNativeStorageManager()', context);
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
  const input = { _currentState: {}, keyMapper: { 13: 'ok' }, gamepadMapper: {},
    _gamepadStates: [], update() { events.push('stock'); } };
  const sandbox = {
    Input: input,
    __pmjsInputSnapshot: { keysDown: [13], keysPressed: [] },
    PMJS: { phases: { on(name, owner, callback) { hooks[name] = callback; } } },
    NativeHost: { input: { consumePressed() { events.push('consumed'); } } }
  };
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  run(context, 'pmjs-rpgmaker/input.js');
  input.update = function() { events.push('guest'); };
  hooks.afterGuestPlugins();
  input.update();
  input._currentState.ok = true;
  input.keyMapper = { 13: 'cancel' };
  input.update();
  assert.deepEqual(events, ['guest', 'consumed', 'guest', 'consumed']);
  assert.equal(input._currentState.ok, false);
  assert.equal(input._currentState.cancel, true);
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
    PMJS: { phases: { on(name, owner, callback) { hooks[name] = callback; } },
      compat: { audit: true, hit: (...args) => hits.push(args) } }
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
  });
  const spriteset = { children: [] };
  ctx.PMJS.pixi4 = { releaseSceneResources(root) {
    assert.equal(root, spriteset);
    calls.push('release-scene');
  } };
  run(ctx, 'pmjs-mv/images.js');
  ctx.PMJS.plugins.execute('ReplaceTerminate', () => {
    Scene_Map.prototype.terminate = function() { calls.push('guest'); return 'done'; };
  });
  ctx.PMJS.methods.install();
  const scene = new Scene_Map();
  scene._spriteset = spriteset;
  assert.equal(scene.terminate(), 'done');
  assert.deepEqual(calls, ['guest', 'release-scene']);
  assert.equal(scene.terminate(), 'done');
  assert.deepEqual(calls, ['guest', 'release-scene', 'guest', 'release-scene']);
  assert.deepEqual(Array.from(ctx.PMJS.methods.dump().find(
    entry => entry.key === 'Scene_Map.terminate').mutations,
    entry => entry.plugin), ['ReplaceTerminate']);
});
