'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { temporaryDirectory } = require('./helpers/temp.cjs');
const { createRuntime } = require('../patches/omori/native-mv.cjs');

test('Tiled publication follows map readiness, replacement and maps without Tiled data', t => {
  const root = temporaryDirectory('tiled-publication');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'maps'));
  const tiled = { orientation: 'orthogonal', renderorder: 'right-down', width: 2, height: 2, tilewidth: 24, tileheight: 24, layers: [], tilesets: [] };
  fs.writeFileSync(path.join(root, 'maps/map42.json'), JSON.stringify(tiled));
  const publications = [];
  let ready = false;
  function Spriteset_Map() {}
  Object.assign(Spriteset_Map.prototype, { createTilemap() {}, loadTileset() {}, updateTileset() {} });
  const runtime = { scope: { Imported: { YED_Tiled: true }, Spriteset_Map, $dataMap: {} },
    runScript() {}, mapDatabase: { requestedMapId: 42, isReady() { return ready; } } };
  createRuntime({ gameRoot: root, session: {}, engine: { databaseInvoke(...args) { publications.push(args.slice(1)); } },
    createPluginRuntime(engine, session, options) { options.beforePlugins(runtime); return runtime; } });
  assert.equal(runtime.mapDatabase.isReady(), false); assert.equal(publications.length, 0);
  ready = true;
  assert.equal(runtime.mapDatabase.isReady(), true);
  assert.equal(publications[0][0], 'publishTiledMap'); assert.equal(publications[0][1], 42);
  assert.equal(publications[0][2].tilewidth, 24); assert.deepEqual(publications[0][2].passage, [0, 0, 0, 0]);
  runtime.mapDatabase.isReady(); assert.equal(publications.length, 1);
  runtime.scope.$dataMap = {};
  runtime.mapDatabase.isReady(); assert.equal(publications.length, 2);
  runtime.mapDatabase.requestedMapId = 43; runtime.scope.$dataMap = {};
  runtime.mapDatabase.isReady(); assert.deepEqual(publications[2], ['publishTiledMap', 43, null]);
});
