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
  const runtime = { scope, runScript: source => vm.runInContext(source, scope) }, publications = [];
  installDatabase(runtime, { databaseInvoke(_session, method, data) {
    if (method === 'canWrite') return true;
    if (method === 'publish') { publications.push(structuredClone(data)); return; }
    throw new Error('Unexpected database method: ' + method);
  } }, {}, root);
  return { runtime, scope, root, publications };
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
  assert.throws(() => runtime.database.load(), error => { failure = error; return /Missing\.json/.test(error.message); });
  assert.match(scope.DataManager._errorUrl, /Missing\.json$/);
  assert.equal(scope.$dataMissing, null);
  assert.throws(() => scope.DataManager.checkError(), error => error === failure);
  assert.throws(() => runtime.database.isReady(), error => error === failure);
  assert.equal(publications.length, 0);
});
