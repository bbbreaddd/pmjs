'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { temporaryDirectory } = require('./helpers/temp.cjs');
const { databaseFiles } = require('../runner/mv-engine-data.cjs');
const { installDatabase } = require('../runner/native-database.cjs');

function setup() {
  const root = temporaryDirectory('native-database-');
  fs.mkdirSync(path.join(root, 'data'));
  for (const file of databaseFiles) fs.writeFileSync(path.join(root, 'data', file.src), file.key === 'system' ? '{}' : '[]');
  const scope = vm.createContext({ DataManager: { isBattleTest: () => false, isEventTest: () => false }, Scene_Boot: { loadSystemImages() {} } });
  const runtime = { scope, runScript: source => vm.runInContext(source, scope) }, publications = [], maps = [];
  installDatabase(runtime, { databaseInvoke(_session, method, data, value) {
    if (method === 'canWrite') return true;
    if (method === 'metadata') return {};
    if (method === 'publishMap') { maps.push({ id: data, map: value }); return; }
    if (method === 'publish') { publications.push(structuredClone(data)); return; }
    throw new Error('Unexpected database method: ' + method);
  } }, {}, root);
  return { runtime, scope, root, publications, maps };
}

test('database loading honors file remapping, extra files and outer readiness callbacks', () => {
  const { runtime, scope, root, publications } = setup();
  fs.writeFileSync(path.join(root, 'data/CommonEvents.json'), '[null,{"name":"original"}]');
  fs.writeFileSync(path.join(root, 'data/CommonEvents2.json'), '[null,{"name":"alternative"}]');
  fs.writeFileSync(path.join(root, 'data/Extra.json'), '{"value":1}');
  const manager = scope.DataManager;
  manager._databaseFiles.find(file => file.name === '$dataCommonEvents').src = 'CommonEvents2.json';
  manager._databaseFiles.push({ name: '$dataOtherCommonEvents', src: 'CommonEvents.json' }, { name: '$dataExtra', src: 'Extra.json' });
  runtime.database.load();
  const extra = scope.$dataExtra, originalReady = manager.isDatabaseLoaded;
  let ready = false;
  manager.isDatabaseLoaded = function() { if (!ready || !originalReady.call(this)) return false; extra.value = 7; return true; };
  assert.equal(runtime.database.isReady(), false);
  assert.equal(publications.length, 0);
  ready = true;
  assert.equal(runtime.database.isReady(), true);
  assert.equal(scope.$dataExtra, extra);
  assert.equal(publications[0].commonEvents[1].name, 'alternative');
  assert.equal(publications[0]['plugin:$dataOtherCommonEvents'][1].name, 'original');
  assert.equal(publications[0]['plugin:$dataExtra'].value, 7);
  runtime.database.isReady();
  assert.equal(publications.length, 1, 'ready polling must not republish unchanged tables');
});

test('missing plugin database files retain the failure and prevent publication', () => {
  const { runtime, scope, publications } = setup();
  scope.DataManager._databaseFiles.push({ name: '$dataMissing', src: 'Missing.json' });
  let failure;
  assert.doesNotThrow(() => runtime.database.load());
  assert.throws(() => scope.DataManager.checkError(), error => { failure = error; return /Missing\.json/.test(error.message); });
  assert.match(scope.DataManager._errorUrl, /Missing\.json$/);
  assert.equal(scope.$dataMissing, null);
  assert.throws(() => scope.DataManager.checkError(), error => error === failure);
  assert.throws(() => runtime.database.isReady(), error => error === failure);
  assert.equal(publications.length, 0);
});


test('map loading calls plugin hooks and waits for supplementary data before native publication', () => {
  const { runtime, scope, root, maps } = setup(), manager=scope.DataManager;
  fs.writeFileSync(path.join(root, 'data/Map001.json'), '{"width":7,"height":5,"note":"","events":[]}');
  const load=manager.loadMapData, isLoaded=manager.isMapLoaded;
  let ready=false, loads=0;
  manager.loadMapData=function(id){++loads;load.call(this,id);scope.$dataMap.pluginMap=true;};
  manager.isMapLoaded=function(){return isLoaded.call(this) && ready;};
  runtime.mapDatabase.load(1);
  assert.equal(loads,1);assert.equal(scope.$dataMap.width,7);
  assert.equal(runtime.mapDatabase.isReady(),false);assert.equal(maps.length,0);
  ready=true;assert.equal(runtime.mapDatabase.isReady(),true);
  assert.equal(maps[0].id,1);assert.equal(maps[0].map,scope.$dataMap);assert.equal(maps[0].map.pluginMap,true);
  assert.equal(runtime.mapDatabase.isReady(),true);assert.equal(maps.length,1);
});
