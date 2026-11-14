'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { temporaryDirectory } = require('./helpers/temp.cjs');
const { fixture, command } = require('./helpers/mv-session-fixture.cjs');
const { databaseFiles } = require('../runner/mv-engine-data.cjs');
const { installDatabase } = require('../runner/native-database.cjs');
const { createScriptRuntime } = require('../runner/mv-script-runtime.cjs');
const api = require(path.resolve(process.argv[2])).mvEngine;

function setup(t, configure = () => {}) {
  const data = fixture([]); configure(data);
  const session = api.create(data); t.after(() => api.dispose(session));
  const runtime = createScriptRuntime(api, session), scope = runtime.scope;
  const root = temporaryDirectory('live-database-');
  fs.mkdirSync(path.join(root, 'data'));
  for (const file of databaseFiles) fs.writeFileSync(path.join(root, 'data', file.src), JSON.stringify(data[file.key] || []));
  scope.Scene_Boot = { loadSystemImages() {} };
  scope.DataManager.isBattleTest = scope.DataManager.isEventTest = () => false;
  installDatabase(runtime, api, session, root);
  runtime.database.load(); assert.equal(runtime.database.isReady(), true);
  api.newGame(session);
  return { session, scope, runtime, root };
}

test('native parameters read nested edits, array changes, record and table replacements', t => {
  const { session, scope, runtime, root } = setup(t);
  const hp = () => api.snapshot(session).actors[1].parameters[0];
  const original = scope.$dataClasses[1];
  assert.equal(hp(), 10);
  original.params[0][1] = 30;
  assert.equal(hp(), 30);
  original.traits.push({ code: 21, dataId: 0, value: 2 });
  assert.equal(hp(), 60);
  original.traits.at(-1).value = 3;
  assert.equal(hp(), 90);
  original.traits.splice(-1, 1);
  assert.equal(hp(), 30);
  let current = 42;
  Object.defineProperty(original.params[0], '1', { configurable: true, enumerable: true, get() { return current; } });
  assert.equal(hp(), 42); current = 43; assert.equal(hp(), 43);
  const replacement = { ...original, params: Array.from({ length: 8 }, () => [0, 70]) };
  scope.$dataClasses[1] = replacement;
  assert.equal(scope.$dataClasses[1], replacement);
  assert.equal(hp(), 70);
  const table = [null, { ...replacement, params: Array.from({ length: 8 }, () => [0, 80]) }];
  scope.$dataClasses = table;
  assert.equal(api.databaseInvoke(session, 'read', 'classes'), table);
  assert.equal(hp(), 80);
  delete table[1]; assert.equal(hp(), 1);
  table[1] = replacement; assert.equal(hp(), 70);
  assert.equal(original.params[0][1], 43, 'replaced records retain their own identity and contents');
  replacement.metadata = { owner: replacement };
  const saved = api.save(session);
  replacement.params[0][1] = 90;
  api.load(session, saved);
  assert.equal(hp(), 90, 'save loading preserves the live database binding');
  assert.equal(scope.$dataClasses, table);
  const fileRecord = { ...replacement }; delete fileRecord.metadata;
  fs.writeFileSync(path.join(root, 'data/ClassesReload.json'), JSON.stringify([null, { ...fileRecord, params: Array.from({ length: 8 }, () => [0, 120]) }]));
  scope.DataManager.loadDataFile('$dataClasses', 'ClassesReload.json');
  assert.equal(hp(), 120);
  assert.equal(runtime.database.isReady(), true);
  fs.writeFileSync(path.join(root, 'data/Extra.json'), '{"value":17}');
  scope.DataManager.loadDataFile('$dataExtra', 'Extra.json');
  assert.equal(api.databaseInvoke(session, 'read', 'plugin:$dataExtra'), scope.$dataExtra);
  assert.equal(runtime.database.isReady(), true);
});

test('native initialization and common events consume current database contents', t => {
  const { session, scope } = setup(t);
  scope.$dataActors[1].name = 'Database edit';
  scope.$dataActors[2].name = 'Late actor';
  assert.equal(api.entityField(api.entity(session, 'actor', 1), 'name'), 'Actor 1');
  assert.equal(api.entityField(api.entity(session, 'actor', 2), 'name'), 'Late actor');
  scope.$dataCommonEvents[1].list[0].parameters[4] = 7;
  scope.$gameTemp.reserveCommonEvent(1);
  for (let frame = 0; frame < 10 && api.snapshot(session).variables[20] !== 7; ++frame) api.step(session, {});
  assert.equal(api.snapshot(session).variables[20], 7);
  scope.$dataCommonEvents.push({ id: 2, list: [command(122, [21, 21, 0, 0, 9]), command(0)] });
  scope.$gameTemp.reserveCommonEvent(2);
  for (let frame = 0; frame < 10 && api.snapshot(session).variables[21] !== 9; ++frame) api.step(session, {});
  assert.equal(api.snapshot(session).variables[21], 9);
});

test('native battle costs and held records see gameplay edits across script callbacks', t => {
  const { session, scope } = setup(t, data => {
    data.classes[1].params[1][1] = 100;
    data.skills[2] = { id: 2, stypeId: 1, hitType: 1, successRate: 100, scope: 1, occasion: 0, mpCost: 5,
      damage: { type: 1, formula: '1', variance: 0, critical: false, elementId: 0 }, effects: [] };
    data.enemies = [null, { name: 'Enemy', params: [100, 20, 10, 10, 10, 10, 10, 10], actions: [], traits: [] }];
    data.troops = [null, { members: [{ enemyId: 1, x: 100, y: 100 }], pages: [] }];
  });
  scope.$dataSkills[2].mpCost = 23;
  api.setRandomStream(session, Array(1000).fill(0.5));
  api.startBattle(session, 1, true, true); api.acknowledge(session);
  for (let frame = 0; frame < 120 && !scope.BattleManager.isInputting(); ++frame) api.step(session, {});
  assert.equal(scope.BattleManager.isInputting(), true);
  let calls = 0;
  scope.Game_Action.prototype.itemHit = function() {
    ++calls;
    const item = scope.$dataSkills[2];
    item.damage.formula = '7';
    scope.$dataSkills[2] = { ...item, damage: { ...item.damage, formula: '19' } };
    assert.equal(api.databaseInvoke(session, 'read', 'skills'), scope.$dataSkills);
    api.snapshot(session);
    global.gc();
    return 1;
  };
  scope.Game_Action.prototype.itemEva = () => 0;
  api.chooseAction(session, 0, 2, 0, false);
  for (let frame = 0; frame < 120 && !calls; ++frame) { api.acknowledge(session); api.step(session, {}); }
  assert.equal(calls, 1);
  const state = api.snapshot(session);
  assert.equal(state.actors[1].mp, 77, 'native execution charges the edited skill cost');
  assert.equal(state.battle.enemies[0].hp, 93, 'the action keeps its original record while reading its edited damage');
  assert.equal(scope.$dataSkills[2].damage.formula, '19');
});

test('successive startup publications retain live bindings for earlier tables', t => {
  const data = fixture([]), session = api.create(data);
  t.after(() => api.dispose(session));
  const classes = { classes: data.classes }, actors = { actors: data.actors };
  api.databaseInvoke(session, 'publish', classes);
  api.databaseInvoke(session, 'publish', actors);
  api.newGame(session);
  data.classes[1].params[0][1] = 35;
  assert.equal(api.snapshot(session).actors[1].parameters[0], 35);
  assert.equal(api.databaseInvoke(session, 'read', 'classes'), data.classes);
  api.actorInvoke(session, api.entity(session, 'actor', 1), 'recoverAll');
  const saved = api.save(session); api.load(session, saved);
  assert.equal(api.snapshot(session).actors[1].hp, 35);
  delete classes.classes;
  assert.equal(api.snapshot(session).actors[1].parameters[0], 1);
});

test('native-owned audio remains a snapshot of database parameters', t => {
  const { session, scope } = setup(t, data => {
    data.system.titleBgm = { name: 'Title', volume: 90, pitch: 100, pan: 0 };
  });
  api.openTitle(session);
  scope.$dataSystem.titleBgm.volume = 5;
  assert.equal(api.save(session).system._bgmOnSave.volume, 90);
});

test('replaced records and database-owned session cycles can be collected', async t => {
  const { session, scope } = setup(t);
  let record = scope.$dataClasses[1];
  const old = new WeakRef(record);
  api.snapshot(session);
  scope.$dataClasses[1] = { ...record, params: Array.from({ length: 8 }, () => [0, 50]) };
  record = null;
  api.snapshot(session);
  const orphan = (() => {
    const data = fixture([]), object = api.create(data), tables = { classes: data.classes };
    api.databaseInvoke(object, 'publish', tables);
    tables.session = object;
    return new WeakRef(object);
  })();
  for (let cycle = 0; cycle < 3; ++cycle) { await new Promise(resolve => setImmediate(resolve)); global.gc(); }
  assert.equal(old.deref(), undefined);
  assert.equal(orphan.deref(), undefined, 'database references do not root a session through its own JavaScript graph');
});
