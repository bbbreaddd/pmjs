'use strict';

const { pinSourceFingerprint } = require('./helpers/reviewed-function-fixture.cjs');
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
  const allowed = this.isValid(mx, my);
  const region = this.regionId(mx, my);
  const terrain = this.terrainTag(mx, my);
  const membership = this.tileset().slippery.contains(terrain);
  return allowed && !$gameParty.inBattle() &&
    (membership || (region !== 0 && region === Yanfly.Param.SlipRegion));
}`;
const INLINE_QUERY_SHAPE = `function(mx, my) {
  if ($gameParty.inBattle()) return false;
  if (this.isValid(mx, my) && this.tileset()) {
    if (Yanfly.Param.SlipRegion !== 0 && this.regionId(mx, my) === Yanfly.Param.SlipRegion) return true;
    var tag = this.terrainTag(mx, my);
    return this.tileset().slippery.contains(tag);
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
  inlineTerrain = false,
} = {}) {
  const calls = { regionId: 0, terrainTag: 0, isValid: 0, changeTileset: 0 };
  const context = {
    __pmjsBuiltinRequire: require,
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

  let source = pinSourceFingerprint(pinSourceFingerprint(moduleSource, 'KNOWN_CONTAINS',
    context.Array.prototype.contains), 'KNOWN_SLIPPERY_QUERY',
    vm.runInNewContext('(' + SLIPPERY_QUERY_SHAPE + ')'));
  if (inlineTerrain) {
    vm.runInContext(`
      Game_Map.prototype.isSlippery = (${INLINE_QUERY_SHAPE});
      Game_Map.prototype.tileId = function(x, y, z) { return this.tiles[z]; };
      Game_Map.prototype.layeredTiles = function(x, y) {
        var tiles = [];
        for (var i = 0; i < 4; i++) tiles.push(this.tileId(x, y, 3 - i));
        return tiles;
      };
      Game_Map.prototype.tilesetFlags = function() { return this.flags; };
      Game_Map.prototype.terrainTag = function(x, y) {
        if (this.isValid(x, y)) {
          var flags = this.tilesetFlags(), tiles = this.layeredTiles(x, y);
          for (var i = 0; i < tiles.length; i++) {
            var tag = flags[tiles[i]] >> 12;
            if (tag > 0) return tag;
          }
        }
        return 0;
      };
    `, context);
    for (const [key, method] of [['KNOWN_SLIPPERY_QUERY', 'isSlippery'],
      ['KNOWN_TERRAIN_TAG', 'terrainTag'], ['KNOWN_LAYERED_TILES', 'layeredTiles'], ['KNOWN_TILE_ID', 'tileId']]) {
      source = pinSourceFingerprint(source, key, context.Game_Map.prototype[method]);
    }
  }
  context.referenceSlipperyQuery = context.Game_Map.prototype.isSlippery;
  vm.runInContext(source, context, { filename: 'slippery-tiles.js' });
  if (autoActivate) {
    context.PMJS.plugins.execute('YEP_SlipperyTiles', function() {});
    context.PMJS.phases.emit('afterGuestPlugins');
  }
  return context;
}

test('live terrain specialization preserves eager tile reads and observes mutations', () => {
  const c = makeHost({ inlineTerrain: true });
  const map = new c.Game_Map();
  map.tiles = [0, 1, 2, 3]; map.flags = [0, 2 << 12, 0, 3 << 12];
  map._tileset.slippery.push(3);
  assert.equal(c.Game_Map.prototype.__pmjsSlipperyTilesGuard, true);
  const reads = [];
  Object.defineProperty(map.tiles, 3, { get() { reads.push('tile3'); return 3; }, configurable: true });
  Object.defineProperty(map.tiles, 0, { get() { reads.push('tile0'); return 0; }, configurable: true });
  Object.defineProperty(map.flags, 3, { get() { reads.push('flag3'); return 3 << 12; }, configurable: true });
  assert.equal(map.isSlippery(5, 0), true);
  assert.deepEqual(reads, ['tile3', 'tile0', 'flag3']);
  map._tileset.slippery.length = 0;
  assert.equal(map.isSlippery(5, 0), false);
  map._regions[0][5] = 10;
  assert.equal(map.isSlippery(5, 0), true);
  map._regions = [new Array(100).fill(0), new Array(100).fill(10)];
  map.currentMapLevel = 0;
  assert.equal(map.isSlippery(5, 0), false);
  map.currentMapLevel = 1;
  assert.equal(map.isSlippery(5, 0), true);
  map.regionId = () => 0;
  assert.equal(map.isSlippery(5, 0), false);
  map.terrainTag = () => 7;
  map._tileset.slippery.push(7);
  assert.equal(map.isSlippery(5, 0), true);
});

test('customized terrain dependencies and array methods retain guest behavior', () => {
  const c = makeHost({ inlineTerrain: true });
  const map = new c.Game_Map();
  map.tiles = [0, 1, 2, 3]; map.flags = [0, 2 << 12, 0, 3 << 12];
  map._tileset.slippery.push(2);
  map.layeredTiles = () => [1];
  assert.equal(map.isSlippery(5, 0), true);
  delete map.layeredTiles;
  map.tileId = () => 1;
  assert.equal(map.isSlippery(5, 0), true);
  delete map.tileId;
  vm.runInContext('Array.prototype.push = function() { this[this.length] = 1; return this.length; };', c);
  assert.equal(map.isSlippery(5, 0), true);
  c.Yanfly.Param.SlipRegion = 0;
  assert.equal(map.isSlippery(5, 0), true);
  c.$gameParty.inBattle = () => true;
  assert.equal(map.isSlippery(5, 0), false);
});

test('terrain specialization matches the reference query for tile precedence and live flags', () => {
  const c = makeHost({ inlineTerrain: true });
  const map = new c.Game_Map();
  map.tiles = [0, 1, 2, 3];
  for (const flags of [[0, 0, 0, 0], [1, 0, 0, 0], [1, 2, 0, 0], [1, 2, 3, 4], [-1, 0, 0, -2]]) {
    map.flags = flags.map(tag => tag << 12);
    for (const tag of [0, 1, 2, 3, 4]) {
      map._tileset.slippery.length = 0;
      map._tileset.slippery.push(tag);
      assert.equal(map.isSlippery(5, 0), c.referenceSlipperyQuery.call(map, 5, 0));
    }
  }
  map.isValid = () => false;
  assert.equal(map.isSlippery(5, 0), c.referenceSlipperyQuery.call(map, 5, 0));
  map.isValid = () => true;
  map._tileset = null;
  assert.equal(map.isSlippery(5, 0), c.referenceSlipperyQuery.call(map, 5, 0));
});

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

// Optional private inputs: an MV engine directory containing js/rpg_*.js,
// js/plugins.js and js/plugins/YEP_SlipperyTiles.js. No guest source is rewritten.
const referenceGame = process.env.PMJS_MV_REFERENCE_GAME;
test('MV 1.6.1 and YEP Slippery Tiles 1.05 production recognition',
  { skip: !referenceGame && 'set PMJS_MV_REFERENCE_GAME to run private integration' }, async t => {
    const { loadPmjsRuntime, runModule } = require('./helpers/runtime-context.cjs');
    function integration({ region, unsupported = false, disabled = false } = {}) {
      // Only top-level browser/Pixi declarations are stubbed. Query, membership,
      // map accessors, parameter loading and tileset notetags execute guest code.
      function PixiDeclaration() {}
      const context = loadPmjsRuntime({ __pmjsBuiltinRequire: require, console, performance,
        PMJS_GAME_CONFIG: { disableOptimizations: disabled ? ['plugins.yanfly.slippery-tiles'] : [] },
        document: { fonts: {} }, window: {}, navigator: { userAgent: '' }, location: { search: '' },
        PIXI: { glCore: { VertexArrayObject: {} }, settings: {}, GC_MODES: { AUTO: 0 },
          SCALE_MODES: { NEAREST: 0 }, Point: PixiDeclaration, Rectangle: PixiDeclaration,
          Container: PixiDeclaration, Sprite: PixiDeclaration, Filter: PixiDeclaration,
          Texture: PixiDeclaration, extras: { PictureTilingSprite: PixiDeclaration, TilingSprite: PixiDeclaration },
          filters: { ColorMatrixFilter: PixiDeclaration, VoidFilter: PixiDeclaration },
          tilemap: { TileRenderer: {}, ZLayer: PixiDeclaration, CompositeRectTileLayer: PixiDeclaration } }
      });
      function guest(relative) {
        const file = path.join(referenceGame, relative);
        vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: relative });
      }
      for (const file of ['rpg_core', 'rpg_managers', 'rpg_objects']) guest('js/' + file + '.js');
      assert.equal(context.Utils.RPGMAKER_VERSION, '1.6.1');
      guest('js/plugins.js');
      const plugin = context.$plugins.find(entry => entry.name === 'YEP_SlipperyTiles');
      assert.ok(plugin && plugin.status, 'reference manifest must enable Slippery Tiles');
      const parameters = { ...plugin.parameters };
      if (region !== undefined) parameters['Slippery Region'] = String(region);
      context.PluginManager.setParameters(plugin.name, parameters);
      runModule(context, 'js/pmjs-plugins/yanfly/slippery-tiles.js');
      context.PMJS.plugins.snapshotEffectiveManifest([plugin]);
      context.PMJS.plugins.execute(plugin.name, () => guest('js/plugins/YEP_SlipperyTiles.js'));
      assert.equal(context.Yanfly.Slip.version, 1.05);
      if (unsupported) vm.runInContext('Game_Map.prototype.isSlippery = function() { return "custom"; };', context);
      const original = context.Game_Map.prototype.isSlippery;
      context.PMJS.plugins.finish();
      context.PMJS.phases.emit('afterGuestPlugins');
      vm.runInContext(`
        $dataTilesets = [null, { note: '', flags: [0] }];
        DataManager.processSlipNotetags($dataTilesets);
        $dataMap = { width: 2, height: 2, scrollType: 0, data: new Array(24).fill(0) };
        $gameParty = new Game_Party();
        $gameMap = Object.create(Game_Map.prototype);
        $gameMap._tilesetId = 1;
      `, context);
      return { context, original, map: context.$gameMap };
    }

    await t.test('reviewed sources activate unchanged and preserve results through live invalidation', () => {
      const fast = integration({ region: 0 }), ordinary = integration({ region: 0, disabled: true });
      const { context: c, map } = fast;
      assert.equal(c.PMJS.optimizations.reason('plugins.yanfly.slippery-tiles'), 'enabled');
      assert.notEqual(c.Game_Map.prototype.isSlippery, fast.original);
      assert.equal(ordinary.context.Game_Map.prototype.isSlippery, ordinary.original);
      // A read trap proves the eligible path skipped the query rather than
      // merely returning the same false result through a silent fallback.
      const isValid = map.isValid;
      map.isValid = () => { throw new Error('guest query reached'); };
      assert.equal(map.isSlippery(0, 0), false);
      map.isValid = isValid;
      for (const f of [fast, ordinary]) {
        assert.equal(f.map.isSlippery(0, 0), false);
        vm.runInContext(`$dataTilesets[1].note = '<Slippery: 3>';
          DataManager.processSlipNotetags($dataTilesets);
          $dataTilesets[1].flags[0] = 3 << 12;`, f.context);
        assert.equal(f.map.isSlippery(0, 0), true, 'terrain tags must use the original query');
        f.context.Yanfly.Param.SlipRegion = 10;
        vm.runInContext(`$dataTilesets[1].note = '';
          DataManager.processSlipNotetags($dataTilesets);
          $dataMap.data[20] = 10;`, f.context);
        assert.equal(f.map.isSlippery(0, 0), true, 'region mutation must use the original query');
        f.context.$gameParty._inBattle = true;
        assert.equal(f.map.isSlippery(0, 0), false);
        vm.runInContext(`$gameParty._inBattle = false;
          Yanfly.Param.SlipRegion = 0;
          Array.prototype.indexOf = function() { return 0; };`, f.context);
        assert.equal(f.map.isSlippery(0, 0), true, 'changed membership must use the original query');
      }
    });

    await t.test('authored region 10 activates the live query without caching region answers', () => {
      const { context: c, map, original } = integration();
      assert.equal(c.Yanfly.Param.SlipRegion, 10);
      assert.notEqual(c.Game_Map.prototype.isSlippery, original);
      assert.equal(c.PMJS.optimizations.reason('plugins.yanfly.slippery-tiles'), 'enabled');
      assert.equal(map.isSlippery(0, 0), false);
      vm.runInContext('$dataMap.data[20] = 10;', c);
      assert.equal(map.isSlippery(0, 0), true);
    });

    await t.test('an unsupported effective query is refused without replacing it', () => {
      const { context: c, map, original } = integration({ region: 0, unsupported: true });
      assert.equal(c.Game_Map.prototype.isSlippery, original);
      assert.match(c.PMJS.optimizations.reason('plugins.yanfly.slippery-tiles'), /unrecognized Yanfly isSlippery/);
      assert.equal(map.isSlippery(0, 0), 'custom');
    });
  });
