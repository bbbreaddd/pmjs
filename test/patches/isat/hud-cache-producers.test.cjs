'use strict';

const { runOptimizationAdapter } = require('../../helpers/runtime-context.cjs');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../../../patches/isat/hud-cache-producers.js'), 'utf8');
const producerDigest = '9168991577fa8d790c99900b297737426d8994f98bfb030a5da7a3d590ad2976';
const battleProducerDigest = 'd47f7cbb9ced6396a05994c37693ecf2dc54b756d88ef892ea1175d45ce8e9eb';
const emptyBattleDataDigest = '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945';

function setup({ qualified = true, enabled = true, dataVerified = true, badProducer = false,
  withBattle = false, badBattleProducer = false, badBattleData = false, unreadableBattleData = false } = {}) {
  const stages = new WeakMap(), refused = [], read = [];
  let phase;
  const context = vm.createContext({
    __pmjsBuiltinRequire() { return { createHash() { return { update(text) {
      return { digest() {
        if (text === '[]') return emptyBattleDataDigest;
        if (text.includes('battleVisibility')) return badBattleProducer ? 'unknown' : battleProducerDigest;
        return badProducer || text === '[{}]' ? 'unknown' : producerDigest;
      } };
    } }; } }; },
    NativeHost: { fs: { readText(file) {
      read.push(file);
      if (file === 'data/BattleHUD.json' && withBattle && !unreadableBattleData) return badBattleData ? '[{}]' : '[]';
      throw Error('unexpected or unreadable data source');
    } } },
    PMJS: { isatSourceQualification: Object.freeze({ verified: qualified, dormontDataVerified: dataVerified }),
      optimizations: { register() {}, isEnabled() { return enabled; }, refuse(id, reason) { refused.push({ id, reason }); } },
      phases: { on(name, _owner, callback) { assert.equal(name, 'afterGuestPlugins'); phase = callback; } },
      pixi4: {
        getStageRenderOptions(stage) { return stages.get(stage); },
        setStageRenderOptions(stage, options) {
          if (!options) { stages.delete(stage); return; }
          options = { ...options };
          if (options.bitmapCacheProducers) options.bitmapCacheProducers = {
            ...options.bitmapCacheProducers, nodes: options.bitmapCacheProducers.nodes.slice()
          };
          stages.set(stage, options);
        }
      }
    }
  });
  vm.runInContext(`
    function MapHUD() { this.children = []; }
    MapHUD.prototype.updateVisibility = function() {};
    function Scene_Map() { this.children = []; }
    Scene_Map.prototype.createDisplayObjects = function() {
      this.calls = (this.calls || 0) + 1;
      this._hud = new MapHUD(); this.children = [this._hud];
      if (this.extraHud) this.children.push(new MapHUD());
      return 'created';
    };
    Scene_Map.prototype.terminate = function() { this.terminated = true; return 'terminated'; };
    var $gameMap = { id: 30, mapId: function() { return this.id; } };
    var $dataMap = {}, $dataCommonEvents = [], SceneManager = { _scene: null };
  `, context);
  if (withBattle) vm.runInContext(`
    function BattleHUD() { MapHUD.call(this); }
    BattleHUD.prototype = Object.create(MapHUD.prototype);
    BattleHUD.prototype.constructor = BattleHUD;
    BattleHUD.prototype.updateVisibility = function battleVisibility() {};
    function Scene_Battle() { this.children = []; }
    Scene_Battle.prototype.start = function() {
      this.calls = (this.calls || 0) + 1;
      if (!this._hud) { this._hud = new BattleHUD(); this.children = [this._hud]; }
      if (this.extraHud) this.children.push(new MapHUD());
      return 'battle-start';
    };
    Scene_Battle.prototype.terminate = function() { this.terminated = true; return 'battle-end'; };
    var $gameTroop = { data: { id: 26 }, troop: function() { return this.data; } };
    var $dataBattleHUD = [];
  `, context);
  context.PMJS.isatMethodHash = require('./test-fixtures/method-hash.cjs')(context.__pmjsBuiltinRequire);
  runOptimizationAdapter(source, context);
  phase();
  function create() {
    const scene = new context.Scene_Map(); context.SceneManager._scene = scene;
    assert.equal(scene.createDisplayObjects(), 'created'); return scene;
  }
  function createBattle() {
    const scene = new context.Scene_Battle(); context.SceneManager._scene = scene;
    assert.equal(scene.start(), 'battle-start'); return scene;
  }
  return { context, create, createBattle, refused, read, get: stage => stages.get(stage) };
}

test('Map030 automatically declares its exact HUD and validates live ownership', () => {
  const h = setup(), scene = h.create(), policy = h.get(scene).bitmapCacheProducers;
  assert.equal(policy.nodes.length, 1); assert.equal(policy.nodes[0], scene._hud);
  assert.equal(policy.valid(scene), true); assert.equal(scene.calls, 1);
  assert.equal(policy.valid({}), false);
  const data = h.context.$dataMap; h.context.$dataMap = {}; assert.equal(policy.valid(scene), false); h.context.$dataMap = data;
  const common = h.context.$dataCommonEvents; h.context.$dataCommonEvents = []; assert.equal(policy.valid(scene), false); h.context.$dataCommonEvents = common;
  const hud = scene._hud; scene._hud = new h.context.MapHUD(); assert.equal(policy.valid(scene), false); scene._hud = hud;
  const producer = hud.updateVisibility; hud.updateVisibility = () => {}; assert.equal(policy.valid(scene), false); delete hud.updateVisibility;
  assert.equal(hud.updateVisibility, producer);
  const token = h.context.PMJS.isatSourceQualification;
  h.context.PMJS.isatSourceQualification = { verified: true }; assert.equal(policy.valid(scene), false);
  h.context.PMJS.isatSourceQualification = token;
  h.context.SceneManager._scene = null; assert.equal(policy.valid(scene), false); h.context.SceneManager._scene = scene;
  assert.equal(policy.valid(scene), true);
  assert.deepEqual(h.read, []);
});

test('map exit and termination restore options without replacing a newer policy', () => {
  const h = setup(), scene = h.create();
  h.context.$gameMap.id = 22; scene.createDisplayObjects(); assert.equal(h.get(scene), undefined);
  h.context.$gameMap.id = 30;
  const prior = { nodes: [], valid() { return true; } };
  h.context.PMJS.pixi4.setStageRenderOptions(scene, { worldState: 'pixi', bitmapCacheProducers: prior, plainSpriteSegments: false });
  const saved = h.get(scene).bitmapCacheProducers; scene.createDisplayObjects();
  assert.notEqual(h.get(scene).bitmapCacheProducers, saved);
  assert.equal(scene.terminate(), 'terminated');
  assert.equal(h.get(scene).bitmapCacheProducers.valid, prior.valid);
  assert.equal(h.get(scene).worldState, 'pixi'); assert.equal(h.get(scene).plainSpriteSegments, false);
  scene.createDisplayObjects();
  const newer = { nodes: [], valid() { return false; } };
  h.context.PMJS.pixi4.setStageRenderOptions(scene, { worldState: 'native', bitmapCacheProducers: newer });
  const installed = h.get(scene).bitmapCacheProducers; scene.terminate(); assert.equal(h.get(scene).bitmapCacheProducers, installed);
});

test('inactive extra HUD producers and other maps retain ordinary preparation', () => {
  const h = setup(), scene = new h.context.Scene_Map(); scene.extraHud = true; h.context.SceneManager._scene = scene;
  scene.createDisplayObjects(); assert.equal(h.get(scene), undefined);
  h.context.$gameMap.id = 22; assert.equal(h.get(h.create()), undefined);
});

test('unknown sources, data, or producer composition never install a policy', () => {
  for (const options of [{ qualified: false }, { enabled: false }, { dataVerified: false }, { badProducer: true }]) {
    const h = setup(options), scene = h.create(); assert.equal(h.get(scene), undefined);
    assert.equal(h.refused.length, options.enabled === false ? 0 : 1);
  }
});

test('Bourdon declares its exact battle HUD independently of Dormont data', () => {
  const h = setup({ withBattle: true, dataVerified: false });
  const before = h.context.PMJS.isatHudCacheProducers.diagnostics(null);
  assert.equal(before.battleReady, true); assert.equal(before.configureCalls, 0); assert.equal(before.reason, 'not-configured');
  const scene = h.createBattle();
  const policy = h.get(scene).bitmapCacheProducers;
  assert.equal(policy.nodes.length, 1); assert.equal(policy.nodes[0], scene._hud);
  assert.equal(policy.valid(scene), true); assert.equal(scene.calls, 1);
  const after = h.context.PMJS.isatHudCacheProducers.diagnostics(scene);
  assert.equal(after.sceneConfigureCalls, 1); assert.equal(after.installed, true); assert.equal(after.reason, null);
  assert.equal(before.configureCalls, 0);
  assert.equal(h.get(h.create()), undefined);
  assert.deepEqual(h.refused, []); assert.deepEqual(h.read, ['data/BattleHUD.json']);
});

test('Bourdon admission guards loaded data, troop, scene, HUD and producer identities', () => {
  const h = setup({ withBattle: true }), scene = h.createBattle(), c = h.context;
  const policy = h.get(scene).bitmapCacheProducers;
  assert.equal(policy.valid({}), false);
  const data = c.$dataBattleHUD;
  c.$dataBattleHUD = []; assert.equal(policy.valid(scene), false); c.$dataBattleHUD = data;
  data.push({}); assert.equal(policy.valid(scene), false); data.pop();
  const troop = c.$gameTroop.data, owner = c.$gameTroop;
  c.$gameTroop.data = { id: 26 }; assert.equal(policy.valid(scene), false); c.$gameTroop.data = troop;
  c.$gameTroop = { troop() { return troop; } }; assert.equal(policy.valid(scene), false); c.$gameTroop = owner;
  troop.id = 25; assert.equal(policy.valid(scene), false); troop.id = 26;
  const hud = scene._hud; scene._hud = new c.BattleHUD(); assert.equal(policy.valid(scene), false); scene._hud = hud;
  hud.updateVisibility = () => {}; assert.equal(policy.valid(scene), false); delete hud.updateVisibility;
  const producer = c.BattleHUD.prototype.updateVisibility;
  c.BattleHUD.prototype.updateVisibility = () => {}; assert.equal(policy.valid(scene), false);
  c.BattleHUD.prototype.updateVisibility = producer;
  const HUD = c.BattleHUD; c.BattleHUD = function() {}; assert.equal(policy.valid(scene), false); c.BattleHUD = HUD;
  const qualification = c.PMJS.isatSourceQualification;
  c.PMJS.isatSourceQualification = { verified: true }; assert.equal(policy.valid(scene), false);
  c.PMJS.isatSourceQualification = qualification;
  c.SceneManager._scene = null; assert.equal(policy.valid(scene), false); c.SceneManager._scene = scene;
  assert.equal(policy.valid(scene), true);
});

test('unsupported battle data, producers, foreign troops and extra HUDs retain ordinary preparation', () => {
  for (const options of [{ badBattleProducer: true }, { badBattleData: true }, { unreadableBattleData: true }, { qualified: false }, { enabled: false }]) {
    const h = setup({ withBattle: true, ...options });
    assert.equal(h.get(h.createBattle()), undefined);
    // An unsupported battle candidate does not disable the independently reviewed map policy.
    if (options.qualified !== false && options.enabled !== false) assert.ok(h.get(h.create()));
  }
  for (const change of [
    c => { c.$gameTroop.data.id = 25; },
    c => { c.$dataBattleHUD.push({}); },
    c => { c.$dataBattleHUD = {}; }
  ]) {
    const h = setup({ withBattle: true }); change(h.context); assert.equal(h.get(h.createBattle()), undefined);
  }
  const h = setup({ withBattle: true }), scene = new h.context.Scene_Battle();
  scene.extraHud = true; h.context.SceneManager._scene = scene; scene.start();
  assert.equal(h.get(scene), undefined);
});

test('battle termination and scene reuse preserve foreign stage policies and authored callbacks', () => {
  const h = setup({ withBattle: true }), c = h.context, scene = new c.Scene_Battle(); c.SceneManager._scene = scene;
  const prior = { nodes: [], valid() { return true; } };
  c.PMJS.pixi4.setStageRenderOptions(scene, { worldState: 'pixi', bitmapCacheProducers: prior, plainSpriteSegments: false });
  const previous = h.get(scene).bitmapCacheProducers;
  assert.equal(scene.start(), 'battle-start'); assert.notEqual(h.get(scene).bitmapCacheProducers, previous);
  assert.equal(scene.terminate(), 'battle-end'); assert.equal(scene.terminated, true);
  assert.equal(h.get(scene).bitmapCacheProducers.valid, prior.valid);
  assert.equal(h.get(scene).worldState, 'pixi'); assert.equal(h.get(scene).plainSpriteSegments, false);
  scene.start(); assert.equal(h.get(scene).bitmapCacheProducers.valid(scene), true);
  const newer = { nodes: [], valid() { return false; } };
  c.PMJS.pixi4.setStageRenderOptions(scene, { worldState: 'pixi', bitmapCacheProducers: newer });
  const installed = h.get(scene).bitmapCacheProducers; scene.terminate();
  assert.equal(h.get(scene).bitmapCacheProducers, installed);
  const fresh = h.createBattle(); fresh.terminate(); assert.equal(h.get(fresh), undefined);
});
