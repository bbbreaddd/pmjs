'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const runtimeRoot = path.resolve(__dirname, '..');
const optimizationsSource = fs.readFileSync(
  path.join(runtimeRoot, 'js/pmjs-core/optimizations.js'), 'utf8');
const moduleSource = fs.readFileSync(
  path.join(runtimeRoot, 'js/pmjs-plugins/yanfly/slippery-tiles.js'), 'utf8');
const lifecycleSource = fs.readFileSync(
  path.join(runtimeRoot, 'js/pmjs-rpgmaker/lifecycle.js'), 'utf8');
const methodsSource = fs.readFileSync(
  path.join(runtimeRoot, 'js/pmjs-core/methods.js'), 'utf8');
const pluginsSource = fs.readFileSync(
  path.join(runtimeRoot, 'js/pmjs-rpgmaker/plugins.js'), 'utf8');

const SLIPPERY_QUERY_SHAPE = `function(mx, my) {
    if ($gameParty.inBattle()) return false;
    if (this.isValid(mx, my) && this.tileset()) {
      if (Yanfly.Param.SlipRegion !== 0 &&
        this.regionId(mx, my) === Yanfly.Param.SlipRegion) return true;
      var tagId = this.terrainTag(mx, my);
      var slipTiles = this.tileset().slippery;
      return slipTiles.contains(tagId);
    }
    return false;
}`;

function makeHost({
  disableOptimizations = [],
  env = {},
  regions = null,
  tilesetSlip = [],
  slipRegion = 10,
  isTiled = true,
  stockMap = null,
  autoActivate = true,
} = {}) {
  const calls = { regionId: 0, terrainTag: 0, isValid: 0, changeTileset: 0 };
  const context = {
    calls,
    PMJS_GAME_CONFIG: { disableOptimizations },
    NativeHost: {
      runtime: {
        env(key) {
          return env[key];
        }
      }
    },
    Yanfly: {
      Param: {
        SlipRegion: slipRegion
      }
    },
    $gameParty: {
      inBattle() { return false; }
    },
    console: { log() {} },
  };

  if (stockMap) {
    context.$dataMap = stockMap;
  }

  context.Game_Map = function GameMap() {
    this.currentMapLevel = 0;
    this._regions = regions || [new Array(100).fill(0)];
    this._tiled = isTiled;
    this._tileset = {
      slippery: new context.Array(...(Array.isArray(tilesetSlip) ? tilesetSlip : []))
    };
  };

  vm.createContext(context);
  vm.runInContext(lifecycleSource, context, { filename: 'lifecycle.js' });
  vm.runInContext(methodsSource, context, { filename: 'methods.js' });
  vm.runInContext(pluginsSource, context, { filename: 'plugins.js' });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/pmjs-core/config.js'), 'utf8'), context);
  vm.runInContext(optimizationsSource, context, { filename: 'optimizations.js' });
  vm.runInContext(
    `Game_Map.prototype.isValid = function(x, y) { calls.isValid++; return true; };` +
    `Game_Map.prototype.tileset = function() { return this._tileset; };` +
    `Game_Map.prototype.isTiledMap = function() { return this._tiled; };` +
    `Game_Map.prototype.regionId = function(x, y) { calls.regionId++; var r = this._regions[this.currentMapLevel]; return r ? r[x] : 0; };` +
    `Game_Map.prototype.terrainTag = function(x, y) { calls.terrainTag++; return 0; };` +
    `Game_Map.prototype.setup = function(mapId) {};` +
    `Game_Map.prototype.changeTileset = function(tilesetId) { calls.changeTileset++; };` +
    `Game_Map.prototype.width = function() { return 10; };` +
    `Game_Map.prototype.height = function() { return 10; };` +
    `Game_Map.prototype.isSlippery = (${SLIPPERY_QUERY_SHAPE});` +
    `Array.prototype.contains = function(element) { return this.indexOf(element) >= 0; };`,
    context, { filename: 'slippery-shape.js' }
  );
  context.Array = vm.runInContext('Array', context);

  vm.runInContext(moduleSource, context, { filename: 'slippery-tiles.js' });
  if (autoActivate) {
    context.PMJS.plugins.execute('YEP_SlipperyTiles', function() {});
    context.PMJS.phases.emit('afterGuestPlugins');
  }
  return context;
}

test('registers plugins.yanfly.slippery-tiles optimization', () => {
  const context = makeHost({ slipRegion: 0 });
  assert.equal(context.PMJS.optimizations.isEnabled('plugins.yanfly.slippery-tiles'), true);
  assert.ok(context.PMJS.optimizations.ids().includes('plugins.yanfly.slippery-tiles'));
});

test('plugin lifecycle hook ignores unrelated plugins', () => {
  const context = makeHost({ autoActivate: false, slipRegion: 0 });
  vm.runInContext(
    `Game_Map.prototype.isSlippery = (${SLIPPERY_QUERY_SHAPE});` +
    `delete Game_Map.prototype.__pmjsSlipperyTilesGuard;`, context);
  const stock = context.Game_Map.prototype.isSlippery;

  context.PMJS.plugins.execute('SomeOtherPlugin', function() {});
  assert.equal(context.Game_Map.prototype.isSlippery, stock);
  context.PMJS.plugins.execute('YEP_SlipperyTiles', function() {});
  context.PMJS.phases.emit('afterGuestPlugins');
  assert.notEqual(context.Game_Map.prototype.isSlippery, stock);
  assert.equal(context.Game_Map.prototype.__pmjsSlipperyTilesGuard, true);
});

test('composed array membership declines the optional fast path', () => {
  const context = makeHost({ slipRegion: 0, autoActivate: false });
  const original = context.Game_Map.prototype.isSlippery;
  vm.runInContext('Array.prototype.contains = function() { return true; };', context);
  context.PMJS.plugins.execute('YEP_SlipperyTiles', function() {});
  context.PMJS.phases.emit('afterGuestPlugins');
  assert.equal(context.Game_Map.prototype.isSlippery, original);
  assert.equal(new context.Game_Map().isSlippery(5, 5), true);
});

test('configured slippery regions use the guest query even when absent initially', () => {
  const context = makeHost({
    regions: [new Array(100).fill(0)],
    tilesetSlip: [],
    slipRegion: 10,
    isTiled: true
  });
  const map = new context.Game_Map();

  assert.equal(map.isSlippery(5, 5), false);
  assert.equal(context.calls.isValid, 1);
  map._regions[0][5] = 10;
  assert.equal(map.isSlippery(5, 5), true);
  assert.equal(context.calls.regionId, 2);
  assert.equal(context.Game_Map.prototype.__pmjsSlipperyTilesGuard, undefined);
  assert.match(context.PMJS.optimizations.reason('plugins.yanfly.slippery-tiles'),
    /refused: slippery region/);
});

test('composed regionId can make an unchanged isSlippery query true', () => {
  const context = makeHost({ slipRegion: 10 });
  const map = new context.Game_Map();
  assert.equal(map.isSlippery(5, 5), false);
  context.Game_Map.prototype.regionId = function() { return 10; };
  assert.equal(map.isSlippery(5, 5), true);
});

test('Tiled map with region 10 falls through to original query', () => {
  const regions = [new Array(100).fill(0)];
  regions[0][5] = 10;
  const context = makeHost({
    regions,
    tilesetSlip: [],
    slipRegion: 10,
    isTiled: true
  });
  const map = new context.Game_Map();

  assert.equal(map.isSlippery(5, 0), true);
  assert.equal(context.calls.regionId, 1);
});

test('tileset with slippery terrain tags falls through to original query', () => {
  const context = makeHost({
    regions: [new Array(100).fill(0)],
    tilesetSlip: [3],
    slipRegion: 10
  });
  const map = new context.Game_Map();

  assert.equal(map.isSlippery(5, 0), false);
  assert.equal(context.calls.isValid, 1);
  assert.equal(context.calls.terrainTag, 1);
});

test('stock MV region data remains visible to the guest query', () => {
  const layerSize = 100; // 10x10
  const data = new Array(layerSize * 6).fill(0); // layer 5 is all 0
  const context = makeHost({
    isTiled: false,
    stockMap: { data },
    tilesetSlip: [],
    slipRegion: 10
  });
  const map = new context.Game_Map();

  assert.equal(map.isSlippery(5, 5), false);
  assert.equal(context.calls.isValid, 1);
});

test('stock MV map with region 10 falls through to original query', () => {
  const layerSize = 100;
  const data = new Array(layerSize * 6).fill(0);
  data[layerSize * 5 + 7] = 10; // region 10 at index 7
  const context = makeHost({
    isTiled: false,
    stockMap: { data },
    tilesetSlip: [],
    slipRegion: 10
  });
  const map = new context.Game_Map();

  assert.equal(map.isSlippery(7, 0), false); // isValid + terrainTag executed
  assert.equal(context.calls.isValid, 1);
});

test('per-level switching on Tiled maps', () => {
  const level0 = new Array(50).fill(0);
  const level1 = new Array(50).fill(0);
  level1[2] = 10;
  const context = makeHost({
    regions: [level0, level1],
    tilesetSlip: [],
    slipRegion: 10,
    isTiled: true
  });
  const map = new context.Game_Map();

  map.currentMapLevel = 0;
  assert.equal(map.isSlippery(2, 0), false);
  assert.equal(context.calls.isValid, 1);

  map.currentMapLevel = 1;
  assert.equal(map.isSlippery(2, 0), true);
  assert.equal(context.calls.isValid, 2);
});

test('zero slippery region and empty known tag list can skip the guest query', () => {
  const context = makeHost({ slipRegion: 0 });
  const map = new context.Game_Map();

  assert.equal(map.isSlippery(5, 5), false);
  assert.equal(context.calls.isValid, 0);
  context.Yanfly.Param.SlipRegion = 10;
  map._regions[0][5] = 10;
  assert.equal(map.isSlippery(5, 5), true);
});

test('tileset changes are observed without a cache or lifecycle hook', () => {
  const context = makeHost({
    regions: [new Array(100).fill(0)],
    tilesetSlip: [],
    slipRegion: 0
  });
  const map = new context.Game_Map();

  assert.equal(map.isSlippery(5, 5), false);
  assert.equal(context.calls.isValid, 0);

  // Dynamically change tileset to one with slippery tag 3
  const newSlip = new context.Array(3);
  map._tileset = {
    slippery: newSlip
  };
  map.changeTileset(2);

  assert.equal(context.calls.changeTileset, 1);

  // Next query must now fall through to original query because tileset has slippery tags
  assert.equal(map.isSlippery(5, 5), false);
  assert.equal(context.calls.isValid, 1); // Validates that reference check ran
  assert.equal(context.calls.terrainTag, 1);
});

test('disabled via disableOptimizations config falls back to stock', () => {
  const context = makeHost({
    disableOptimizations: ['plugins.yanfly.slippery-tiles']
  });
  assert.equal(context.PMJS.optimizations.isEnabled('plugins.yanfly.slippery-tiles'), false);
  const map = new context.Game_Map();
  assert.equal(map.isSlippery(5, 5), false);
  assert.equal(context.calls.isValid, 1); // Ran stock query
});

test('disabled via PMJS_DISABLE_OPT falls back to stock', () => {
  const context = makeHost({
    env: { PMJS_DISABLE_OPT: 'plugins.yanfly.slippery-tiles' }
  });
  assert.equal(context.PMJS.optimizations.isEnabled('plugins.yanfly.slippery-tiles'), false);
  const map = new context.Game_Map();
  assert.equal(map.isSlippery(5, 5), false);
  assert.equal(context.calls.isValid, 1); // Ran stock query
});
