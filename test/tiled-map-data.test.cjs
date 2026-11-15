'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { temporaryDirectory } = require('./helpers/temp.cjs');
const { loadTiledMap } = require('../runner/tiled-map-data.cjs');
function fixture() {
  const root = temporaryDirectory('tiled-map-data-');
  fs.mkdirSync(path.join(root, 'maps')); fs.mkdirSync(path.join(root, 'img'));
  const map = { orientation: 'orthogonal', renderorder: 'right-down', width: 2, height: 1,
    tilewidth: 32, tileheight: 32, layers: [{ type: 'tilelayer', width: 2, height: 1, data: [1,2],
      properties: { zIndex: '3', priority: '1' } }], tilesets: [{ firstgid: 1, source: 'sheet.json' }] };
  const set = { image: '../img/sheet.png', tilewidth: 32, tileheight: 32, columns: 2, tilecount: 2,
    tiles: [{ id: 1, animation: [{ tileid: 0, duration: 100 }, { tileid: 1, duration: 200 }] }] };
  function write() {
    fs.writeFileSync(path.join(root,'maps/map.json'),JSON.stringify(map));
    fs.writeFileSync(path.join(root,'maps/sheet.json'),JSON.stringify(set));
  }
  write(); return { root,map,set,write };
}
test('loads external tilesets, layer priorities and animation data without evaluating scripts', () => {
  const f=fixture(), result=loadTiledMap(f.root,'maps/map.json');
  assert.equal(result.tilesets[0].image,'img/sheet.png');
  assert.equal(result.tilesets[0].tiles[1].animation[1].duration,200);
  assert.equal(result.layers[0].properties.priority,'1');
});
test('reflection rectangles remain metadata and retain hidden areas for native compilation', () => {
  const f = fixture();
  f.map.layers.push({ type: 'objectgroup', properties: { reflectionCast: -1, reflectionOpacity: 0, reflectionOffset: 7 },
    objects: [{ x: 0, y: 16, width: 64, height: 16, visible: false }] });
  f.map.layers.push({ type: 'tilelayer', width: 2, height: 1, data: [1, 2], properties: { reflectionSurface: true } });
  f.write();
  const data = loadTiledMap(f.root, 'maps/map.json');
  assert.equal(data.layers.length, 3);
  assert.equal(data.layers[2].visible, false);
  assert.equal(data.sourceLayers[1].objects[0].visible, false);
  assert.equal(data.sourceLayers[1].properties.reflectionOpacity, 0);
  f.map.layers[1].objects[0].rotation = 45; f.write();
  assert.equal(loadTiledMap(f.root, 'maps/map.json').sourceLayers[1].objects[0].rotation, 45);
});
test('reports source locations for unsupported layers, flip flags and missing tile IDs', () => {
  const f=fixture();f.map.layers[0].data[1]=0x80000001;f.write();
  assert.throws(()=>loadTiledMap(f.root,'maps/map.json'),/layers\[0\].data\[1\]/);
  f.map.layers[0].data[1]=9;f.write();assert.throws(()=>loadTiledMap(f.root,'maps/map.json'),/unknown tile ID/);
  f.map.layers[0].type='objectgroup';f.write();assert.throws(()=>loadTiledMap(f.root,'maps/map.json'),/unsupported layer/);
});
test('rejects asset paths outside the declared game root', () => {
  const f=fixture();f.set.image='../../outside.png';f.write();
  assert.throws(()=>loadTiledMap(f.root,'maps/map.json'),/escapes game root/);
});
test('preserves authored tile objects and hides region masks', () => {
  const f = fixture();
  const object = (gid, x) => ({ gid, x, y: 32, width: 32, height: 32, rotation: 0, visible: true });
  f.map.layers = [{ type: 'objectgroup', properties: { zIndex: '3', priority: '1' }, objects: [object(1, 0), object(2, 32), object(2, 0)] },
    { type: 'tilelayer', width: 2, height: 1, data: [0, 1], properties: { regionId: '8' } }];
  f.write();
  const data = loadTiledMap(f.root, 'maps/map.json');
  assert.deepEqual(data.layers[0].objects.map(object => object.gid), [1, 2, 2]);
  assert.equal(data.layers[0].properties.priority, '1');
  assert.equal(data.layers[1].visible, false);
  assert.equal(data.sourceLayers[1].properties.regionId, '8');
  f.map.layers[0].objects[0].rotation = 30; f.write();
  assert.equal(loadTiledMap(f.root, 'maps/map.json').layers[0].objects[0].rotation, 30);
});

test('normalizes legacy keyed tile animations', () => {
  const f=fixture();f.set.tiles={1:{animation:[{tileid:0,duration:100}]}};f.write();
  assert.equal(loadTiledMap(f.root,'maps/map.json').tilesets[0].tiles[1].id,1);
});

test('retains collision properties and levels for native compilation, including invisible masks', () => {
  const f=fixture();f.map.layers[0].visible=false;f.map.layers[0].properties={collision:'tile-base'};
  f.set.tileproperties={0:{collision:'full'},1:{arrowImpassable:'left & up'}};f.write();
  const data=loadTiledMap(f.root,'maps/map.json');
  assert.equal(data.sourceLayers[0].properties.collision,'tile-base');
  assert.equal(data.tilesets[0].tileproperties[1].arrowImpassable,'left & up');
  assert.equal(data.sourceLayers[0].visible,false);
});


test('accepts off-grid and outside-map tile objects without inventing priority', () => {
  const f = fixture();
  f.map.layers = [{ type: 'objectgroup', properties: { zIndex: 3, priority: 0 }, objects: [
    { gid: 1, visible: true, x: -3.5, y: 17.25, width: 80, height: 12, properties: { eventId: 2 } },
    { gid: 2, visible: true, x: 642, y: 2114, width: 32, height: 32 }
  ] }];
  f.write();
  const data = loadTiledMap(f.root, 'maps/map.json');
  assert.equal(data.layers[0].properties.priority, 0);
  assert.equal(data.layers[0].objects[0].x, -3.5);
  assert.equal(data.layers[0].objects[0].height, 12);
  assert.equal(data.layers[0].objects[0].properties.eventId, 2);
  assert.equal(data.layers[0].objects[1].x, 642);
});
