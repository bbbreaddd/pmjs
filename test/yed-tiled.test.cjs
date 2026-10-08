'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const crypto = require('node:crypto');
const runtime = path.resolve(__dirname, '..');
const adapter = fs.readFileSync(path.join(runtime, 'js/pmjs-plugins/yed/tiled.js'), 'utf8');
const methodNames = [...adapter.matchAll(/^    ([\w]+): '[a-f0-9]{64}'/gm)].map(match => match[1]);

test('native preparation accepts retained work once and preserves guest fallback', () => {
  function Tilemap() {}
  const context = vm.createContext({ Tilemap, nativeTileRebuilds: 0 });
  vm.runInContext(fs.readFileSync(path.join(runtime, 'js/pmjs-mv/render-prepare.js'), 'utf8'), context);
  const node = new Tilemap();
  const calls = [];
  Object.assign(node, {
    origin: { x: 3, y: 2 }, _margin: 0, _tileWidth: 16, _tileHeight: 16,
    _needsRepaint: true,
    _pmjsPrepareTiles() { calls.push('retained'); return true; },
    _updateLayerPositions() { calls.push('position'); },
    _paintAllTiles() { calls.push('paint'); },
    _sortChildren() { calls.push('sort'); }
  });
  context.prepareNativeMvSceneNode(node);
  assert.deepEqual(calls, ['retained']);
  assert.equal(context.nativeTileRebuilds, 0);
  node._pmjsPrepareTiles = () => false;
  context.prepareNativeMvSceneNode(node);
  assert.deepEqual(calls, ['retained', 'position', 'paint', 'sort']);
  assert.equal(context.nativeTileRebuilds, 1);
});

function fixture(options = {}) {
  function Guest() { this.calls = []; this.origin = { x: 2, y: 3 }; this._tileWidth = this._tileHeight = 16; }
  Guest.prototype = Object.fromEntries(methodNames.map(name => [name,
    new Function('this.calls.push(' + JSON.stringify(name) + ');')]));
  Guest.prototype.constructor = Guest;
  const original = { ...Guest.prototype };
  Object.setPrototypeOf(Guest.prototype, { updateTransform: original.updateTransform });
  delete Guest.prototype.updateTransform;
  let source = adapter;
  for (const name of methodNames) {
    const digest = crypto.createHash('sha256').update(Function.prototype.toString.call(original[name])
      .replace(/^function(?:\s+[\w$]+)?\s*\(/, 'function(')).digest('hex');
    source = source.replace(new RegExp('(' + name + ": ')[a-f0-9]{64}"), '$1' + digest);
  }
  if (options.unknown) Guest.prototype[options.unknown] = function() { this.calls.push('unknown'); };
  const operations = [];
  const context = { console, __pmjsBuiltinRequire: require, TiledTilemap: Guest,
    Spriteset_Map: function() {}, PIXI: { Container: { prototype: {
      updateTransform() { this.calls.push('container'); }
    } } }, PMJS: { maps: {}, yedRetainedTiles: {
      supported(map) { return map.supported !== false; },
      prepare(map, x, y) { operations.push(['prepare', x, y]); return options.fail !== 'prepare'; },
      paint(map, x, y) { operations.push(['paint', x, y]); return options.fail !== 'paint'; },
      updatePositions(map, x, y) { operations.push(['positions', x, y]); return true; },
      updateAnimation() { operations.push(['animation']); return true; },
      flushAnimation() { operations.push(['flush']); return true; },
      invalidate() { operations.push(['invalidate']); }
    } } };
  context.Spriteset_Map.prototype.loadTileset = function() {
    this.contractBeforeLoad = context.PMJS.maps.tiledContract && context.PMJS.maps.tiledContract();
    this.loaded = true;
  };
  if (options.privateConstructor) delete context.TiledTilemap;
  context.PMJS_GAME_CONFIG = { disableOptimizations: options.disabled || [] };
  vm.createContext(context);
  for (const file of ['pmjs-core/config','pmjs-core/optimizations','pmjs-rpgmaker/lifecycle','pmjs-core/methods','pmjs-rpgmaker/plugins']) {
    vm.runInContext(fs.readFileSync(path.join(runtime,'js',file+'.js'),'utf8'),context);
  }

  vm.runInContext(source, context);
  context.PMJS.plugins.execute('YED_Tiled', function() {});
  context.PMJS.phases.emit('afterGuestPlugins');
  return { context, Guest, original, operations };
}

const painting = 'tilemap.yed-indexed-paint-loops';
const animation = 'tilemap.yed-indexed-animation';

test('reviewed guest producers remain unchanged while retained entry points activate', () => {
  const { Guest, original, operations } = fixture();
  for (const name of ['_paintTile','_paintPriorityTile','_paintTilesLayer','_paintObjectLayers']) {
    assert.equal(Guest.prototype[name], original[name]);
  }
  const map = new Guest();
  map._paintAllTiles(4, 5);
  map._updateAnim();
  map.updateTransform();
  assert.deepEqual(operations, [['paint',4,5],['animation'],['prepare',0,0]]);
  assert.deepEqual(map.calls, ['_sortChildren','container']);
});

test('disabled painting leaves guest rendering methods untouched and refuses dependent animation', () => {
  const { context, Guest, original } = fixture({ disabled: [painting] });
  for (const name of methodNames) assert.equal(Guest.prototype[name], original[name]);
  assert.equal(context.PMJS.optimizations.reason(animation), 'refused: requires '+painting);
});

test('disabled animation preserves guest refresh producer while retaining painting', () => {
  const { Guest, original } = fixture({ disabled: [animation] });
  assert.equal(Guest.prototype._updateAnim, original._updateAnim);
  assert.notEqual(Guest.prototype._paintAllTiles, original._paintAllTiles);
  assert.equal(Guest.prototype._pmjsIndexedAnimation, false);
});

test('unknown method composition refuses both paths', () => {
  const { context, Guest, original } = fixture({ unknown: '_getAnimTileId' });
  assert.equal(Guest.prototype._paintAllTiles, original._paintAllTiles);
  assert.match(context.PMJS.optimizations.reason(painting), /^refused:/);
  assert.match(context.PMJS.optimizations.reason(animation), /^refused:/);
});

test('instance override permanently restores guest behavior and invalidates retained state once', () => {
  const { Guest, operations } = fixture();
  const map = new Guest();
  map._getPriority = function() { return 9; };
  map._paintAllTiles(0,0);
  map._paintAllTiles(0,0);
  assert.deepEqual(map.calls, ['_paintAllTiles','_paintAllTiles']);
  assert.deepEqual(operations, [['invalidate']]);
  assert.equal(map._pmjsIndexedAnimation, false);
  assert.equal(map._needsRepaint, true);
});

test('unsupported instance falls back without invoking retained producer', () => {
  const { Guest, operations } = fixture();
  const map = new Guest(); map.supported = false;
  map.updateTransform();
  assert.deepEqual(map.calls, ['updateTransform']);
  assert.deepEqual(operations, [['invalidate']]);
});

test('late prototype replacement invalidates the public map contract', () => {
  const { context, Guest } = fixture();
  assert.equal(context.PMJS.maps.tiledContract(), true);
  Guest.prototype._paintTile = function() {};
  assert.equal(context.PMJS.maps.tiledContract(), 'tiled-producer-changed');
});

test('map contract rejects unsupported geometry and flip encodings', () => {
  const { context } = fixture();
  const contract = context.PMJS.maps.tiledContract;
  assert.equal(contract({ layers:[],tilesets:[],orientation:'orthogonal' }),true);
  assert.equal(contract({ layers:[],tilesets:[],infinite:true }),'unreviewed-tiled-layer-geometry');
  assert.equal(contract({ layers:[],tilesets:[{ spacing:1 }] }),'unreviewed-tiled-tileset-geometry');
  assert.equal(contract({ layers:[{ data:[0x80000001] }],tilesets:[] }),'unreviewed-tiled-flips');
});

test('failed retained preparation returns to guest transform and invalidates once', () => {
  const { Guest, operations } = fixture({ fail: 'prepare' });
  const map = new Guest();
  map.updateTransform(); map.updateTransform();
  assert.deepEqual(map.calls, ['updateTransform', 'updateTransform']);
  assert.deepEqual(operations, [['prepare', 0, 0], ['invalidate']]);
});

test('failed retained painting invokes the guest producer', () => {
  const { Guest, operations } = fixture({ fail: 'paint' });
  const map = new Guest(); map._paintAllTiles(3, 4);
  assert.deepEqual(map.calls, ['_paintAllTiles']);
  assert.deepEqual(operations, [['paint', 3, 4], ['invalidate']]);
});

test('late instance transform overrides remain effective', () => {
  const { Guest, operations } = fixture();
  const map = new Guest();
  map.updateTransform = function() { this.calls.push('custom-transform'); };
  map.updateTransform(); map._paintAllTiles(0, 0);
  assert.deepEqual(map.calls, ['custom-transform', '_paintAllTiles']);
  assert.deepEqual(operations, [['invalidate']]);
});

test('private reached constructor qualifies before guest resource loading', () => {
  const { context, Guest, original } = fixture({ privateConstructor: true });
  context.$gameMap = { isTiledMap() { return true; } };
  context.PMJS.methods.install();
  const spriteset = new context.Spriteset_Map();
  spriteset._tilemap = new Guest();
  spriteset.loadTileset();
  assert.equal(spriteset.contractBeforeLoad, true);
  assert.equal(spriteset.loaded, true);
  assert.notEqual(Guest.prototype._paintAllTiles, original._paintAllTiles);
});

test('native preparation hook returns false for unsupported instance', () => {
  const { Guest, operations } = fixture();
  const map = new Guest(); map.supported = false;
  assert.equal(map._pmjsPrepareTiles(), false);
  assert.deepEqual(operations, [['invalidate']]);
  assert.deepEqual(map.calls, []);
});
