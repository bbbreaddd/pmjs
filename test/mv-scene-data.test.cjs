'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadSceneData } = require('../runner/mv-scene-data.cjs');
const directory = path.join(__dirname, '../build/test-assets/map-scene');
fs.mkdirSync(directory, { recursive: true });
const file = path.join(directory, 'scene.json');
const envelope = () => ({ format: 'pmjs-mv-map-scene-1', database: { sceneContract: { kind: 'map', mapId: 1 }, maps: { 1: { width: 2, height: 3 } }, tiledMaps: { 1: { width: 2, height: 3 } } }, initialState: { map: { _mapId: 1 } }, settings: { width: 640, height: 480, imageCacheBytes: 1024, fontFile: 'fonts/game.ttf' } });
function read(value) { fs.writeFileSync(file, JSON.stringify(value)); return loadSceneData(file); }
test('map scene admits matching data and rejects mismatched saves or extents', () => {
  assert.equal(read(envelope()).database.sceneContract.mapId, 1);
  const wrongSave=envelope();wrongSave.initialState.map._mapId=2;
  assert.throws(()=>read(wrongSave),/does not match/);
  const wrongMap=envelope();wrongMap.database.tiledMaps[1].width=3;
  assert.throws(()=>read(wrongMap),/does not match/);
});
test('map scene validates resource settings', () => {
  const wrongFont=envelope();wrongFont.settings.fontFile='fonts/../script.js';
  assert.throws(()=>read(wrongFont),/font path/);
  const wrongSize=envelope();wrongSize.settings.width=0;
  assert.throws(()=>read(wrongSize),/invalid width/);
});
