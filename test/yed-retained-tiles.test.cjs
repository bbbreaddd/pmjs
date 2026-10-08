'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function fixture() {
  const context = { PMJS: {}, $gameMap: { currentMapLevel: 0 } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../js/pmjs-plugins/yed/retained-tiles.js'), 'utf8'), context);
  const rect = { pointsBuf: [], textures: [{}], calls: 0,
    addRect(...values) { this.calls++; this.pointsBuf.push(values[1], values[2], ...values.slice(3), 0, 0, values[0]); } };
  const layer = { layerId: 0, children: [rect], position: {}, clear() { rect.pointsBuf.length = 0; rect._pmjsNativeGeneration = (rect._pmjsNativeGeneration || 0) + 1; } };
  const sprites = Array.from({ length: 2 }, () => ({ anchor: {}, width: 16, height: 16,
    setFrame(...frame) { this.frame = frame; }, show() { this.visible = true; }, hide() { this.visible = false; } }));
  const map = { tiledData: { orientation: 'orthogonal', layers: [{ type: 'tilelayer', visible: true, data: [1, 2, 1, 2], properties: {} }],
    tilesets: [{ firstgid: 1, columns: 4, tilewidth: 16, tileheight: 16 }] },
    _layers: [layer], _priorityTiles: sprites, bitmaps: [{}], _tileWidth: 16, _tileHeight: 16,
    _width: 16, _height: 16, _mapWidth: 2, _mapHeight: 2, origin: { x: 0, y: 0 },
    _animFrame: { 0: 0 }, _animDuration: { 0: 1 },
    _getTextureId() { return 0; }, _getAnimTileId(texture, id) { return id === 0 ? this._animFrame[0] : id; },
    _getPriority() { return 1; }, _getZIndex() { return 3; }, _isPriorityTile() { return false; },
    _updateAnimFrames() { this._animDuration[0] = 2; }, hideOnLevel() {} };
  return { api: context.PMJS.yedRetainedTiles, map, rect, sprites };
}

test('subcell movement retains submissions and visible mutation rebuilds', () => {
  const { api, map, rect } = fixture();
  assert.equal(api.prepare(map, 0, 0), true);
  assert.equal(rect.calls, 4);
  map.origin.x = 5;
  api.prepare(map, 0, 0);
  assert.equal(rect.calls, 4);
  assert.equal(map._layers[0].position.x, -5);
  map.tiledData.layers[0].data[0] = 2;
  api.prepare(map, 0, 0);
  assert.equal(rect.calls, 8);
});

test('animation patches only source coordinates without new geometry', () => {
  const { api, map, rect } = fixture();
  api.prepare(map, 0, 0);
  const previous = rect.pointsBuf.slice();
  api.updateAnimation(map);
  api.prepare(map, 0, 0);
  assert.equal(rect.calls, 4);
  assert.equal(rect.pointsBuf[0], 16);
  assert.deepEqual(rect.pointsBuf.slice(2, 9), previous.slice(2, 9));
  assert.equal(rect._pmjsNativeGeneration, 2);
});

test('object groups ignore group visibility and reuse a bounded active pool', () => {
  const { api, map, sprites } = fixture();
  map.tiledData.layers.push({ type: 'objectgroup', visible: false,
    objects: [{ gid: 1, visible: true, x: 10, y: 20, height: 16 },
      { gid: 2, visible: true, x: 20, y: 20, height: 16 },
      { gid: 1, visible: true, x: 30, y: 20, height: 16 }] });
  api.prepare(map, 0, 0);
  assert.equal(map._pmjsActivePriorityTileCount, 2);
  assert.equal(map._priorityTilesCount, 2);
  assert.equal(map._priorityTiles[0], sprites[0]);
  assert.equal(sprites[0].x, 18);
  assert.equal(sprites[0].y, 20);
});

test('unsupported flipped gid returns before changing geometry', () => {
  const { api, map, rect } = fixture();
  map.tiledData.layers[0].data[0] = 0x80000001;
  assert.equal(api.prepare(map, 0, 0), false);
  assert.equal(rect.calls, 0);
});

test('normalization runs only at expiration and invalidation rebuilds retained state', () => {
  const { api, map, rect } = fixture();
  let calls = 0;
  map._updateAnimFrames = () => { calls++; map._animDuration[0] = 3; };
  map._animDuration[0] = 2;
  api.prepare(map, 0, 0);
  api.updateAnimation(map);
  assert.equal(calls, 0);
  api.updateAnimation(map);
  assert.equal(calls, 1);
  api.prepare(map, 0, 0);
  api.invalidate(map);
  api.prepare(map, 0, 0);
  assert.equal(rect.calls, 8);
});

test('texture binding, animation metadata and authored geometry mutations invalidate', () => {
  const { api, map, rect } = fixture();
  api.prepare(map, 0, 0);
  rect.textures[0] = {};
  api.prepare(map, 0, 0);
  assert.equal(rect.calls, 8);
  map.tiledData.tilesets[0].tiles = { 0: { animation: [{ tileid: 1, duration: 3 }] } };
  api.prepare(map, 0, 0);
  assert.equal(rect.calls, 12);
  map.tiledData.tilesets[0].tiles[0].animation[0].tileid = 2;
  api.prepare(map, 0, 0);
  assert.equal(rect.calls, 16);
  rect.pointsBuf[2] = 123;
  api.prepare(map, 0, 0);
  assert.equal(rect.calls, 20);
});

test('rectangular animated cells rebuild and foreign generation changes rebuild', () => {
  const { api, map, rect } = fixture();
  map.tiledData.tilesets[0].tileheight = 32;
  api.prepare(map, 0, 0);
  api.updateAnimation(map);
  api.prepare(map, 0, 0);
  assert.equal(rect.calls, 8);
  rect._pmjsNativeGeneration++;
  api.prepare(map, 0, 0);
  assert.equal(rect.calls, 12);
});

test('shared local animation keys patch both tilesets and frame zero retains original id', () => {
  const { api, map, rect } = fixture();
  map.tiledData.tilesets = [
    { firstgid: 1, columns: 4, tilewidth: 16, tileheight: 16 },
    { firstgid: 10, columns: 2, tilewidth: 32, tileheight: 32 }
  ];
  map.bitmaps.push({});
  rect.textures.push({});
  map.tiledData.layers[0].data = [1, 10, 1, 10];
  map._getTextureId = gid => gid >= 10 ? 1 : 0;
  const sequences = [[{ tileid: 3 }, { tileid: 2 }], [{ tileid: 1 }, { tileid: 3 }]];
  let sourceLookups = 0;
  map._getAnimTileId = function(texture, local) {
    sourceLookups++;
    const frame = this._animFrame[String(local)];
    return frame ? sequences[texture][frame].tileid : local;
  };
  api.prepare(map, 0, 0);
  assert.equal(sourceLookups, 2);
  assert.equal(rect.pointsBuf[0], 0);
  assert.equal(rect.pointsBuf[9], 0);
  api.updateAnimation(map);
  api.prepare(map, 0, 0);
  assert.equal(sourceLookups, 4);
  assert.equal(rect.pointsBuf[0], 32);
  assert.equal(rect.pointsBuf[9], 32);
  assert.equal(rect.pointsBuf[10], 32);
  assert.equal(rect.calls, 4);
});

test('expired animation refreshes changed bitmap array and ignores unused tile metadata', () => {
  const { api, map, rect } = fixture();
  map.tiledData.tilesets[0].tiles = { 99: { animation: [{ tileid: 1, duration: 3 }] } };
  api.prepare(map, 0, 0);
  map.tiledData.tilesets[0].tiles[99].animation[0].tileid = 2;
  api.prepare(map, 0, 0);
  assert.equal(rect.calls, 4);
  let refreshes = 0;
  map._lastBitmapLength = 1;
  map.refresh = function() { refreshes++; this._needsRepaint = true; };
  map.bitmaps.push({});
  api.updateAnimation(map);
  assert.equal(refreshes, 1);
  api.prepare(map, 0, 0);
  assert.equal(rect.calls, 8);
});

test('mixed sprite and rectangular animation rebuilds before changing frames', () => {
  const { api, map, sprites, rect } = fixture();
  map.tiledData.tilesets[0].tileheight = 32;
  map.tiledData.layers.push({ type: 'objectgroup', objects: [
    { gid: 1, visible: true, x: 10, y: 32, height: 32 }
  ] });
  let frames = 0;
  sprites[0].setFrame = function(...frame) { frames++; this.frame = frame; };
  api.prepare(map, 0, 0);
  assert.equal(frames, 1);
  api.updateAnimation(map);
  api.prepare(map, 0, 0);
  assert.equal(frames, 2);
  assert.equal(rect.calls, 8);
  assert.deepEqual(sprites[0].frame, [16, 0, 16, 32]);
});

test('a null native layer conservatively declines before mutation', () => {
  const { api, map, rect } = fixture();
  map._layers.push(null);
  assert.equal(api.supported(map), false);
  assert.equal(api.prepare(map, 0, 0), false);
  assert.equal(rect.calls, 0);
});
