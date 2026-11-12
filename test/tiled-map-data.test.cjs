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

test('normalizes legacy keyed tile animations', () => {
  const f=fixture();f.set.tiles={1:{animation:[{tileid:0,duration:100}]}};f.write();
  assert.equal(loadTiledMap(f.root,'maps/map.json').tilesets[0].tiles[1].id,1);
});

test('normalizes full and directional collision, including invisible mask layers', () => {
  const f=fixture();f.map.layers[0].visible=false;f.map.layers[0].properties={collision:'tile-base'};
  f.set.tileproperties={0:{collision:'full'},1:{arrowImpassable:'left & up'}};f.write();
  assert.deepEqual(loadTiledMap(f.root,'maps/map.json').passage,[15,10]);
  f.map.layers.push({...f.map.layers[0],properties:{collision:'arrow',arrowImpassable:'left'},data:[0,2]});f.write();
  assert.deepEqual(loadTiledMap(f.root,'maps/map.json').passage,[15,8]);
});
