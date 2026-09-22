'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const runtimeRoot = path.resolve(__dirname, '..');
const registrySources = {
  config: 'js/pmjs-core/config.js',
  optimizations: 'js/pmjs-core/optimizations.js',
  lifecycle: 'js/pmjs-rpgmaker/lifecycle.js',
  methods: 'js/pmjs-core/methods.js',
  plugins: 'js/pmjs-rpgmaker/plugins.js',
};

function loadRegistrySupport(context) {
  for (const [name, file] of Object.entries(registrySources)) {
    vm.runInContext(fs.readFileSync(path.join(runtimeRoot, file), 'utf8'),
      context, { filename: file });
  }
}

const source = fs.readFileSync(path.join(runtimeRoot,
  'js/pmjs-plugins/yed/tiled.js'), 'utf8');

function loadAssignedFunction(assignment, nextAssignment, context) {
  const start = source.indexOf(assignment);
  const end = source.indexOf(nextAssignment, start);
  if (start < 0 || end < 0) throw new Error(`${assignment} was not found`);
  const property = assignment.slice(assignment.indexOf('.') + 1,
    assignment.indexOf(' ='));
  vm.runInNewContext('var tiledProto = {};\n' + source.slice(start, end) +
    `\nthis.loaded = tiledProto.${property};`, context,
    { filename: 'js/pmjs-plugins/yed/tiled.js' });
  return context.loaded;
}

// Faithful YED method shapes: every strong fingerprint token the shipped
// YED_Tiled plugin carries.
function faithfulPaintAllTiles(startX, startY) {
  this._priorityTilesCount = 0;
  for (const layer of this._layers[Symbol.iterator]()) {
    layer.clear();
    this._paintTiles(layer, startX, startY);
  }
  for (const layerData of this.tiledData.layers) {
    if (layerData.type === 'objectgroup') {
      this._paintObjectLayers(0, startX, startY);
    }
  }
  while (this._priorityTilesCount < this._priorityTiles.length) {
    const sprite = this._priorityTiles[this._priorityTilesCount];
    sprite.hide();
    sprite.layerId = -1;
    this._priorityTilesCount++;
  }
}

function faithfulUpdateLayerPositions(startX, startY) {
  let ox = this.origin.x;
  if (this.roundPixels) {
    ox = Math.floor(this.origin.x);
  }
  for (const layer of this._layers[Symbol.iterator]()) {
    layer.position.x = startX * this._tileWidth - ox;
  }
  for (const sprite of this._priorityTiles[Symbol.iterator]()) {
    sprite.x = sprite.origX + startX * this._tileWidth - ox + sprite.width / 2;
    sprite.y = sprite.origY + startY * this._tileHeight + sprite.height;
  }
}

function faithfulPaintObjectLayers(layerId, startX, startY) {
  const layerData = this.tiledData.layers[layerId];
  const objects = layerData.objects || [];
  for (const object of objects) {
    if (!object.gid || !object.visible) continue;
    const textureId = this._getTextureId(object.gid);
    this._paintPriorityTile(layerId, textureId, object.gid,
      startX, startY, object.x, object.y);
  }
}

function faithfulPaintTilesLayer(layer, startX, startY) {
  const tileCols = Math.ceil(this._width / this._tileWidth) + 1;
  const tileRows = Math.ceil(this._height / this._tileHeight) + 1;
  for (let y = 0; y < tileRows; y++) {
    for (let x = 0; x < tileCols; x++) {
      this._paintTile(layer, startX, startY, x, y);
    }
  }
}

function installInContext(configure) {
  const context = {
    console,
    comparePmjsTilemapChildren: () => 0
  };
  context.globalThis = context;
  vm.createContext(context);
  loadRegistrySupport(context);
  vm.runInContext(source, context, { filename: 'js/pmjs-plugins/yed/tiled.js' });
  configure(context);
  const installed = context.pmjsInstallYedTiledFastPaths();
  return { context, installed };
}

test('YED layer positioning visits only the PMJS active priority prefix', () => {
  const updateLayerPositions = loadAssignedFunction(
    'tiledProto._updateLayerPositions = function',
    'tiledProto._paintTilesLayer = function', { Math, Number });
  const priorityTiles = Array.from({ length: 4 }, (_, index) => ({
    layerId: index, origX: index * 10, origY: index * 20,
    width: 8, height: 12, x: -1, y: -1
  }));
  const tilemap = {
    roundPixels: true,
    origin: { x: 3.75, y: 4.25 },
    _tileWidth: 48,
    _tileHeight: 48,
    _layers: [{ layerId: 4, position: {} }],
    _priorityTiles: priorityTiles,
    _pmjsActivePriorityTileCount: 2,
    tiledData: { layers: [
      { offsetx: 1, offsety: 2 },
      { offsetx: 3, offsety: 4 },
      {}, {}, { offsetx: 5, offsety: 6 }
    ] }
  };

  updateLayerPositions.call(tilemap, 2, 1);

  assert.deepEqual(tilemap._layers[0].position, { x: 98, y: 50 });
  assert.deepEqual([priorityTiles[0].x, priorityTiles[0].y], [98, 58]);
  assert.deepEqual([priorityTiles[1].x, priorityTiles[1].y], [110, 80]);
  assert.deepEqual([priorityTiles[2].x, priorityTiles[2].y], [-1, -1]);
  assert.deepEqual([priorityTiles[3].x, priorityTiles[3].y], [-1, -1]);
});

test('YED repaint preserves active priority count and reapplies level hiding', () => {
  const context = { globalThis: null, $gameMap: { currentMapLevel: 3 } };
  context.globalThis = context;
  const paintAllTiles = loadAssignedFunction(
    'tiledProto._paintAllTiles = function',
    'tiledProto._updateLayerPositions._pmjsYedGuard', context);
  const priorityTiles = Array.from({ length: 4 }, () => ({
    hidden: false,
    hide() { this.hidden = true; }
  }));
  const hideCalls = [];
  const tilemap = {
    _priorityTiles: priorityTiles,
    _priorityTilesCount: 4,
    _layers: [{ clear() {} }],
    tiledData: { layers: [] },
    _paintTiles() { this._priorityTilesCount = 2; },
    _paintObjectLayers() {},
    hideOnLevel(level) { hideCalls.push(level); }
  };

  paintAllTiles.call(tilemap, 0, 0);

  assert.equal(tilemap._priorityTilesCount, 4);
  assert.equal(tilemap._pmjsActivePriorityTileCount, 2);
  assert.equal(tilemap._pmjsPriorityRepaintGeneration, 1);
  assert.deepEqual(priorityTiles.map(sprite => sprite.hidden),
    [false, false, true, true]);
  assert.deepEqual(hideCalls, [3]);
  assert.equal(tilemap._pmjsLastHideLevel, 3);
  assert.equal(tilemap._pmjsLastHideRepaintGeneration, 1);
});

test('YED diagnostic invariant throws when tile outside active prefix is visible in dev mode', () => {
  const context = {
    globalThis: null,
    PMJS_DEVELOPMENT_MODE: true,
    $gameMap: { currentMapLevel: 1 }
  };
  context.globalThis = context;
  const paintAllTiles = loadAssignedFunction(
    'tiledProto._paintAllTiles = function',
    'tiledProto._updateLayerPositions._pmjsYedGuard', context);
  const priorityTiles = [
    { visible: false, hide() {} },
    { visible: true, hide() {} } // Tile 1 is outside active prefix (0) and marked visible!
  ];
  const tilemap = {
    _priorityTiles: priorityTiles,
    _priorityTilesCount: 2,
    _layers: [{ clear() {} }],
    tiledData: { layers: [] },
    _paintTiles() { this._priorityTilesCount = 0; },
    _paintObjectLayers() {}
  };

  assert.throws(() => {
    paintAllTiles.call(tilemap, 0, 0);
  }, /YED priority tile visible outside PMJS active prefix/);
});

test('YED level hiding reruns only when level or repaint generation changes', () => {
  const context = {
    Spriteset_Map: function Spriteset_Map() {},
    TiledTilemap: function TiledTilemap() {},
    console,
    comparePmjsTilemapChildren: () => 0,
    $gameMap: { currentMapLevel: 1 }
  };
  context.globalThis = context;
  context.Spriteset_Map.prototype._updateHideOnLevel = function() {};
  context.TiledTilemap.prototype._paintAllTiles = faithfulPaintAllTiles;
  context.TiledTilemap.prototype._updateLayerPositions =
    faithfulUpdateLayerPositions;
  context.TiledTilemap.prototype._paintObjectLayers = faithfulPaintObjectLayers;
  context.TiledTilemap.prototype._paintTilesLayer = faithfulPaintTilesLayer;
  vm.createContext(context);
  let calls = 0;
  context.Spriteset_Map.prototype._updateHideOnLevel = function() { calls++; };
  loadRegistrySupport(context);
  vm.runInContext(source, context,
    { filename: 'js/pmjs-plugins/yed/tiled.js' });
  context.pmjsInstallYedTiledFastPaths();

  const instance = new context.Spriteset_Map();
  instance._tilemap = { _pmjsPriorityRepaintGeneration: 1 };

  instance._updateHideOnLevel();
  instance._updateHideOnLevel();
  assert.equal(calls, 1);

  context.$gameMap.currentMapLevel = 2;
  instance._updateHideOnLevel();
  assert.equal(calls, 2);

  instance._tilemap._pmjsPriorityRepaintGeneration = 2;
  instance._updateHideOnLevel();
  assert.equal(calls, 3);
});

test('YED fast paths refuse to overwrite unknown or composed implementations', () => {
  const { context, installed } = installInContext(ctx => {
    function composedPaint() {}
    function composedPositions() {}
    function composedObjects() {}
    function composedTiles() {}

    ctx.TiledTilemap = function TiledTilemap() {};
    ctx.TiledTilemap.prototype._paintAllTiles = composedPaint;
    ctx.TiledTilemap.prototype._updateLayerPositions = composedPositions;
    ctx.TiledTilemap.prototype._paintObjectLayers = composedObjects;
    ctx.TiledTilemap.prototype._paintTilesLayer = composedTiles;
    ctx.Spriteset_Map = function Spriteset_Map() {};
    ctx.Spriteset_Map.prototype._updateHideOnLevel = function() {};
    ctx.saved = {
      paint: composedPaint,
      positions: composedPositions,
      objects: composedObjects,
      tiles: composedTiles
    };
  });

  // Fast paths MUST NOT be installed when implementation is unknown/composed!
  assert.equal(installed, false);
  assert.equal(context.TiledTilemap.prototype._pmjsIndexedPaintLoops, undefined);
  assert.equal(context.TiledTilemap.prototype._paintAllTiles, context.saved.paint);
  assert.equal(context.TiledTilemap.prototype._updateLayerPositions,
    context.saved.positions);
  assert.equal(context.TiledTilemap.prototype._paintObjectLayers,
    context.saved.objects);
  assert.equal(context.TiledTilemap.prototype._paintTilesLayer,
    context.saved.tiles);
  assert.equal(context.TiledTilemap.prototype._compareChildOrder, undefined);
});

test('YED fast paths refuse modified implementations that only keep loose tokens', () => {
  // Modified fork retaining loose identifiers but not shipped behavior.
  function modifiedPaintAllTiles(startX, startY) {
    this._priorityTilesCount = 0;
    const layers = this._layers || [];
    for (const layer of layers) {
      this._paintTiles(layer, startX, startY);
    }
    if (this.tiledData && this.tiledData.layers[0].type === 'objectgroup') {
      this._paintObjectLayers(0, startX, startY);
    }
  }
  function modifiedUpdateLayerPositions(startX, startY) {
    const ox = this.roundPixels ? 1 : 0;
    const layers = this._layers || [];
    const priorityTiles = this._priorityTiles || [];
    return [ox, layers.length, priorityTiles.length, startX, startY];
  }
  function modifiedPaintObjectLayers(layerId) {
    const layerData = this.tiledData.layers[layerId];
    const objects = layerData.objects || [];
    return objects.filter(object => object.visible).length;
  }
  function modifiedPaintTilesLayer(layer, startX, startY) {
    const tileCols = Math.ceil(this._width / this._tileWidth) + 1;
    return [tileCols, layer, startX, startY];
  }

  const { context, installed } = installInContext(ctx => {
    ctx.TiledTilemap = function TiledTilemap() {};
    ctx.TiledTilemap.prototype._paintAllTiles = modifiedPaintAllTiles;
    ctx.TiledTilemap.prototype._updateLayerPositions =
      modifiedUpdateLayerPositions;
    ctx.TiledTilemap.prototype._paintObjectLayers = modifiedPaintObjectLayers;
    ctx.TiledTilemap.prototype._paintTilesLayer = modifiedPaintTilesLayer;
    ctx.Spriteset_Map = function Spriteset_Map() {};
    ctx.Spriteset_Map.prototype._updateHideOnLevel = function() {};
  });

  assert.equal(installed, false);
  assert.equal(context.TiledTilemap.prototype._pmjsIndexedPaintLoops, undefined);
  assert.equal(context.TiledTilemap.prototype._paintAllTiles, modifiedPaintAllTiles);
  assert.equal(context.TiledTilemap.prototype._updateLayerPositions,
    modifiedUpdateLayerPositions);
});

test('YED fast paths install when recognized as known YED implementation', () => {
  const { context, installed } = installInContext(ctx => {
    ctx.TiledTilemap = function TiledTilemap() {};
    ctx.TiledTilemap.prototype._paintAllTiles = faithfulPaintAllTiles;
    ctx.TiledTilemap.prototype._updateLayerPositions =
      faithfulUpdateLayerPositions;
    ctx.TiledTilemap.prototype._paintObjectLayers = faithfulPaintObjectLayers;
    ctx.TiledTilemap.prototype._paintTilesLayer = faithfulPaintTilesLayer;
    ctx.Spriteset_Map = function Spriteset_Map() {};
    ctx.Spriteset_Map.prototype._updateHideOnLevel = function() {};
  });

  assert.equal(installed, true);
  assert.equal(context.TiledTilemap.prototype._pmjsIndexedPaintLoops, true);
  assert.notEqual(context.TiledTilemap.prototype._paintAllTiles, faithfulPaintAllTiles);
  assert.notEqual(context.TiledTilemap.prototype._updateLayerPositions,
    faithfulUpdateLayerPositions);
  assert.notEqual(context.TiledTilemap.prototype._paintObjectLayers,
    faithfulPaintObjectLayers);
  assert.notEqual(context.TiledTilemap.prototype._paintTilesLayer,
    faithfulPaintTilesLayer);
});

test('YED adapter activates on its trigger plugin and ignores others', () => {
  const sandbox = {
    console,
    comparePmjsTilemapChildren: () => 0,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  const runtimeSources = {
    config: 'js/pmjs-core/config.js',
    optimizations: 'js/pmjs-core/optimizations.js',
    lifecycle: 'js/pmjs-rpgmaker/lifecycle.js',
    methods: 'js/pmjs-core/methods.js',
    plugins: 'js/pmjs-rpgmaker/plugins.js',
  };
  for (const [name, file] of Object.entries(runtimeSources)) {
    vm.runInContext(fs.readFileSync(path.join(runtimeRoot, file), 'utf8'),
      sandbox, { filename: file });
  }
  vm.runInContext(source, sandbox, { filename: 'js/pmjs-plugins/yed/tiled.js' });

  sandbox.TiledTilemap = function TiledTilemap() {};
  const paintAllTiles = sandbox.TiledTilemap.prototype._paintAllTiles =
    faithfulPaintAllTiles;

  sandbox.PMJS.plugins.execute('SomeOtherPlugin', function() {});
  assert.equal(sandbox.TiledTilemap.prototype._paintAllTiles, paintAllTiles);
  assert.equal(sandbox.TiledTilemap.prototype._pmjsIndexedPaintLoops, undefined);

  sandbox.PMJS.plugins.execute('YED_Tiled', function() {});
  assert.equal(sandbox.PMJS.plugins.dump().guest.some(entry => entry.name === 'YED_Tiled' && entry.state === 'loaded'), true);
  assert.equal(sandbox.TiledTilemap.prototype._paintAllTiles, paintAllTiles);
});

test('YED integration installs per plugin so later extensions wrap optimized behavior', () => {
  const sandbox = {
    console,
    comparePmjsTilemapChildren: () => 0,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  const runtimeSources = {
    config: 'js/pmjs-core/config.js',
    optimizations: 'js/pmjs-core/optimizations.js',
    lifecycle: 'js/pmjs-rpgmaker/lifecycle.js',
    methods: 'js/pmjs-core/methods.js',
    plugins: 'js/pmjs-rpgmaker/plugins.js',
  };
  for (const [name, file] of Object.entries(runtimeSources)) {
    vm.runInContext(fs.readFileSync(path.join(runtimeRoot, file), 'utf8'),
      sandbox, { filename: file });
  }
  vm.runInContext(source, sandbox, { filename: 'js/pmjs-plugins/yed/tiled.js' });

  sandbox.TiledTilemap = function TiledTilemap() {};
  sandbox.TiledTilemap.prototype._paintAllTiles = faithfulPaintAllTiles;
  sandbox.TiledTilemap.prototype._updateLayerPositions =
    faithfulUpdateLayerPositions;
  sandbox.TiledTilemap.prototype._paintObjectLayers = faithfulPaintObjectLayers;
  sandbox.TiledTilemap.prototype._paintTilesLayer = faithfulPaintTilesLayer;
  sandbox.Spriteset_Map = function Spriteset_Map() {};
  sandbox.Spriteset_Map.prototype._updateHideOnLevel = function() {};

  sandbox.PMJS.plugins.execute('YED_Tiled', function() {});
  assert.equal(sandbox.TiledTilemap.prototype._pmjsIndexedPaintLoops, true);

  // A later extension wraps the already-optimized repaint naturally.
  const optimized = sandbox.TiledTilemap.prototype._paintAllTiles;
  let extensionCalls = 0;
  sandbox.TiledTilemap.prototype._paintAllTiles = function extensionWrapper(
      startX, startY) {
    extensionCalls++;
    return optimized.apply(this, arguments);
  };

  const tilemap = {
    _priorityTiles: [],
    _priorityTilesCount: 0,
    _layers: [],
    tiledData: { layers: [] },
    _paintTiles() {},
    _paintObjectLayers() {}
  };
  sandbox.TiledTilemap.prototype._paintAllTiles.call(tilemap, 0, 0);
  assert.equal(extensionCalls, 1);
  assert.equal(tilemap._pmjsPriorityRepaintGeneration, 1);
});

function faithfulPaintTile(layer, startX, startY, x, y) {
  var mx = x + startX;
  var my = y + startY;
  if (this.horizontalWrap) mx = mx.mod(this._mapWidth);
  if (this.verticalWrap) my = my.mod(this._mapHeight);
  var tilePosition = mx + my * this._mapWidth;
  var tileId = this.tiledData.layers[layer.layerId].data[tilePosition];
  var rectLayer = layer.children[0];
  var textureId = 0;
  if (!tileId) return;
  if (mx < 0 || mx >= this._mapWidth || my < 0 || my >= this._mapHeight) return;
  textureId = this._getTextureId(tileId);
  var tileset = this.tiledData.tilesets[textureId];
  var dx = x * this._tileWidth;
  var dy = y * this._tileHeight;
  var w = tileset.tilewidth;
  var h = tileset.tileheight;
  var tileCols = tileset.columns;
  var rId = this._getAnimTileId(textureId, tileId - tileset.firstgid);
  var ux = (rId % tileCols) * w;
  var uy = Math.floor(rId / tileCols) * h;
  if (this._isPriorityTile(layer.layerId)) {
    this._paintPriorityTile(layer.layerId, textureId, tileId, startX, startY, dx, dy);
    return;
  }
  rectLayer.addRect(textureId, ux, uy, dx, dy, w, h);
}

function faithfulPaintPriorityTile(layerId, textureId, tileId, startX, startY, dx, dy) {
  var tileset = this.tiledData.tilesets[textureId];
  var w = tileset.tilewidth;
  var h = tileset.tileheight;
  var tileCols = tileset.columns;
  var rId = this._getAnimTileId(textureId, tileId - tileset.firstgid);
  var ux = (rId % tileCols) * w;
  var uy = Math.floor(rId / tileCols) * h;
  var sprite = this._priorityTiles[this._priorityTilesCount];
  if (this._priorityTilesCount >= this._priorityTiles.length) return;
  sprite.layerId = layerId;
  sprite.origX = dx;
  sprite.origY = dy;
  sprite.setFrame(ux, uy, w, h);
  this._priorityTilesCount += 1;
}

function faithfulUpdateAnim() {
  var needRefresh = false;
  for (var key in this._animDuration) {
    this._animDuration[key] -= 1;
    if (this._animDuration[key] <= 0) {
      this._animFrame[key] += 1;
      needRefresh = true;
    }
  }
  if (needRefresh) {
    this._updateAnimFrames();
    this.refresh();
  }
}

function faithfulShaderTilemapUpdateTransform() {
  var ox = this.roundPixels ? Math.floor(this.origin.x) : this.origin.x;
  var oy = this.roundPixels ? Math.floor(this.origin.y) : this.origin.y;
  var startX = Math.floor((ox - this._margin) / this._tileWidth);
  var startY = Math.floor((oy - this._margin) / this._tileHeight);
  this._updateLayerPositions(startX, startY);
  if (this._needsRepaint || this._lastStartX !== startX ||
      this._lastStartY !== startY) {
    this._lastStartX = startX;
    this._lastStartY = startY;
    this._paintAllTiles(startX, startY);
    this._needsRepaint = false;
  }
  this._sortChildren();
  PIXI.Container.prototype.updateTransform.call(this); // eslint-disable-line no-undef
}

function makeAnimatedTilemap({
  tileWidth = 32,
  tileHeight = 32,
  squareTiles = true,
  disableOptimizations = [],
  ownUpdateTransform = null
} = {}) {
  const context = {
    console,
    Math,
    Number,
    String,
    Object,
    Array,
    comparePmjsTilemapChildren: () => 0,
    PIXI: {
      Container: function Container() {}
    },
    PMJS_GAME_CONFIG: { disableOptimizations }
  };
  context.globalThis = context;
  context.PIXI.Container.prototype.updateTransform = function() {};

  vm.createContext(context);
  const optSrc = fs.readFileSync(
    path.join(runtimeRoot, 'js/pmjs-core/optimizations.js'), 'utf8');
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/pmjs-core/config.js'), 'utf8'), context);
  vm.runInContext(optSrc, context, { filename: 'pmjs-core/optimizations.js' });
  loadRegistrySupport(context);
  vm.runInContext(source, context, { filename: 'js/pmjs-plugins/yed/tiled.js' });

  const ShaderTilemap = function ShaderTilemap() {};
  ShaderTilemap.prototype.updateTransform = faithfulShaderTilemapUpdateTransform;
  const TiledTilemap = function TiledTilemap() {};
  TiledTilemap.prototype = Object.create(ShaderTilemap.prototype);
  TiledTilemap.prototype.constructor = TiledTilemap;
  TiledTilemap.prototype._paintAllTiles = faithfulPaintAllTiles;
  TiledTilemap.prototype._updateLayerPositions = faithfulUpdateLayerPositions;
  TiledTilemap.prototype._paintObjectLayers = faithfulPaintObjectLayers;
  TiledTilemap.prototype._paintTilesLayer = faithfulPaintTilesLayer;
  TiledTilemap.prototype._paintTile = faithfulPaintTile;
  TiledTilemap.prototype._paintPriorityTile = faithfulPaintPriorityTile;
  TiledTilemap.prototype._updateAnim = faithfulUpdateAnim;
  if (ownUpdateTransform) {
    TiledTilemap.prototype.updateTransform = ownUpdateTransform;
  }

  context.TiledTilemap = TiledTilemap;
  context.Spriteset_Map = function Spriteset_Map() {};
  context.Spriteset_Map.prototype._updateHideOnLevel = function() {};

  context.pmjsInstallYedTiledFastPaths(TiledTilemap);

  const rectLayer = {
    pointsBuf: [],
    modificationMarker: 0,
    _pmjsNativeGeneration: 0,
    addRect(texId, u, v, x, y, w, h) {
      this.pointsBuf.push(u, v, x, y, w, h, 0, 0, texId);
    },
    clear() {
      this.pointsBuf.length = 0;
      this.modificationMarker = 0;
    }
  };
  const compositeLayer = {
    layerId: 0,
    position: { x: 0, y: 0 },
    children: [rectLayer],
    modificationMarker: 0,
    clear() {
      rectLayer.clear();
      this.modificationMarker = 0;
    }
  };
  rectLayer.parent = compositeLayer;

  const prioritySprites = Array.from({ length: 4 }, () => ({
    layerId: -1,
    x: 0,
    y: 0,
    origX: 0,
    origY: 0,
    width: 32,
    height: 32,
    anchor: { x: 0, y: 0 },
    _frame: { x: 0, y: 0, width: 32, height: 32 },
    setFrame(x, y, w, h) {
      this._frame.x = x;
      this._frame.y = y;
      this._frame.width = w;
      this._frame.height = h;
    },
    show() { this.visible = true; },
    hide() { this.visible = false; }
  }));

  const tileW = squareTiles ? 32 : 64;
  const tileH = 32;

  const tilemap = Object.assign(new TiledTilemap(), {
    _width: 64,
    _height: 32,
    _tileWidth: 32,
    _tileHeight: 32,
    _mapWidth: 2,
    _mapHeight: 1,
    origin: { x: 0, y: 0 },
    roundPixels: true,
    _layers: [compositeLayer],
    _priorityTiles: prioritySprites,
    _priorityTilesCount: 0,
    bitmaps: [{ _baseTexture: {} }],
    _lastBitmapLength: 1,
    _animFrame: { '0': 0, '1': 0 },
    _animDuration: { '0': 1, '1': 2 },
    tiledData: {
      layers: [
        {
          type: 'tilelayer',
          data: [1, 2] // tileId 1 (local 0, animated), tileId 2 (local 1, animated)
        },
        {
          type: 'objectgroup',
          objects: [
            { gid: 1, x: 0, y: 32, height: 32, visible: true }
          ]
        }
      ],
      tilesets: [
        {
          firstgid: 1,
          columns: 4,
          tilewidth: tileW,
          tileheight: tileH,
          tiles: {
            '0': {
              animation: [
                { tileid: 0, duration: 1 },
                { tileid: 1, duration: 1 }
              ]
            },
            '1': {
              animation: [
                { tileid: 1, duration: 2 },
                { tileid: 2, duration: 2 }
              ]
            }
          }
        }
      ]
    },
    _getTextureId() { return 0; },
    _getAnimTileId(texId, localId) {
      const frame = this._animFrame[String(localId)] || 0;
      const anim = this.tiledData.tilesets[texId].tiles[String(localId)].animation;
      return anim[frame] ? anim[frame].tileid : localId;
    },
    _isPriorityTile() { return false; },
    _getPriority() { return 0; },
    _getZIndex() { return 0; },
    _paintTiles(layer, sx, sy) {
      this._paintTilesLayer(layer, sx, sy);
    },
    _updateAnimFrames() {
      for (const k in this._animFrame) {
        if (this._animDuration[k] <= 0) {
          this._animDuration[k] = 2; // reset timer
        }
      }
    },
    refreshCalls: 0,
    refresh() {
      this.refreshCalls++;
      this._needsRepaint = true;
    }
  });

  return { context, TiledTilemap, tilemap, rectLayer, compositeLayer, prioritySprites };
}

test('YED indexed animation fast path installs when recognized', () => {
  const { TiledTilemap } = makeAnimatedTilemap();
  assert.equal(TiledTilemap.prototype._pmjsIndexedAnimation, true);
  assert.equal(TiledTilemap.prototype._paintTile._pmjsYedGuard, true);
  assert.equal(TiledTilemap.prototype._paintPriorityTile._pmjsYedGuard, true);
  assert.equal(TiledTilemap.prototype._updateAnim._pmjsYedGuard, true);
  assert.equal(TiledTilemap.prototype._paintAnimTiles._pmjsYedGuard, true);
  assert.equal(TiledTilemap.prototype.updateTransform._pmjsYedGuard, true);
});

test('Full repaint populates layer._pmjsAnimRecords and _pmjsAnimPrioritySprites', () => {
  const { tilemap, compositeLayer } = makeAnimatedTilemap();
  tilemap.updateTransform();

  assert.ok(compositeLayer._pmjsAnimRecords);
  assert.ok(compositeLayer._pmjsAnimRecords['0']);
  assert.equal(compositeLayer._pmjsAnimRecords['0'].length, 1);
  assert.equal(compositeLayer._pmjsAnimRecords['0'][0].pointOffset, 0);

  assert.ok(tilemap._pmjsAnimPrioritySprites);
  assert.ok(tilemap._pmjsAnimPrioritySprites['0']);
  assert.equal(tilemap._pmjsAnimPrioritySprites['0'].length, 1);
});

test('indexed priority sprite advances to its new animation frame', () => {
  const { tilemap, prioritySprites } = makeAnimatedTilemap();
  tilemap._isPriorityTile = () => true;
  tilemap.updateTransform();
  assert.equal(prioritySprites[0]._frame.x, 0);

  tilemap._updateAnim();
  tilemap.updateTransform();

  assert.equal(prioritySprites[0]._frame.x, 32);
  assert.equal(prioritySprites[0]._frame.y, 0);
  assert.equal(prioritySprites[0]._frame.width, 32);
  assert.equal(prioritySprites[0]._frame.height, 32);
});

test('indexed animation preserves an own updateTransform override', () => {
  function customUpdateTransform() {}
  const { TiledTilemap } = makeAnimatedTilemap({
    ownUpdateTransform: customUpdateTransform
  });
  assert.equal(TiledTilemap.prototype._pmjsIndexedPaintLoops, true);
  assert.equal(TiledTilemap.prototype._pmjsIndexedAnimation, undefined);
  assert.equal(TiledTilemap.prototype.updateTransform, customUpdateTransform);
});

test('Two _updateAnim() calls before one updateTransform() union pending keys', () => {
  const { tilemap, rectLayer, compositeLayer } = makeAnimatedTilemap();
  tilemap.updateTransform();
  const initialGen = rectLayer._pmjsNativeGeneration;

  // Tick 1: key 0 advances (duration 1 -> 0)
  tilemap._updateAnim();
  assert.equal(tilemap.refreshCalls, 0); // No full refresh!
  assert.equal(tilemap._needsAnimRepaint, true);
  assert.deepEqual(Object.keys(tilemap._pmjsChangedAnimKeys), ['0']);

  // Tick 2: key 1 advances (duration 2 -> 0)
  tilemap._animDuration['1'] = 1; // force expiration on next tick
  tilemap._updateAnim();
  assert.equal(tilemap.refreshCalls, 0);
  assert.deepEqual(Object.keys(tilemap._pmjsChangedAnimKeys).sort(), ['0', '1']);

  // Now render: updateTransform runs _paintAnimTiles and clears pending keys
  tilemap.updateTransform();
  assert.equal(tilemap._needsAnimRepaint, false);
  assert.equal(tilemap._pmjsChangedAnimKeys, null);

  // Both rect offsets patched in pointsBuf
  // Frame 1 of local 0 is tileid 1 -> u = 32, v = 0
  assert.equal(rectLayer.pointsBuf[0], 32);
  assert.equal(rectLayer.pointsBuf[1], 0);
  // Frame 1 of local 1 is tileid 2 -> u = 64, v = 0
  assert.equal(rectLayer.pointsBuf[9], 64);
  assert.equal(rectLayer.pointsBuf[10], 0);

  // Generation bumped, modification markers reset
  assert.ok(rectLayer._pmjsNativeGeneration > initialGen);
  assert.equal(rectLayer.modificationMarker, 0);
  assert.equal(compositeLayer.modificationMarker, 0);
});

test('Animation timer advances but resulting UV is identical: no generation bump', () => {
  const { tilemap, rectLayer } = makeAnimatedTilemap();
  tilemap.updateTransform();
  const genBefore = rectLayer._pmjsNativeGeneration;

  // Configure frame 1 to have identical tileid 0 as frame 0
  tilemap.tiledData.tilesets[0].tiles['0'].animation[1] = { tileid: 0 };

  tilemap._updateAnim();
  tilemap.updateTransform();

  // UV was identical -> no generation bump!
  assert.equal(rectLayer._pmjsNativeGeneration, genBefore);
});

test('Bitmap count changes during an animation tick triggers full refresh()', () => {
  const { tilemap } = makeAnimatedTilemap();
  tilemap.updateTransform();

  // Expand bitmaps array
  tilemap.bitmaps.push({ _baseTexture: {} });
  tilemap._updateAnim();

  // Preserved ShaderTilemap.refresh semantics!
  assert.equal(tilemap.refreshCalls, 1);
  assert.equal(tilemap._needsRepaint, true);
  assert.equal(tilemap._needsAnimRepaint, false);
});

test('Unsupported non-square ordinary animated rect triggers conservative full repaint', () => {
  const { tilemap } = makeAnimatedTilemap({ squareTiles: false });
  tilemap.updateTransform();

  // Non-square tile flagged for fallback
  assert.equal(tilemap._pmjsFallbackAnimKeys['0'], true);

  tilemap._updateAnim();
  // Triggers full refresh() fallback!
  assert.equal(tilemap.refreshCalls, 1);
  assert.equal(tilemap._needsRepaint, true);
  assert.equal(tilemap._needsAnimRepaint, false);
});

test('Full repaint cleans up previous indices without stale leaks', () => {
  const { tilemap, compositeLayer } = makeAnimatedTilemap();
  tilemap.updateTransform();
  assert.equal(compositeLayer._pmjsAnimRecords['0'].length, 1);

  // Change map tiles so key 0 is removed
  tilemap.tiledData.layers[0].data = [0, 0];
  tilemap.refresh();
  tilemap.updateTransform();

  // Previous records wiped clean
  assert.equal(compositeLayer._pmjsAnimRecords['0'], undefined);
});

test('indexed-animation switch restores full animation repainting', () => {
  const { TiledTilemap } = makeAnimatedTilemap({
    disableOptimizations: ['tilemap.yed-indexed-animation']
  });
  assert.equal(TiledTilemap.prototype._pmjsIndexedAnimation, undefined);
  assert.equal(TiledTilemap.prototype._updateAnim._pmjsYedGuard, undefined);
  assert.equal(TiledTilemap.prototype._pmjsIndexedPaintLoops, true);
});

test('paint-loop switch leaves the complete YED implementation untouched', () => {
  const { TiledTilemap } = makeAnimatedTilemap({
    disableOptimizations: ['tilemap.yed-indexed-paint-loops']
  });
  assert.equal(TiledTilemap.prototype._pmjsIndexedPaintLoops, undefined);
  assert.equal(TiledTilemap.prototype._pmjsIndexedAnimation, undefined);
  assert.equal(TiledTilemap.prototype._paintAllTiles, faithfulPaintAllTiles);
  assert.equal(TiledTilemap.prototype._updateLayerPositions,
    faithfulUpdateLayerPositions);
  assert.equal(TiledTilemap.prototype._paintTilesLayer,
    faithfulPaintTilesLayer);
  assert.equal(TiledTilemap.prototype._paintObjectLayers,
    faithfulPaintObjectLayers);
  assert.equal(TiledTilemap.prototype._paintTile, faithfulPaintTile);
  assert.equal(TiledTilemap.prototype._paintPriorityTile,
    faithfulPaintPriorityTile);
  assert.equal(TiledTilemap.prototype._updateAnim, faithfulUpdateAnim);
  assert.equal(TiledTilemap.prototype.updateTransform,
    faithfulShaderTilemapUpdateTransform);
});
