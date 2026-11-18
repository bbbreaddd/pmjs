'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

class Container {
  constructor() { this.children = []; }
  addChild(child) { if (child.parent) child.parent.removeChild(child); this.children.push(child); child.parent = this; }
  removeChild(child) { this.children.splice(this.children.indexOf(child), 1); child.parent = null; }
  destroy(options) { if (options.children) for (const child of this.children.slice()) child.destroy(options); this.destroyed = true; }
}
function fixture(tracked = false) {
  const context = { PIXI: { Container }, PMJS: { yedPriorityUpdates: { canDefer: () => true } }, $gameMap: { currentMapLevel: 0 } };
  if (tracked) context.PMJS.pixi4 = { tilePointRevision(rect, points) { return points === rect.pointsBuf ? rect._pmjsNativeGeneration || 0 : -1; } };
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
  map.children = sprites.slice();
  map.addChild = Container.prototype.addChild; map.removeChild = Container.prototype.removeChild;
  for (const sprite of sprites) sprite.parent = map;
  return { api: context.PMJS.yedRetainedTiles, map, rect, sprites };
}

test('animation support ownership rejects replaced hooks without invoking accessors', () => {
  const { api } = fixture();
  const operation = api.updateAnimation, predicate = api.supported;
  assert.equal(api.animationChecksSupport(), true);
  api.supported = () => false;
  assert.equal(api.animationChecksSupport(), false);
  api.supported = predicate;
  let reads = 0;
  Object.defineProperty(api, 'updateAnimation', { configurable: true,
    get() { reads++; return operation; } });
  assert.equal(api.animationChecksSupport(), false);
  assert.equal(reads, 0);
});

test('map size validation preserves eager dimension reads before rejecting invalid sizes', () => {
  const fields = ['_tileWidth', '_tileHeight', '_mapWidth', '_mapHeight', '_width', '_height'];
  for (const invalid of [{ field: '_tileWidth', value: NaN }, { field: '_height', value: 0 }]) {
    const { api, map } = fixture();
    const reads = [];
    for (const field of fields) {
      const value = field === invalid.field ? invalid.value : map[field];
      Object.defineProperty(map, field, { get() { reads.push(field); return value; } });
    }
    assert.equal(api.supported(map), false);
    assert.deepEqual(reads, fields);
  }
});

test('tileset size validation preserves eager reads and rejects invalid columns before later metadata', () => {
  const { api, map } = fixture();
  const set = map.tiledData.tilesets[0], reads = [];
  for (const field of ['columns', 'tilewidth', 'tileheight']) {
    const value = field === 'columns' ? 0 : set[field];
    Object.defineProperty(set, field, { get() { reads.push(field); return value; } });
  }
  Object.defineProperty(set, 'firstgid', { get() { assert.fail('invalid dimensions must reject before firstgid'); } });
  assert.equal(api.supported(map), false);
  assert.deepEqual(reads, ['columns', 'tilewidth', 'tileheight']);
});

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

test('camera changes and forced repaints publish current inputs before retaining the new window', () => {
  const { api, map, rect } = fixture();
  api.prepare(map, 0, 0);
  map.tiledData.layers[0].data[1] = 1;
  map.origin.x = 16;
  assert.equal(api.prepare(map, 1, 0), true);
  assert.equal(rect.pointsBuf[0], 0);
  assert.equal(map._layers[0].position.x, 0);
  const shifted = rect.pointsBuf.slice();
  const painted = rect.calls;
  api.prepare(map, 1, 0);
  assert.equal(rect.calls, painted);
  map._needsRepaint = true;
  map.tiledData.layers[0].data[1] = 2;
  api.prepare(map, 1, 0);
  assert.equal(rect.pointsBuf[0], 16);
  assert.notDeepEqual(rect.pointsBuf, shifted);
  const repainted = rect.calls;
  api.prepare(map, 1, 0);
  assert.equal(rect.calls, repainted);
  map.origin.x = 0;
  api.prepare(map, 0, 0);
  assert.equal(rect.pointsBuf[9], 16);
  assert.equal(map._layers[0].position.x, 0);
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

test('windows over map edges compare the cells they show, with and without wrapping', () => {
  const { api, map, rect } = fixture();
  // A 2x2 window at (-1, 0) shows column 0 of the map; column 1 is outside it.
  assert.equal(api.prepare(map, -1, 0), true);
  const painted = rect.calls;
  map.tiledData.layers[0].data[1] = 1;
  api.prepare(map, -1, 0);
  assert.equal(rect.calls, painted);
  map.tiledData.layers[0].data[0] = 2;
  api.prepare(map, -1, 0);
  assert.ok(rect.calls > painted);
  // With horizontal wrapping, the same window shows column 1 at x = -1.
  map.horizontalWrap = true;
  api.prepare(map, -1, 0);
  const wrapped = rect.calls;
  api.prepare(map, -1, 0);
  assert.equal(rect.calls, wrapped);
  map.tiledData.layers[0].data[3] = 1;
  api.prepare(map, -1, 0);
  assert.ok(rect.calls > wrapped);
});

test('tracked ordinary scrolling retains overlap with canonical geometry through reversals and diagonals', () => {
  const a = fixture(true), b = fixture();
  for (const f of [a,b]) {
    f.map._mapWidth = f.map._mapHeight = 6;
    f.map.tiledData.layers[0].data = Array.from({length:36}, (_,i)=>i%2+1);
  }
  const points = a.rect.pointsBuf;
  for (const [x,y] of [[0,0],[1,0],[2,1],[1,0],[0,0],[-1,0],[-1,-1],[0,0]]) {
    for (const f of [a,b]) {
      f.map.origin.x=x*16;f.map.origin.y=y*16;
      assert.equal(f.api.prepare(f.map,x,y),true);
    }
    assert.deepEqual(a.rect.pointsBuf,b.rect.pointsBuf);
    assert.equal(a.rect.pointsBuf,points);
    assert.deepEqual(a.map._layers[0].position,b.map._layers[0].position);
  }
  assert.ok(a.rect.calls < b.rect.calls);
});

test('scroll reuse observes live inputs and preserves mixed priority/object assignments', () => {
  const a = fixture(true), b = fixture();
  for (const f of [a,b]) {
    f.map._mapWidth=f.map._mapHeight=6;
    f.map.tiledData.layers[0].data=Array(36).fill(1);
    f.map.tiledData.layers.push({type:'objectgroup',objects:[{gid:2,visible:true,x:8,y:20,height:16}]});
    f.map.horizontalWrap=f.map.verticalWrap=true;
  }
  const mutations=[()=>{},()=>{},f=>{f.map.tiledData.layers[0].data[7]=2;},
    f=>{f.rect.pointsBuf[0]=99;},f=>{f.map._needsRepaint=true;},
    f=>{f.map._isPriorityTile=()=>true;},f=>{f.map._isPriorityTile=()=>false;}];
  for(let i=0;i<mutations.length;i++) {
    for(const f of [a,b]) {mutations[i](f);f.api.prepare(f.map,i%2,i%2);}
    assert.deepEqual(a.rect.pointsBuf,b.rect.pointsBuf);
    const sprites=f=>f.sprites.map(s=>[s.layerId,s.origX,s.origY,s.visible,s.frame]);
    assert.deepEqual(sprites(a),sprites(b));
    assert.equal(a.map._pmjsActivePriorityTileCount,b.map._pmjsActivePriorityTileCount);
  }
});

test('scroll reuse handles new layers, replacement rectangles and animated inputs', () => {
  const a=fixture(true), b=fixture();
  for(const f of [a,b]) {
    f.api.prepare(f.map,0,0);
    const rect={pointsBuf:[],textures:[{}],calls:0,addRect:f.rect.addRect};
    f.map.tiledData.layers.push({type:'tilelayer',visible:true,data:[2,1,2,1],properties:{}});
    f.map._layers.push({layerId:1,children:[rect],position:{},clear(){rect.pointsBuf.length=0;rect._pmjsNativeGeneration=(rect._pmjsNativeGeneration||0)+1;}});
  }
  for(const f of [a,b]) {
    const rect={pointsBuf:[],textures:[{}],calls:0,addRect:f.rect.addRect};
    f.map._layers[0].children[0]=rect;
    f.map._layers[0].clear=function(){rect.pointsBuf.length=0;rect._pmjsNativeGeneration=(rect._pmjsNativeGeneration||0)+1;};
  }
  for(const [x,y] of [[1,0],[0,0],[1,1],[0,0]]) {
    for(const f of [a,b]) {f.api.prepare(f.map,x,y);f.api.updateAnimation(f.map);f.api.prepare(f.map,x,y);}
    assert.deepEqual(a.map._layers.map(l=>l.children[0].pointsBuf),b.map._layers.map(l=>l.children[0].pointsBuf));
  }
});

test('rejected entering cells do not corrupt reusable overlap', () => {
  const a=fixture(true), b=fixture();
  for(const f of [a,b]) {
    f.map._mapWidth=3;f.map.tiledData.layers[0].data=[1,2,1,2,1,2];
    f.api.prepare(f.map,0,0);
    const before=f.rect.pointsBuf.slice();
    f.map.tiledData.layers[0].data[2]=0x80000001;
    assert.equal(f.api.prepare(f.map,1,0),false);
    assert.deepEqual(f.rect.pointsBuf,before);
    f.map.tiledData.layers[0].data[2]=1;
    assert.equal(f.api.prepare(f.map,1,0),true);
  }
  assert.deepEqual(a.rect.pointsBuf,b.rect.pointsBuf);
});

test('unused priority pool stays outside traversal and repaints park retired slots', () => {
  const { api, map, sprites } = fixture();
  map.children = sprites.slice();
  for (const sprite of sprites) Object.assign(sprite, { parent: map, layerId: -1, _hiding: true, visible: true });
  api.deferPriorityTiles(map);
  const holder = map.children[0];
  assert.equal(holder.visible, false);
  assert.deepEqual(holder.children, sprites);
  assert.deepEqual(map._priorityTiles, sprites);
  assert.ok(sprites.every(sprite => sprite.visible === false));
  map.tiledData.layers.push({ type: 'objectgroup', objects: [{ gid: 1, visible: true, x: 10, y: 20, height: 16 }] });
  assert.equal(api.prepare(map, 0, 0), true);
  assert.deepEqual(map.children, [holder, sprites[0]]);
  assert.equal(sprites[0].parent, map);
  assert.equal(sprites[0].x, 18);
  map.tiledData.layers[1].objects.length = 0;
  api.invalidate(map); api.prepare(map, 0, 0);
  assert.equal(sprites[0].visible, false);
  assert.deepEqual(map.children, [holder]);
  api.restorePriorityTiles(map);
  assert.deepEqual(map.children, [holder, ...sprites]);
});

test('deferred pool restoration preserves ownership transferred to another parent', () => {
  const { api, map, sprites } = fixture();
  for (const sprite of sprites) Object.assign(sprite, { parent: map, layerId: -1, _hiding: true });
  api.deferPriorityTiles(map);
  const other = {}; sprites[0].parent = other;
  api.restorePriorityTiles(map);
  assert.equal(sprites[0].parent, other);
  assert.equal(sprites[1].parent, map);
});

test('parked priority sprites remain owned by recursive tilemap destruction', () => {
  const { api, map, sprites } = fixture();
  for (const sprite of sprites) Object.assign(sprite, { layerId: -1, _hiding: true,
    destroy() { this.destroyed = true; } });
  api.deferPriorityTiles(map);
  assert.equal(map.children.length, 1);
  Container.prototype.destroy.call(map, { children: true });
  assert.ok(sprites.every(sprite => sprite.destroyed));
});
