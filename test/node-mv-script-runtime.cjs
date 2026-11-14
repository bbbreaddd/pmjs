'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const api = require(require('node:path').resolve(process.argv[2])).mvEngine;
const { createScriptRuntime } = require('../runner/mv-script-runtime.cjs');
const { fixture, command, variable } = require('./helpers/mv-session-fixture.cjs');
const show = (name = 'Sheet') => command(231, [1, name, 0, 0, 0, 0, 100, 100, 255, 0]);
function create(t, program) {
  const session = api.create(fixture(program));
  t.after(() => api.dispose(session));
  const runtime = createScriptRuntime(api, session);
  api.newGame(session);
  return { session, scope: runtime.scope, step: () => api.step(session, {}) };
}

test('script variables and switches share native state and dispatch setter overrides', t => {
  const { session, scope, step } = create(t, [variable(3, 4.8), command(355, [
    'if ($gameVariables.value(3) !== 4) throw new Error("native variable not visible");\n' +
    '$gameVariables.setValue(5, -1.2); $gameSwitches.setValue(3, true);'
  ]), variable(6, 33)]);
  const setter = scope.Game_Variables.prototype.setValue, onChange = scope.Game_Variables.prototype.onChange;
  let writes = 0, changes = 0;
  scope.Game_Variables.prototype.setValue = function(...args) { ++writes; return setter.apply(this, args); };
  scope.Game_Variables.prototype.onChange = function() { ++changes; return onChange.call(this); };
  step();
  assert.equal(writes, 3); assert.equal(changes, 3);
  assert.equal(scope.$gameVariables.value(5), -2);
  assert.equal(api.snapshot(session).variables[6], 33);
  assert.equal(api.snapshot(session).switches[3], true);
  scope.$gameVariables.setValue(1000, 7); assert.equal(changes, 3);
  assert.throws(() => scope.$gameVariables.setValue(8, []), /object variable assignment/);
});

test('raw game-data arrays preserve sparse indexes and bypass setter callbacks', t => {
  const { session, scope } = create(t, []);
  const variables = scope.$gameVariables, switches = scope.$gameSwitches;
  let changes = 0; scope.Game_Switches.prototype.onChange = function() { ++changes; };
  const data = switches._data;
  data[13] = true; assert.equal(switches.value(13), true); assert.equal(changes, 0);
  assert.equal(data.length, 14); assert.equal(0 in data, false);
  delete data[13]; assert.equal(data.length, 14); assert.equal(switches.value(13), false);
  data.length = 20;
  assert.equal(api.save(session).switches._data.length, 20);
  variables._data[4] = 3.5; assert.equal(variables.value(4), 3.5);
  variables.setValue(4, 8.9); assert.equal(variables._data[4], 8);
  variables._data = [, , 9];
  assert.equal(variables._data.length, 3); assert.deepEqual(Object.keys(variables._data), ['2']);
  assert.equal(variables.value(4), 0); assert.equal(variables.value(2), 9);
  assert.throws(() => { variables._data = [1, {}]; }, /object variable assignment/);
  assert.equal(variables.value(2), 9); assert.equal(variables._data.length, 3);
  switches.clear(); assert.equal(data.length, 0);
  assert.equal(Array.isArray(data), true);
  const before = variables._data.length;
  assert.throws(() => { variables._data.length = 1.5; }, /array length/);
  assert.equal(variables._data.length, before);
});

test('screen and self-switch script methods operate on the native save state', t => {
  const { session, scope, step } = create(t, [command(223, [[10, 20, 30, 0], 0, false]), command(355, [
    '$gameScreen.startTint([40, 50, 60, 0], 0);\n' +
    '$gameScreen.showPicture(1, "Sheet", 0, 3, 4, 100, 100, 255, 0);\n' +
    '$gameSelfSwitches.setValue([1, 1, "A"], true);'
  ])]);
  const startTint = scope.Game_Screen.prototype.startTint;
  let tints = 0;
  scope.Game_Screen.prototype.startTint = function(...args) { ++tints; return startTint.apply(this, args); };
  step();
  assert.equal(tints, 2);
  assert.equal(scope.$gameScreen.picture(1)._x, 3);
  assert.equal(scope.$gameSelfSwitches.value([1, 1, 'A']), true);
  const saved = api.save(session);
  assert.deepEqual(saved.screen._tone, [40, 50, 60, 0]);
  assert.equal(saved.selfSwitches._data['1,1,A'], true);
});

test('script variable operands evaluate with the current native interpreter', t => {
  const { session, step } = create(t, [command(122, [7, 7, 0, 4, 'this._eventId']),
    command(122, [8, 8, 0, 4, 'var local = $gameVariables.value(7); local + 6'])]);
  step();
  assert.equal(api.snapshot(session).variables[7], 1);
  assert.equal(api.snapshot(session).variables[8], 7);
});

test('movement scripts dispatch on native characters and can retain a route command until arrival', t => {
  const route = { list: [{ code: 45, parameters: ['approach'] }, { code: 0, parameters: [] }], repeat: false, skippable: false, wait: true };
  const { scope, step } = create(t, [command(205, [-1, route])]);
  scope.$gameMap.event(1).locate(3, 3);
  const player = scope.$gamePlayer;
  let calls = 0;
  scope.Game_Character.prototype.processMoveRouteScriptCall = function(source) {
    assert.equal(this, player); assert.equal(source, 'approach'); ++calls;
    const direction = this.findDirectionTo(4, 1);
    if (direction) { this.moveStraight(direction); assert.equal(this.isMoving(), true); }
    if (this.x !== 4 || this.y !== 1) this._moveRouteIndex -= 1;
    this.setMovementSuccess(true);
  };
  for (let i = 0; i < 80; ++i) step();
  assert.equal(player.x, 4); assert.equal(calls, 3);
  assert.equal(player.isMoving(), false); assert.equal(player.isDashing(), false);
});

test('ordinary movement scripts bind the character and preserve thrown exceptions', t => {
  const route = { list: [{ code: 45, parameters: ['if (routeFailure) throw routeFailure; this.setDirection(6);'] }, { code: 0 }], repeat: false, skippable: false, wait: true };
  const { scope, step } = create(t, [command(205, [-1, route])]);
  const failure = new Error('route failure'); scope.routeFailure = failure;
  assert.throws(step, error => error === failure);
  assert.equal(scope.$gamePlayer._moveRouteIndex, 0);
  scope.routeFailure = null;
  for (let i = 0; i < 4; ++i) step();
  assert.equal(scope.$gamePlayer.direction(), 6);
});

test('native actor skill initialization dispatches script extensions for initial and lazy actors', t => {
  const session = api.create(fixture([])); t.after(() => api.dispose(session));
  const { scope } = createScriptRuntime(api, session);
  const initialize = scope.Game_Actor.prototype.initSkills;
  let calls = 0;
  scope.Game_Actor.prototype.initSkills = function() {
    initialize.call(this); this.equipped = [0, 0, 0, 0]; ++calls;
  };
  api.newGame(session);
  const actor = scope.$gameActors.actor(1);
  assert.equal(calls, 1); assert.deepEqual(actor.equipped, [0, 0, 0, 0]);
  actor.equipped[0] = 2;
  assert.deepEqual(api.save(session).actors._data[1]._skills, [2]);
  assert.equal(scope.$gameActors.actor(1), actor); assert.equal(actor.equipped[0], 2);
  const second = scope.$gameActors.actor(2);
  assert.equal(calls, 2); assert.deepEqual(second.equipped, [0, 0, 0, 0]);
});

test('new-game screen initialization dispatches plugin reset methods and saved originals', t => {
  const session = api.create(fixture([])); t.after(() => api.dispose(session));
  const { scope } = createScriptRuntime(api, session);
  const systemInit = scope.Game_System.prototype.initialize, tempInit = scope.Game_Temp.prototype.initialize;
  const initialized = [];
  scope.Game_System.prototype.initialize = function() { systemInit.call(this); this.pluginWeather = []; initialized.push('system'); };
  scope.Game_Temp.prototype.initialize = function() { tempInit.call(this); this.pluginCache = {}; initialized.push('temp'); };
  const clear = scope.Game_Screen.prototype.clear, shake = scope.Game_Screen.prototype.clearShake;
  const calls = [];
  scope.Game_Screen.prototype.clear = function() { calls.push('clear'); clear.call(this); this.effectReady = true; };
  scope.Game_Screen.prototype.clearShake = function() { calls.push('shake'); shake.call(this); this.vector = { x: 0, y: 0 }; };
  api.newGame(session);
  assert.deepEqual(calls, ['clear', 'shake']); assert.equal(scope.$gameScreen.effectReady, true);
  assert.deepEqual(initialized, ['temp', 'system']); assert.deepEqual(scope.$gameSystem.pluginWeather, []); assert.deepEqual(scope.$gameTemp.pluginCache, {});
  assert.equal(scope.$gameScreen.vector.x, 0); assert.equal(scope.$gameScreen.shake(), 0);
  const updateShake = scope.Game_Screen.prototype.updateShake;
  let updates = 0;
  scope.Game_Screen.prototype.updateShake = function() { ++updates; updateShake.call(this); };
  scope.$gameScreen.startShake(5, 5, 2); scope.$gameScreen.update();
  assert.equal(updates, 1); assert.equal(scope.$gameScreen._shakeDuration, 1);
  assert.equal(scope.$gameScreen._shake, scope.$gameScreen.shake());
  scope.$gameScreen._shake = 7; assert.equal(scope.$gameScreen.shake(), 7);
  scope.$gameScreen.showPicture(1, 'Test', 0, 0, 0, 100, 100, 255, 0);
  const picture = scope.$gameScreen.picture(1);
  scope.$gameScreen.clearPictures(); assert.equal(scope.$gameScreen.picture(1), null);
  assert.equal(picture.name(), 'Test');
});

test('native actor image initialization invokes plugin aliases before refresh', t => {
  const data = fixture([]); data.actors[1].faceName = 'ActorFace'; data.actors[1].faceIndex = 3;
  const session = api.create(data); t.after(() => api.dispose(session));
  const { scope } = createScriptRuntime(api, session);
  for (const key of ['actors', 'classes', 'weapons', 'armors', 'states', 'system', 'items', 'skills']) scope['$data' + key[0].toUpperCase() + key.slice(1)] = data[key];
  const original = scope.Game_Actor.prototype.initImages;
  let calls = 0;
  scope.Game_Actor.prototype.initImages = function() { original.call(this); this.defaultFace = this.faceName(); ++calls; };
  api.newGame(session);
  const actor = scope.$gameActors.actor(1);
  assert.equal(calls, 1); assert.equal(actor.defaultFace, 'ActorFace'); assert.equal(actor.faceIndex(), 3);
  actor.setFaceImage('Changed', 1); actor.initImages(); assert.equal(actor.faceName(), 'ActorFace');
  actor.setMp(1); actor.gainMp(3); assert.equal(actor.mp, 4);
  assert.equal(actor._result, actor.result());
  assert.equal(api.save(session).actors._data[1]._result.mpDamage, -3);
  const item = actor._equips[0]; item.setObject(null);
  assert.equal(api.save(session).actors._data[1]._equips[0]._itemId, 0);
  scope.$gameParty.gainItem(scope.$dataWeapons[1], 1); actor.changeEquip(0, scope.$dataWeapons[1]);
  assert.equal(actor.equips()[0], scope.$dataWeapons[1]); assert.equal(scope.$gameParty.numItems(scope.$dataWeapons[1]), 0);
});

test('battler database lookups retain script object identity and native class changes', t => {
  const data = fixture([command(321, [1, 2, false])]);
  data.classes[1].expParams = [30, 20, 30, 30];
  data.classes.push({ ...data.classes[1], name: 'Second class' });
  const session = api.create(data); t.after(() => api.dispose(session));
  const runtime = createScriptRuntime(api, session);
  const { scope } = runtime;
  scope.$dataActors = data.actors; scope.$dataClasses = data.classes;
  api.newGame(session);
  const actor = scope.$gameActors.actor(1);
  assert.equal(actor.actor(), data.actors[1]);
  assert.equal(actor.currentClass(), data.classes[1]);
  const original = scope.Game_Actor.prototype.currentClass;
  let calls = 0;
  scope.Game_Actor.prototype.currentClass = function() { ++calls; return original.call(this); };
  api.step(session, {});
  assert.equal(actor.currentClass(), data.classes[2]); assert.equal(calls, 1);
  actor._classId = 1;
  assert.equal(api.save(session).actors._data[1]._classId, 1);
  data.actors[1].pluginValue = 42;
  assert.equal(actor.actor().pluginValue, 42);
});

test('database type checks use table identity and preserve null results', t => {
  const data = fixture([]);
  const session = api.create(data); t.after(() => api.dispose(session));
  const runtime = createScriptRuntime(api, session);
  const manager = runtime.scope.DataManager;
  for (const [method, key] of [['isSkill', 'skills'], ['isItem', 'items'], ['isWeapon', 'weapons'], ['isArmor', 'armors']]) {
    runtime.scope['$data' + key[0].toUpperCase() + key.slice(1)] = data[key];
    assert.equal(manager[method](data[key][1]), true);
    assert.equal(manager[method]({ ...data[key][1] }), false);
    assert.equal(manager[method](null), null);
    assert.equal(manager[method](undefined), undefined);
  }
});

test('battler state and parameter arrays remain live across native commands and saved aliases', t => {
  const data = fixture([]);
  data.states.push({ id: 2, priority: 50, restriction: 2, minTurns: 2, maxTurns: 2, iconIndex: 19,
    traits: [{ code: 22, dataId: 1, value: 0.25 }, { code: 23, dataId: 4, value: 0.5 }] });
  const session = api.create(data); t.after(() => api.dispose(session));
  const { scope } = createScriptRuntime(api, session);
  for (const [name, value] of Object.entries(data)) scope['$data' + name[0].toUpperCase() + name.slice(1)] = value;
  api.newGame(session);
  const actor = scope.$gameActors.actor(1), states = actor._states;
  states.pluginTag = { retained: true };
  const original = scope.Game_Battler.prototype.addState;
  scope.Game_Battler.prototype.addState = function(id) { original.call(this, id); this.pluginState = id; };
  actor.addState(2);
  const result = actor.result();
  assert.equal(result instanceof scope.Game_ActionResult, true);
  assert.equal(result.addedStateObjects()[0], data.states[2]);
  result.hpDamage = 7; result.pushAddedBuff(2); result.pushAddedBuff(2);
  assert.equal(api.save(session).actors._data[1]._result.hpDamage, 7);
  assert.deepEqual(api.save(session).actors._data[1]._result.addedBuffs, [2]);
  assert.equal(actor._states, states); assert.deepEqual(Array.from(states), [2]);
  assert.equal(actor._states.pluginTag.retained, true);
  assert.equal(actor.states()[0], data.states[2]); assert.equal(actor.pluginState, 2);
  assert.equal(actor.isConfused(), true); assert.equal(actor.eva, 0.25);
  assert.equal(actor.skillMpCost({ mpCost: 7 }), 3);
  assert.deepEqual(Array.from(actor.stateIcons()), [19]);
  actor._buffs[2] = 1; actor._paramPlus[2] = 3;
  assert.equal(actor.atk, 16);
  assert.equal(api.save(session).actors._data[1]._buffs[2], 1);
  actor.removeState(2);
  assert.deepEqual(Array.from(states), []); assert.equal(actor.isConfused(), false);
  states.push(2); assert.equal(actor.isStateAffected(2), true);
  assert.deepEqual(api.save(session).actors._data[1]._states, [2]);
  assert.throws(() => { actor._buffs = [1]; }, /eight entries/);
  assert.equal(actor._buffs.length, 8);
  actor.recoverAll(); assert.deepEqual(Array.from(states), []);
  actor.clearResult(); assert.equal(actor.result(), result); assert.equal(result.isStatusAffected(), false);
  actor.hide(); assert.equal(actor.isAlive(), false); actor.appear(); assert.equal(actor.isAlive(), true);
});

test('actor skills, equipment identity and image fields share native save state', t => {
  const data = fixture([]), session = api.create(data); t.after(() => api.dispose(session));
  const { scope } = createScriptRuntime(api, session);
  for (const [name, value] of Object.entries(data)) scope['$data' + name[0].toUpperCase() + name.slice(1)] = value;
  api.newGame(session);
  const actor = scope.$gameActors.actor(1);
  assert.equal(actor.weapons()[0], data.weapons[1]); assert.equal(actor.hasArmor(data.armors[1]), true);
  actor.learnSkill(1); assert.deepEqual(Array.from(actor.skills()), [data.skills[1], data.skills[2]]);
  actor.forgetSkill(2); assert.equal(actor.isLearnedSkill(2), false);
  actor.setFaceImage('Portrait', 3); actor.setProfile('Profile');
  const saved = api.save(session).actors._data[1];
  assert.deepEqual(saved._skills, [1]); assert.equal(saved._faceName, 'Portrait'); assert.equal(saved._faceIndex, 3);
  assert.equal(actor.profile(), 'Profile');
});

test('party methods share native inventory, equipment, gold and membership', t => {
  const data = fixture([]), session = api.create(data); t.after(() => api.dispose(session));
  const runtime = createScriptRuntime(api, session), { scope } = runtime;
  for (const [name, value] of Object.entries(data)) scope['$data' + name[0].toUpperCase() + name.slice(1)] = value;
  api.newGame(session);
  const party = scope.$gameParty, actor = scope.$gameActors.actor(1);
  assert.equal(party instanceof scope.Game_Unit, true);
  assert.equal(runtime.runScript('$gameParty.members() instanceof Array && $gameParty.members().contains($gameActors.actor(1))'), true);
  assert.equal(runtime.runScript('$gameActors.actor(1)._states instanceof Array'), true);
  party.addActor(2); party.swapOrder(0, 1);
  assert.equal(party.leader(), scope.$gameActors.actor(2));
  party.removeActor(2); assert.equal(party.size(), 1);
  party.setMenuActor(actor); assert.equal(party.menuActor(), actor);
  party.gainGold(30); party.loseGold(8); assert.equal(api.save(session).party._gold, 22);
  party.increaseSteps(); assert.equal(party.steps(), 1);
  const original = scope.Game_Party.prototype.gainItem;
  scope.Game_Party.prototype.maxItems = function() { return 3; };
  scope.Game_Party.prototype.gainItem = function(...args) { original.apply(this, args); this.lastGain = args[0]; };
  party.gainItem(data.items[1], 9); assert.equal(party.numItems(data.items[1]), 3);
  assert.equal(party.items()[0], data.items[1]); assert.equal(party.lastGain, data.items[1]);
  assert.equal(api.save(session).party._items[1], 3);
  assert.equal(party.hasItem(data.weapons[1], true), true);
  party.loseItem(data.weapons[1], 1, true);
  assert.equal(actor.hasWeapon(data.weapons[1]), false);
  assert.equal(api.save(session).actors._data[1]._equips[0]._itemId, 0);
});

test('map queries use native events and system helpers update native counters', t => {
  const data = fixture([]); data.maps[1].displayName = 'Area'; data.maps[1].encounterStep = 30;
  data.system.locale = 'zh_CN'; data.system.versionId = 42;
  const session = api.create(data); t.after(() => api.dispose(session));
  const { scope } = createScriptRuntime(api, session); scope.$dataSystem = data.system;
  api.newGame(session);
  const map = scope.$gameMap, system = scope.$gameSystem, event = map.event(1);
  assert.equal(map.width(), 5); assert.equal(map.tileWidth(), 48); assert.equal(map.displayName(), 'Area');
  assert.equal(map.events()[0], event); assert.equal(map.eventsXyNt(3, 1)[0], event);
  event._through = true; assert.equal(map.eventsXyNt(3, 1).length, 0);
  assert.equal(map.eventsXy(3, 1)[0], event);
  assert.equal(Boolean(system.isChinese()), true); assert.equal(system.isKorean(), null); assert.equal(system.versionId(), 0);
  system.onBattleStart(); system.onBattleWin(); system.onBattleEscape();
  const saved = api.save(session).system;
  assert.equal(system.versionId(), 42);
  assert.equal(saved._battleCount, 1); assert.equal(saved._winCount, 1); assert.equal(saved._escapeCount, 1);
  assert.equal(system.playtimeText(), '00:00:00');
});

test('action queries honor authored scopes and dispatch global effects into native game state', t => {
  const data = fixture([]);
  data.skills[2] = { id: 2, scope: 4, hitType: 1, tpGain: 12, damage: { type: 5, elementId: -1, critical: true },
    effects: [{ code: 44, dataId: 1 }] };
  data.classes[1].traits.push({ code: 22, dataId: 2, value: 0.3 });
  const session = api.create(data); t.after(() => api.dispose(session));
  const { scope } = createScriptRuntime(api, session);
  for (const [name, value] of Object.entries(data)) scope['$data' + name[0].toUpperCase() + name.slice(1)] = value;
  api.newGame(session);
  const actor = scope.$gameActors.actor(1), action = new scope.Game_Action(actor);
  action.setItemObject(data.skills[2]);
  assert.equal(action.isForOpponent(), true); assert.equal(action.isForRandom(), true); assert.equal(action.numTargets(), 2);
  assert.equal(action.needsSelection(), false); assert.equal(action.isDrain(), true); assert.equal(action.isHpEffect(), true);
  assert.equal(action.isPhysical(), true); assert.equal(action.itemCri({ cev: 0.2 }), 0.24);
  action.applyGlobal(); assert.equal(scope.$gameTemp.reservedCommonEvent(), data.commonEvents[1]);
  action.applyItemUserEffect(); assert.equal(actor.tp, 12);
  action.makeSuccess(actor); assert.equal(api.save(session).actors._data[1]._result.success, true);
  action.setAttack(); assert.equal(action.item(), data.skills[1]);
});

test('scripted movement routes and jumps use native character state', t => {
  const { session, scope, step } = create(t, []);
  const player = scope.$gamePlayer;
  player.setMoveSpeed(6); assert.equal(player.realMoveSpeed(), 6);
  player.setThrough(true); player.setTransparent(true);
  player.forceMoveRoute({ list: [{ code: scope.Game_Character.ROUTE_SCRIPT, parameters: ['this.setDirection(6); this.setPattern(2);'] },
    { code: 0 }], repeat: false, skippable: false });
  step(); assert.equal(player.direction(), 6);
  assert.equal(api.save(session).player._pattern, 2);
  assert.equal(api.save(session).player._through, true);
  player.jump(1, 0); assert.equal(player.isJumping(), true);
  assert.equal(player.x, 2); assert.equal(Number.isFinite(player.screenY()), true);
});

test('party dictionaries expose native inventory and import category snapshots atomically', t => {
  const { scope, step, session } = create(t, [command(126, [1, 0, 0, 3])]);
  step();
  const party = scope.$gameParty;
  assert.equal(party._items[1], 3);
  assert.deepEqual(Object.assign({}, party._items), { 1: 3 });
  party._weapons = { 1: 2 }; party._items = { 1: 8 };
  assert.equal(api.snapshot(session).inventory[1], 8);
  assert.equal(api.snapshot(session).inventory[100001], 2);
  party._items[1] = 4; assert.equal(api.snapshot(session).inventory[1], 4);
  assert.throws(() => { party._items = { 1: 99, invalid: 2 }; });
  assert.equal(party._items[1], 4);
  delete party._items[1]; assert.equal(party._items[1], undefined);
  assert.equal(Object.keys(party._items).length, 0);
  assert.equal(party.members()[0], scope.$gameActors.actor(1));
});

test('party initialization overrides reset custom fields with new game', t => {
  const session = api.create(fixture([])); t.after(() => api.dispose(session));
  const { scope } = createScriptRuntime(api, session);
  const original = scope.Game_Party.prototype.initialize;
  let calls = 0;
  scope.Game_Party.prototype.initialize = function() { original.call(this); this.worlds = {}; ++calls; };
  api.newGame(session); scope.$gameParty.worlds[1] = 'retained';
  api.newGame(session);
  assert.equal(calls, 2); assert.deepEqual(scope.$gameParty.worlds, {});
});

test('native entity views stay live and retained views survive world replacement and disposal', t => {
  const database = fixture([]); database.maps[2] = structuredClone(database.maps[1]);
  const session = api.create(database); let disposed = false;
  t.after(() => { if (!disposed) api.dispose(session); });
  const { scope } = createScriptRuntime(api, session); api.newGame(session);
  const player = scope.$gamePlayer, event = scope.$gameMap.event(1), actor = scope.$gameActors.actor(1);
  assert.equal(actor, scope.$gameActors.actor(1)); assert.equal(scope.$gameActors.actor(999), null);
  player.locate(2, 2); event.locate(4, 2); actor._hp = 6;
  assert.equal(api.snapshot(session).player.x, 2); assert.equal(api.snapshot(session).actors[1].hp, 6);
  api.playerTransfer(session, 'reserve', 2, 1, 1, 2, 2); api.playerTransfer(session, 'perform');
  assert.equal(player, scope.$gamePlayer); assert.equal(player.x, 1);
  assert.equal(event.x, 4); assert.notEqual(event, scope.$gameMap.event(1));
  assert.equal(actor, scope.$gameActors.actor(1));
  api.newGame(session);
  assert.notEqual(player, scope.$gamePlayer); assert.notEqual(actor, scope.$gameActors.actor(1));
  player._x = 4; actor._hp = 3;
  assert.equal(scope.$gamePlayer.x, 1); assert.notEqual(scope.$gameActors.actor(1).hp, 3);
  api.dispose(session); disposed = true;
  assert.equal(event.x, 4); assert.equal(player.x, 4); assert.equal(actor.hp, 3);
  assert.equal(actor.isStateAffected(1), false);
});

test('native frame dispatch reaches nested instance overrides and saved native originals once', t => {
  const { session, scope, step } = create(t, [show(), command(355, [
    'const p = $gameScreen.picture(1); p._rotationSpeed = 2; p.updateMove = function() { this._x += 3; };'
  ]), command(230, [8])]);
  const base = scope.Game_Picture.prototype.update;
  const trace = [];
  scope.Game_Picture.prototype.update = function() { trace.push('before'); base.call(this); trace.push('after'); };
  step();
  const picture = scope.$gameScreen.picture(1);
  assert.equal(picture, scope.$gameScreen.picture(1));
  assert.equal(picture._x, 3);
  assert.equal(picture._angle, 1);
  assert.deepEqual(trace, ['before', 'after']);
  const custom = { values: [1], call: () => 7 }; custom.self = custom;
  picture.extension = custom;
  step();
  assert.equal(picture._x, 6);
  assert.equal(picture.extension, custom);
  assert.equal(picture.extension.call(), 7);
  picture.updateMove = function() { this._x += 5; };
  step();
  assert.equal(picture._x, 11);
  assert.equal(api.save(session).screen._pictures[1]._x, 11);
});

test('native interpreter waits for a script-driven finite picture animation', t => {
  const { session, scope, step } = create(t, [show(), command(355, [
    'const p = $gameScreen.picture(1); p.framesRemaining = 3; this.setWaitMode("frames");'
  ]), variable(9, 99), command(230, [8])]);
  const originalPicture = scope.Game_Picture.prototype.update;
  scope.Game_Picture.prototype.update = function() {
    originalPicture.call(this);
    if (this.framesRemaining > 0) this.framesRemaining--;
  };
  const nativeWait = scope.Game_Interpreter.prototype.updateWaitMode;
  scope.Game_Interpreter.prototype.updateWaitMode = function() {
    if (this._waitMode === 'frames' && scope.$gameScreen.picture(1).framesRemaining > 0) return true;
    return nativeWait.call(this);
  };
  step(); step();
  assert.equal(api.snapshot(session).variables[9], undefined);
  step();
  assert.equal(scope.$gameScreen.picture(1).framesRemaining, 0);
  assert.equal(api.snapshot(session).variables[9], undefined);
  step();
  assert.equal(api.snapshot(session).variables[9], 99);
});

test('loading native pictures restores state and keeps script dispatch connected', t => {
  const { session, scope, step } = create(t, [show(), command(230, [20])]);
  step();
  const previous = scope.$gameScreen.picture(1);
  previous._x = 42;
  const saved = api.save(session);
  api.load(session, saved);
  const restored = scope.$gameScreen.picture(1);
  assert.notEqual(restored, previous);
  assert.equal(restored._x, 42);
  restored.updateMove = function() { this._x++; };
  step();
  assert.equal(restored._x, 43);
  assert.equal(previous._x, 42);
});

test('native replacement preserves retained picture state without aliasing the new object', t => {
  const { scope, step } = create(t, [show(), command(230, [1]), command(235, [1]), show('Other'), command(230, [8])]);
  step();
  const old = scope.$gameScreen.picture(1);
  old.extension = { alive: true }; old._x = 15;
  step(); step();
  const current = scope.$gameScreen.picture(1);
  assert.notEqual(current, old);
  current._x = 99;
  assert.equal(old._x, 15);
  assert.equal(old.extension.alive, true);
  assert.equal(current._x, 99);
});

test('event picture operations dispatch arguments and native tint arrays stay live across replacement', t => {
  const { session, scope, step } = create(t, [show(), command(234, [1, [40, 20, 0, 0], 2, false]),
    command(232, [1, 0, 0, 0, 12, 6, 100, 100, 128, 0, 2, false]), command(233, [1, 4]), command(230, [20])]);
  const trace = [];
  for (const method of ['show', 'move', 'tint', 'rotate']) {
    const base = scope.Game_Picture.prototype[method];
    scope.Game_Picture.prototype[method] = function(...args) { trace.push([method, args]); base.apply(this, args); };
  }
  step();
  assert.deepEqual(trace.map(entry => entry[0]), ['show', 'tint', 'move', 'rotate']);
  assert.deepEqual(trace[1][1], [[40, 20, 0, 0], 2]);
  const picture = scope.$gameScreen.picture(1);
  const tone = picture.tone(), target = picture._toneTarget;
  assert.ok(Array.isArray(tone));
  assert.equal(tone, picture._tone);
  assert.deepEqual(tone.slice(), [20, 10, 0, 0]);
  assert.deepEqual(Object.keys(tone), ['0', '1', '2', '3']);
  tone[1] = 6;
  assert.deepEqual(api.save(session).screen._pictures[1]._tone, [20, 6, 0, 0]);
  step();
  assert.deepEqual(tone.slice(), [40, 20, 0, 0]);
  assert.equal(picture._x, 12);
  const input = [0, 60, 0, 0];
  picture.tint(input, 0);
  input[1] = 99;
  assert.notEqual(picture._tone, tone);
  assert.notEqual(picture._toneTarget, target);
  assert.deepEqual(picture._tone.slice(), [0, 60, 0, 0]);
  tone[0] = 90;
  assert.equal(picture._tone[0], 0);
  picture._toneTarget = tone;
  assert.equal(picture._toneTarget, tone);
  assert.throws(() => { picture._tone = [1, 2, 3, 4]; }, /native tone array/);
  assert.throws(() => { picture._tone.length = 2; }, TypeError);
  const saved = api.save(session);
  api.load(session, saved);
  assert.deepEqual(scope.$gameScreen.picture(1)._tone.slice(), [0, 60, 0, 0]);
  assert.deepEqual(scope.$gameScreen.picture(1)._toneTarget.slice(), [90, 20, 0, 0]);
});

test('native interpreter fields control real command position and nested wait dispatch', t => {
  const { session, scope, step } = create(t, [command(355, ['this.wait(2); this._index++;']),
    variable(8, 11), variable(9, 22), command(230, [20])]);
  let interpreter;
  const base = scope.Game_Interpreter.prototype.updateWait;
  const count = scope.Game_Interpreter.prototype.updateWaitCount;
  let countCalls = 0;
  scope.Game_Interpreter.prototype.updateWait = function() {
    interpreter = this;
    return base.call(this);
  };
  scope.Game_Interpreter.prototype.updateWaitCount = function() { countCalls++; return count.call(this); };
  step();
  assert.equal(interpreter.eventId(), 1);
  assert.equal(interpreter._mapId, 1);
  assert.equal(interpreter._depth, 0);
  assert.equal(interpreter.isRunning(), true);
  assert.equal(interpreter._waitCount, 1);
  assert.equal(api.snapshot(session).variables[9], undefined);
  interpreter.updateWaitCount = function() { this._waitCount = 0; return false; };
  step();
  assert.equal(api.snapshot(session).variables[8], undefined);
  assert.equal(api.snapshot(session).variables[9], 22);
  assert.ok(countCalls >= 2);
  assert.throws(() => { interpreter._index = -2; }, /supported range/);
  api.load(session, api.save(session));
  assert.throws(() => interpreter._index, /no longer attached/);
});

test('native plugin-command events reach wrapped script handlers with authored argument splitting', t => {
  const { session, scope, step } = create(t, [command(356, ['Curve  2 ']), variable(9, 7), command(230, [20])]);
  const native = scope.Game_Interpreter.prototype.pluginCommand;
  const calls = [];
  scope.Game_Interpreter.prototype.pluginCommand = function(name, args) {
    native.call(this, name, args);
    calls.push([name, args, this.eventId()]);
    this.wait(Number(args[1]));
  };
  step();
  assert.deepEqual(calls, [['Curve', ['', '2', ''], 1]]);
  assert.equal(api.snapshot(session).variables[9], undefined);
  step();
  assert.equal(api.snapshot(session).variables[9], undefined);
  step();
  assert.equal(api.snapshot(session).variables[9], 7);
});

test('live command and parameter views change native execution and retain replaced lists', t => {
  const program = [command(111, [0, 1, 1]), command(355, ['$inspect(this); this._branch[0] = false;'], 1),
    command(411), { ...variable(9, 99), indent: 1 }, command(412), command(230, [20])];
  const { session, scope, step } = create(t, program);
  let interpreter, list, parameters;
  scope.$inspect = value => {
    interpreter = value; list = value._list; parameters = value._params;
    assert.ok(Array.isArray(list));
    assert.equal(list, value._list);
    assert.equal(parameters, value.currentCommand().parameters);
    assert.equal(value.nextEventCode(), 411);
    assert.equal(value._indent, 1);
    assert.equal(value._branch[0], true);
    list[3].parameters[4] = 77;
    value._branch[5] = 2;
  };
  step();
  assert.equal(api.snapshot(session).variables[9], 77);
  assert.equal(program[3].parameters[4], 99);
  assert.equal(parameters[0], program[1].parameters[0]);
  assert.notEqual(parameters, interpreter._params);
  assert.equal(interpreter._params[0], 20);
  assert.deepEqual(Object.keys(interpreter._branch), ['5']);
  interpreter._branch[8] = true;
  assert.equal(api.save(session).map._interpreter._branch[8], true);
  delete interpreter._branch[5];
  assert.equal(5 in interpreter._branch, false);
  assert.equal(interpreter._branch[5], undefined);
  assert.throws(() => { list.length = 1; }, TypeError);
  assert.throws(() => { list[3].parameters = []; }, /scalar/);
  api.load(session, api.save(session));
  list[3].parameters[4] = 999;
  assert.equal(api.save(session).map._interpreter._list[3].parameters[4], 77);
  assert.equal(parameters[0], program[1].parameters[0]);
});

test('native experience and class commands dispatch progression aliases on the same actor state', t => {
  const data = fixture([command(315, [0, 1, 0, 0, 250, false]), command(230, [10])]);
  data.actors[1].maxLevel = 5;
  Object.assign(data.classes[1], { expParams: [0, 100, 0, 30], params: Array.from({ length: 8 }, () => [0, 10, 20, 30, 40, 50]), learnings: [{ level: 1, skillId: 2 }, { level: 2, skillId: 3 }] });
  data.classes.push({ ...data.classes[1], id: 2, learnings: [] });
  data.skills.push({ id: 3 });
  data.states.push({ id: 2, minTurns: 3, maxTurns: 3, stepsToRemove: 5, autoRemovalTiming: 2, restriction: 0, traits: [] });
  const session = api.create(data); t.after(() => api.dispose(session));
  const { scope } = createScriptRuntime(api, session);
  for (const key of ['actors', 'classes', 'weapons', 'armors', 'states', 'system', 'items', 'skills']) scope['$data' + key[0].toUpperCase() + key.slice(1)] = data[key];
  const trace = [], actors = [];
  for (const name of ['changeExp', 'levelUp', 'levelDown', 'learnSkill', 'refresh']) {
    const original = scope.Game_Actor.prototype[name];
    scope.Game_Actor.prototype[name] = function(...args) { trace.push([name, ...args]); actors.push(this); return original.apply(this, args); };
  }
  api.newGame(session); trace.length = 0; actors.length = 0;
  const actor = scope.$gameActors.actor(1), exp = actor._exp;
  api.step(session, {});
  assert.equal(actor.level, 3); assert.equal(actor.currentExp(), 250); assert.equal(exp[1], 250);
  assert.equal(actor.isLearnedSkill(3), true);
  assert.deepEqual(trace.map(row => row[0]), ['changeExp', 'levelUp', 'learnSkill', 'levelUp', 'refresh']);
  assert.deepEqual(trace[0], ['changeExp', 250, false]); assert.ok(actors.every(value => value === actor));
  actor.changeClass(2, false); assert.equal(actor.level, 1); assert.equal(actor.currentClass(), data.classes[2]);
  actor.changeClass(1, false); assert.equal(actor.level, 3); assert.equal(actor._exp, exp);
  actor.addState(2); assert.equal(actor._stateTurns[2], 3); assert.equal(actor._stateSteps[2], 5);
  actor.updateStateTurns(); actor.updateStateTurns(); actor.updateStateTurns(); actor.removeStatesAuto(2);
  assert.equal(actor.isStateAffected(2), false); assert.equal(actor.result().isStateRemoved(2), true);
  assert.equal(actor.isStateAddable(2), false); actor.clearResult(); assert.equal(actor.isStateAddable(2), true);
  assert.throws(() => { actor._stateTurns = { 2: {} }; }, /numbers/);
  const retained = actor; api.newGame(session); const replacement = scope.$gameActors.actor(1);
  trace.length = 0; actors.length = 0;
  retained.changeExp(400, false);
  assert.equal(retained.level, 5); assert.equal(replacement.level, 1); assert.ok(actors.every(value => value === retained));
});

test('map display and scrolling APIs share native camera and parallax state', t => {
  const data = fixture([]), map = data.maps[1];
  Object.assign(map, { width: 100, height: 80, scrollType: 3, parallaxLoopX: true, parallaxLoopY: true, parallaxSx: 4, parallaxSy: -2, data: Array(100 * 80 * 6).fill(0) });
  const session = api.create(data); t.after(() => api.dispose(session));
  const { scope } = createScriptRuntime(api, session); scope.Graphics = { width: 816, height: 624 };
  const original = scope.Game_Map.prototype.setDisplayPos;
  let centers = 0;
  scope.Game_Map.prototype.setDisplayPos = function(x, y) { ++centers; original.call(this, x, y); };
  api.newGame(session); assert.equal(centers, 1);
  const gameMap = scope.$gameMap;
  gameMap.setDisplayPos(99, 79); gameMap.scrollRight(3); gameMap.scrollDown(5);
  assert.equal(gameMap.displayX(), 2); assert.equal(gameMap.displayY(), 4);
  assert.equal(api.save(session).map._parallaxX, 102); assert.equal(api.save(session).map._parallaxY, 84);
  gameMap.updateParallax();
  assert.ok(Math.abs(api.save(session).map._parallaxX - (102 + 4 / 96)) < 1e-9);
  scope.$gamePlayer.center(50, 40); assert.equal(gameMap.displayX(), 42); assert.equal(gameMap.displayY(), 34);
  const plain = fixture([command(204, [6, 1, 4, false]), command(230, [10])]); Object.assign(plain.maps[1], { width: 100, height: 80, data: Array(100 * 80 * 6).fill(0) });
  const other = api.create(plain); t.after(() => api.dispose(other));
  const view = createScriptRuntime(api, other).scope; api.newGame(other);
  view.$gameMap.setDisplayPos(10, 12); view.$gameMap.scrollLeft(50); view.$gameMap.scrollUp(50);
  assert.equal(view.$gameMap.displayX(), 0); assert.equal(view.$gameMap.displayY(), 0);
  view.$gameMap.scrollRight(1000); view.$gameMap.scrollDown(1000);
  assert.equal(view.$gameMap.displayX(), 83); assert.equal(view.$gameMap.displayY(), 67);
  const scroll = view.Game_Map.prototype.scrollRight, parallax = view.Game_Map.prototype.updateParallax, distances = [];
  let parallaxUpdates = 0;
  view.Game_Map.prototype.scrollRight = function(distance) { distances.push(distance); scroll.call(this, distance); };
  view.Game_Map.prototype.updateParallax = function() { ++parallaxUpdates; parallax.call(this); };
  view.$gameMap.setDisplayPos(10, 12);
  for (let frame = 0; frame < 3; ++frame) api.step(other, {});
  assert.ok(distances.length > 0); assert.ok(distances.every(distance => distance === 1 / 16)); assert.equal(parallaxUpdates, 3);
});

test('message input getters expose native number and item event requests', t => {
  const number = create(t, [command(103, [7, 3])]); number.step();
  assert.equal(number.scope.$gameMessage.numInputVariableId(), 7); assert.equal(number.scope.$gameMessage.numInputMaxDigits(), 3);
  const item = create(t, [command(104, [9, 2])]); item.step();
  assert.equal(item.scope.$gameMessage.itemChoiceVariableId(), 9); assert.equal(item.scope.$gameMessage.itemChoiceItypeId(), 2);
});

test('interpreter utility APIs operate on native variables and resolve current-map characters', t => {
  const { scope, session } = create(t, []);
  const interpreter = scope.$gameMap._interpreter;
  interpreter.operateVariable(3, 0, 7);
  interpreter.operateVariable(3, 1, 4);
  interpreter.operateVariable(3, 3, 2);
  assert.equal(api.snapshot(session).variables[3], 22);
  assert.equal(interpreter.operateValue(1, 1, 3), -22);
  assert.equal(interpreter.gameDataOperand(7, 0, 0), scope.$gameMap.mapId());
  assert.equal(interpreter.gameDataOperand(3, 1, 2), scope.$gameActors.actor(1).hp);
  interpreter.operateVariable(3, 4, 4);
  assert.equal(scope.$gameVariables.value(3), 5);
  assert.equal(interpreter.character(-1), scope.$gamePlayer);
  const map = interpreter._mapId;
  interpreter._mapId = scope.$gameMap.mapId() + 1;
  assert.equal(interpreter.character(1), null);
  interpreter._mapId = map;
});

test('native conditional branches dispatch skip overrides and saved originals exactly once', t => {
  const { scope, session, step } = create(t, [command(111, [0, 1, 0]), { ...variable(3, 99), indent: 1 },
    command(411), { ...variable(4, 7), indent: 1 }, command(412)]);
  const original = scope.Game_Interpreter.prototype.skipBranch;
  const calls = [];
  scope.Game_Interpreter.prototype.skipBranch = function() { calls.push(arguments.length); return original.call(this); };
  step();
  assert.deepEqual(calls, [0]);
  assert.equal(api.snapshot(session).variables[3] || 0, 0); assert.equal(api.snapshot(session).variables[4], 7);
});

test('a script can rewind the first native command with index minus one and a counted wait', t => {
  const { session, step } = create(t, [command(355, ['if (!this.retried) { this.retried = true; this.wait(1); this._index = -1; }']),
    variable(9, 42), command(230, [20])]);
  step();
  assert.equal(api.snapshot(session).variables[9], undefined);
  assert.equal(api.save(session).map._interpreter._index, 0);
  step();
  assert.equal(api.snapshot(session).variables[9], 42);
});

test('native else branches distinguish numeric zero from boolean false', t => {
  const { session, step } = create(t, [command(111, [0, 1, 1]),
    command(355, ['this._branch[0] = 0;'], 1), command(411),
    { ...variable(9, 99), indent: 1 }, command(412), command(230, [20])]);
  step();
  assert.equal(api.snapshot(session).variables[9], undefined);
});

test('native command ownership retains extensions but replaced interpreter/list cycles collect', {
  skip: !global.gc
}, async t => {
  const { session, scope, step } = create(t, [command(355, ['$inspect(this);']), command(230, [20])]);
  let weakInterpreter, weakList, weakCommand;
  scope.$inspect = interpreter => {
    const list = interpreter._list, item = list[0];
    item.owner = interpreter; interpreter.command = item;
    weakInterpreter = new WeakRef(interpreter); weakList = new WeakRef(list); weakCommand = new WeakRef(item);
  };
  step();
  await new Promise(resolve => setImmediate(resolve));
  global.gc();
  assert.equal(weakCommand.deref().owner, weakInterpreter.deref());
  api.load(session, api.save(session));
  step();
  await new Promise(resolve => setImmediate(resolve));
  global.gc();
  await new Promise(resolve => setImmediate(resolve));
  global.gc();
  assert.equal(weakInterpreter.deref(), undefined);
  assert.equal(weakList.deref(), undefined);
  assert.equal(weakCommand.deref(), undefined);
});

test('native event lifecycle calls saved originals and nested clear overrides on one wrapper', t => {
  const { scope, step } = create(t, [command(355, ['$body(this);'])]);
  const prototype = scope.Game_Interpreter.prototype;
  const setup = prototype.setup, clear = prototype.clear, terminate = prototype.terminate;
  const trace = [];
  let interpreter, source, branches;
  prototype.clear = function() { trace.push('clear'); clear.call(this); this.requested = 0; };
  prototype.setup = function(list, id) {
    trace.push('setup-before'); interpreter = this; source = list;
    setup.call(this, list, id); this.requested = 2; trace.push('setup-after');
  };
  prototype.terminate = function() {
    trace.push('terminate-before'); assert.equal(this, interpreter);
    assert.equal(this._list, source); assert.equal(this.requested, 2);
    terminate.call(this);
    assert.equal(this._list, null); assert.equal(this._comments, ''); trace.push('terminate-after');
  };
  scope.$body = value => {
    trace.push('body'); assert.equal(value, interpreter); assert.equal(value.eventId(), 1);
    assert.equal(value.isOnCurrentMap(), true); assert.equal(value.requested, 2);
    value._comments = 'active'; branches = value._branch;
  };
  step();
  assert.deepEqual(trace, ['setup-before', 'clear', 'setup-after', 'body', 'terminate-before', 'terminate-after', 'clear']);
  assert.equal(interpreter._branch, branches);
  assert.equal(interpreter.requested, 0);
  assert.equal(source[0].code, 355);
});

test('script setup replacement can attach the native source list without calling the native setup', t => {
  const { session, scope, step } = create(t, [variable(9, 1), command(230, [20])]);
  const clear = scope.Game_Interpreter.prototype.clear;
  let source, interpreter;
  scope.Game_Interpreter.prototype.setup = function(list, id) {
    clear.call(this); this._mapId = scope.$gameMap.mapId(); this._eventId = id; this._list = list;
    list[0].parameters[4] = 81; source = list; interpreter = this;
  };
  step();
  assert.equal(api.snapshot(session).variables[9], 81);
  assert.equal(interpreter._list, source);
  assert.throws(() => { interpreter._list = {}; }, /command list requires an array/);
  assert.equal(interpreter._list, source);
  interpreter._list = []; assert.equal(interpreter._list.length, 0);
  assert.equal(source[0].parameters[4], 81);
});

test('common-event setup preserves child depth and rejects clearing an active parent', t => {
  const { scope, step } = create(t, [command(117, [1]), command(230, [20])]);
  const setup = scope.Game_Interpreter.prototype.setup;
  let parent, child;
  scope.Game_Interpreter.prototype.setup = function(list, id) {
    if (this._depth === 0) parent = this;
    else {
      child = this;
      assert.throws(() => parent.clear(), /ancestor interpreter/);
    }
    setup.call(this, list, id);
    assert.equal(this._depth, this === parent ? 0 : 1);
    assert.equal(this._eventId, 1);
    this.retained = true;
  };
  step();
  assert.ok(parent && child);
  assert.equal(child.retained, true);
  const clear = scope.Game_Interpreter.prototype.clear;
  scope.Game_Interpreter.prototype.clear = function() { assert.throws(step, /already updating/); clear.call(this); };
  assert.doesNotThrow(() => parent.setup(parent._list, parent.eventId()));
});

test('parallel event restarts dispatch lifecycle overrides on the same interpreter', t => {
  const data = fixture([]);
  const page = data.maps[1].events[1].pages[0];
  page.trigger = 4; page.list = [variable(9, 8), command(0)];
  data.maps[1].events[1].pages = [page];
  const session = api.create(data); t.after(() => api.dispose(session));
  const { scope } = createScriptRuntime(api, session); api.newGame(session);
  const setup = scope.Game_Interpreter.prototype.setup, terminate = scope.Game_Interpreter.prototype.terminate;
  const instances = []; let terminations = 0;
  scope.Game_Interpreter.prototype.setup = function(list, id) { instances.push(this); setup.call(this, list, id); };
  scope.Game_Interpreter.prototype.terminate = function() { terminations++; terminate.call(this); };
  for (let i = 0; i < 3; i++) api.step(session, {});
  assert.equal(instances.length, 3); assert.equal(terminations, 3);
  assert.ok(instances.every(value => value === instances[0]));
});

test('troop event lifecycle reaches scripts while retaining native battle execution', t => {
  const data = fixture([]);
  data.enemies = [null, { name: 'Enemy', params: [100, 20, 10, 10, 10, 10, 10, 10], actions: [], traits: [] }];
  data.troops = [null, { members: [{ enemyId: 1, x: 100, y: 100 }], pages: [{ span: 0,
    conditions: { turnValid: true, turnA: 0, turnB: 0 },
    list: [command(355, ['$battleBody(this);']), command(0)] }] }];
  const session = api.create(data); t.after(() => api.dispose(session));
  const { scope } = createScriptRuntime(api, session); api.newGame(session);
  const setup = scope.Game_Interpreter.prototype.setup, terminate = scope.Game_Interpreter.prototype.terminate;
  const trace = [];
  scope.Game_Interpreter.prototype.setup = function(list, id) { trace.push('setup'); setup.call(this, list, id); };
  scope.Game_Interpreter.prototype.terminate = function() { trace.push('terminate'); terminate.call(this); };
  scope.$battleBody = interpreter => { trace.push('body'); assert.equal(interpreter._eventId, 0); };
  api.startBattle(session, 1, true, true);
  api.acknowledge(session);
  for (let i = 0; i < 120 && !trace.includes('terminate'); i++) api.step(session, {});
  assert.deepEqual(trace, ['setup', 'body', 'terminate']);
});

test('lifecycle exceptions preserve their identity and release the native operation guard', t => {
  const { scope, step } = create(t, [variable(9, 1)]);
  const setup = scope.Game_Interpreter.prototype.setup, terminate = scope.Game_Interpreter.prototype.terminate;
  const failure = new Error('lifecycle failed');
  scope.Game_Interpreter.prototype.setup = function() { throw failure; };
  assert.throws(step, error => error === failure);
  scope.Game_Interpreter.prototype.setup = setup;
  scope.Game_Interpreter.prototype.terminate = function() { throw failure; };
  assert.throws(step, error => error === failure);
  scope.Game_Interpreter.prototype.terminate = terminate;
  assert.doesNotThrow(step);
});

test('native show-text dispatches message overrides and exposes the same native fields', t => {
  const { session, scope, step } = create(t, [command(101, ['Face', 2, 1, 0]), command(401, ['Hello']), variable(9, 42), command(230, [20])]);
  const add = scope.Game_Message.prototype.add;
  scope.Game_Message.prototype.add = function(text) { add.call(this, 'script:' + text); this.extension = true; };
  step();
  assert.equal(scope.$gameMessage.faceName(), 'Face');
  assert.equal(scope.$gameMessage._faceIndex, 2);
  assert.equal(scope.$gameMessage.background(), 1);
  assert.equal(scope.$gameMessage.positionType(), 0);
  assert.equal(scope.$gameMessage.allText(), 'script:Hello');
  assert.equal(scope.$gameMessage.extension, true);
  assert.deepEqual(api.snapshot(session).message.lines, ['script:Hello']);
  assert.equal(api.snapshot(session).variables[9], undefined);
  api.acknowledge(session);
  for (let i = 0; i < 16 && api.snapshot(session).variables[9] === undefined; i++) step();
  assert.equal(api.snapshot(session).variables[9], 42);
});

test('native choices expose retained live arrays and invoke the interpreter callback once', t => {
  const { session, scope, step } = create(t, [command(102, [['Yes', 'No'], -2, 0, 2, 0]),
    command(402, [0]), { ...variable(9, 1), indent: 1 }, command(402, [1]),
    { ...variable(9, 2), indent: 1 }, command(404), command(230, [20])]);
  step();
  const choices = scope.$gameMessage.choices();
  assert.equal(choices, scope.$gameMessage._choices);
  assert.deepEqual(Array.from(choices.clone()), ['Yes', 'No']);
  assert.equal(typeof scope.$gameMessage._choiceCallback, 'function');
  api.acknowledge(session, 1);
  assert.equal(scope.$gameMessage._choiceCallback, null);
  assert.deepEqual(Array.from(choices), ['Yes', 'No']);
  assert.deepEqual(Array.from(scope.$gameMessage.choices()), []);
  step();
  assert.equal(api.snapshot(session).variables[9], 2);
});

test('script choices jump the native interpreter through label callbacks', t => {
  const { session, scope, step } = create(t, [command(356, ['Choices']), variable(9, 1), command(115),
    command(118, ['Selected']), variable(9, 2), command(230, [20])]);
  scope.Game_Interpreter.prototype.pluginCommand = function(name) {
    if (name !== 'Choices') return;
    scope.$gameMessage.setChoices(['Jump'], 0, -2);
    scope.$gameMessage.setChoiceCallback(() => this.jumpTo(3));
    this.setWaitMode('message');
  };
  step(); assert.equal(api.snapshot(session).variables[9], undefined);
  api.acknowledge(session, 0); step();
  assert.equal(api.snapshot(session).variables[9], 2);
});

test('event scripts use their own realm and share the native random stream', t => {
  const { session, scope, step } = create(t, [command(355, ['isolatedValue = [1, 2].clone(); this.draw = Math.random();']), command(230, [20])]);
  const before = api.snapshot(session).randomCalls;
  step();
  assert.equal(globalThis.isolatedValue, undefined);
  assert.deepEqual(Array.from(scope.isolatedValue), [1, 2]);
  assert.equal(api.snapshot(session).randomCalls, before + 1);
});

test('native-backed subclasses keep their identity and plugin initialization', t => {
  const { scope, step } = create(t, []);
  const base = scope.Game_Picture.prototype.initialize;
  function Derived() { this.initialize.apply(this, arguments); }
  Derived.prototype = Object.create(scope.Game_Picture.prototype);
  Derived.prototype.constructor = Derived;
  Derived.prototype.initialize = function() { base.call(this); this.extension = { initialized: true }; };
  const picture = new Derived();
  assert.ok(picture instanceof Derived);
  assert.equal(picture._scaleX, 100);
  picture._x = 19;
  step();
  assert.equal(picture._x, 19);
  assert.equal(picture.extension.initialized, true);
  assert.ok(Object.keys(picture).includes('_x'));
});

test('script exceptions propagate through the native frame without substituting another error', t => {
  const { scope, step } = create(t, [show(), command(230, [8])]);
  const failure = new Error('picture callback failed');
  scope.Game_Picture.prototype.update = function() { throw failure; };
  assert.throws(step, error => error === failure);
});


test('session ownership and reentrant frame/disposal calls cannot invalidate an active trampoline', t => {
  const first = create(t, [show(), command(230, [8])]);
  const second = create(t, [show(), command(230, [8])]);
  first.step(); second.step();
  assert.throws(() => api.pictureInvoke(second.session, api.picture(first.session, 1), 'updateMove'), /another session/);
  const base = first.scope.Game_Picture.prototype.update;
  first.scope.Game_Picture.prototype.update = function() { first.step(); };
  assert.throws(first.step, /already updating/);
  first.scope.Game_Picture.prototype.update = function() { api.dispose(first.session); };
  assert.throws(first.step, /during a script callback/);
  first.scope.Game_Picture.prototype.update = base;
  assert.doesNotThrow(first.step);
  const tone = [0, 0, 0, 0];
  Object.defineProperty(tone, 0, { get() { api.dispose(first.session); return 0; } });
  assert.throws(() => first.scope.$gameScreen.picture(1).tint(tone, 1), /during a script callback/);
  assert.doesNotThrow(first.step);
});

test('active native ownership preserves plugin fields and removed wrappers can be collected', {
  skip: !global.gc
}, async t => {
  const { scope, step } = create(t, [show(), command(230, [2]), command(235, [1]), command(230, [8])]);
  step();
  let picture = scope.$gameScreen.picture(1);
  picture.extension = { retained: true };
  const weak = new WeakRef(picture);
  picture = null;
  await new Promise(resolve => setImmediate(resolve));
  global.gc();
  assert.equal(weak.deref().extension.retained, true);
  step(); step(); step();
  assert.equal(scope.$gameScreen.picture(1), null);
  await new Promise(resolve => setImmediate(resolve));
  global.gc();
  await new Promise(resolve => setImmediate(resolve));
  global.gc();
  assert.equal(weak.deref(), undefined);
});

test('native tone ownership retains extensions without rooting removed picture/array cycles', {
  skip: !global.gc
}, async t => {
  const { scope, step } = create(t, [show(), command(230, [2]), command(235, [1]), command(230, [20])]);
  step();
  let picture = scope.$gameScreen.picture(1);
  picture.tint([0, 10, 0, 0], 0);
  let tone = picture._tone;
  tone.picture = picture;
  const weakPicture = new WeakRef(picture), weakTone = new WeakRef(tone);
  picture = null; tone = null;
  await new Promise(resolve => setImmediate(resolve));
  global.gc();
  assert.equal(weakTone.deref().picture, weakPicture.deref());
  step(); step(); step();
  await new Promise(resolve => setImmediate(resolve));
  global.gc();
  await new Promise(resolve => setImmediate(resolve));
  global.gc();
  assert.equal(weakPicture.deref(), undefined);
  assert.equal(weakTone.deref(), undefined);
});

test('native executeCommand original dispatches current command overrides with prepared parameters', t => {
  const { scope, step, session } = create(t, [variable(1, 3), command(230, [8]), variable(2, 7)]);
  const execute = scope.Game_Interpreter.prototype.executeCommand;
  const changeVariable = scope.Game_Interpreter.prototype.command122;
  const visited = [];
  let observed;
  scope.Game_Interpreter.prototype.executeCommand = function() {
    observed = this;
    visited.push(this._index);
    return execute.call(this);
  };
  scope.Game_Interpreter.prototype.command122 = function() {
    assert.equal(this._indent, 0);
    if (this._index === 0) {
      assert.equal(this._params[0], 1);
      this._index = 1;
    }
    return changeVariable.call(this);
  };
  step();
  assert.equal(api.snapshot(session).variables[1], 3);
  assert.equal(api.snapshot(session).variables[2], 7);
  assert.deepEqual(visited.slice(0, 2), [0, 2]);
  assert.equal(observed.isRunning(), false);
});

test('native custom command dispatch pauses on falsy results and observes instance replacement', t => {
  const { scope, step, session } = create(t, [command(999, ['custom']), variable(4, 9)]);
  let interpreter, calls = 0;
  scope.Game_Interpreter.prototype.command999 = function() {
    interpreter = this;
    ++calls;
    assert.equal(this._params[0], 'custom');
  };
  step();
  assert.equal(interpreter._index, 0);
  assert.equal(api.snapshot(session).variables[4], undefined);
  interpreter.command999 = function() { ++calls; return true; };
  step();
  assert.equal(calls, 2);
  assert.equal(api.snapshot(session).variables[4], 9);
});

test('native executeCommand replacement owns advancement and propagates command exceptions', t => {
  const { scope, step, session } = create(t, [variable(6, 2)]);
  const execute = scope.Game_Interpreter.prototype.executeCommand;
  let interpreter;
  scope.Game_Interpreter.prototype.executeCommand = function() { interpreter = this; return false; };
  step();
  assert.equal(interpreter._index, 0);
  assert.equal(api.snapshot(session).variables[6], undefined);
  const error = new Error('command override failure');
  interpreter.executeCommand = execute;
  interpreter.command122 = function() { throw error; };
  assert.throws(step, value => value === error);
  assert.equal(interpreter._index, 0);
  interpreter.command122 = scope.Game_Interpreter.prototype.command122;
  step();
  assert.equal(api.snapshot(session).variables[6], 2);
});

test('native command dispatch skips noncallable command methods', t => {
  const { scope, step, session } = create(t, [variable(1, 3), command(998, []), variable(2, 4)]);
  scope.Game_Interpreter.prototype.command122 = null;
  scope.Game_Interpreter.prototype.command998 = 12;
  step();
  assert.equal(api.snapshot(session).variables[1], undefined);
  assert.equal(api.snapshot(session).variables[2], undefined);
});

test('native command fallback reads prepared parameters after method lookup', t => {
  const { scope, step, session } = create(t, [variable(1, 3), command(230, [8]), variable(2, 9)]);
  const original = scope.Game_Interpreter.prototype.command122;
  Object.defineProperty(scope.Game_Interpreter.prototype, 'command122', {
    configurable: true,
    get() {
      if (this._index === 0) {
        this._params[4] = 7;
        this._index = 1;
      }
      return original;
    }
  });
  step();
  assert.equal(api.snapshot(session).variables[1], 7);
  assert.equal(api.snapshot(session).variables[2], 9);
});

test('native script conditions use JavaScript truthiness and eval completion values', t => {
  const sources = ['({})', '[]', '"0"', 'var value = 7; value', '0', '""', 'undefined', 'NaN'];
  const program = sources.flatMap((source, index) => [
    command(111, [12, source]), command(122, [index + 1, index + 1, 0, 0, 1], 1),
    command(411), command(122, [index + 1, index + 1, 0, 0, 2], 1), command(412),
  ]);
  const { session, step } = create(t, program);
  step();
  const state = api.snapshot(session);
  for (let index = 0; index < sources.length; ++index) assert.equal(state.variables[index + 1], index < 4 ? 1 : 2, sources[index]);
});

test('native script conditions bind the current interpreter and execute once', t => {
  const { scope, step, session } = create(t, [
    command(111, [12, 'this.eventId() === 1 && this._params[0] === 12 && ++conditionCalls === 1']),
    command(122, [1, 1, 0, 0, 7], 1), command(412),
  ]);
  scope.conditionCalls = 0;
  step();
  assert.equal(scope.conditionCalls, 1);
  assert.equal(api.snapshot(session).variables[1], 7);
});

test('native script condition errors preserve identity and leave the command retryable', t => {
  const { scope, step, session } = create(t, [
    command(111, [12, 'if (conditionFailure) throw conditionFailure; true']),
    command(122, [1, 1, 0, 0, 7], 1), command(412),
  ]);
  const failure = new Error('condition failure');
  scope.conditionFailure = failure;
  assert.throws(step, error => error === failure);
  assert.equal(api.snapshot(session).interpreter.index, 0);
  assert.equal(api.snapshot(session).variables[1], undefined);
  scope.conditionFailure = null;
  step();
  assert.equal(api.snapshot(session).variables[1], 7);
});

test('script Utils delegates native helpers and uses configured guest options', t => {
  const session = api.create(fixture([]));
  t.after(() => api.dispose(session));
  const runtime = createScriptRuntime(api, session, { guestArguments: ['test&btest'] });
  const { Utils } = runtime.scope;
  assert.equal(Utils.RPGMAKER_NAME, 'MV');
  assert.equal(Utils.RPGMAKER_VERSION, '1.6.1');
  assert.equal(Utils.isOptionValid('test'), true);
  assert.equal(Utils.isOptionValid('btest'), true);
  assert.equal(Utils.isOptionValid('eventtest'), false);
  assert.equal(Utils.rgbToCssColor(1.4, 2.6, 3), 'rgb(1,3,3)');
  assert.equal(Utils.escapeHtml('<a & "b">'), '&lt;a &amp; &quot;b&quot;&gt;');
  const first = Utils.generateRuntimeId();
  assert.equal(Utils.generateRuntimeId(), first + 1);
  runtime.scope.navigator = { userAgent: 'iPhone AppleWebKit Mobile Safari' };
  assert.equal(Utils.isMobileDevice(), true);
  assert.equal(Utils.isMobileSafari(), true);
  assert.equal(Utils.isAndroidChrome(), false);
});

test('live bootstrap database preserves authored objects through native initialization', t => {
  const database = fixture([]);
  const session = api.create({});
  t.after(() => api.dispose(session));
  api.databaseInvoke(session, 'publish', database);
  assert.equal(api.databaseInvoke(session, 'read', 'system'), database.system);
  database.actors[1].name = 'Live bootstrap actor';
  api.newGame(session);
  assert.equal(api.entityField(api.entity(session, 'actor', 1), 'name'), 'Live bootstrap actor');
  assert.equal(api.mapId(session), 1);
  assert.equal(api.databaseInvoke(session, 'readMap', 1), database.maps[1]);
});

test('live variable and switch bounds read lengths without visiting array elements', t => {
  const data = fixture([]), names = Array(2001).fill('');
  Object.defineProperty(names, 1000, { configurable: true, get() { throw new Error('name element must not be visited'); } });
  const session = api.create({}); t.after(() => api.dispose(session));
  api.databaseInvoke(session, 'publish', { ...data, system: { ...data.system, variables: names, switches: names } });
  const { scope } = createScriptRuntime(api, session);
  scope.$gameVariables.setValue(1, 4); scope.$gameSwitches.setValue(1, true);
  assert.equal(scope.$gameVariables.value(1), 4); assert.equal(scope.$gameSwitches.value(1), true);
  names.length = 1;
  scope.$gameVariables.setValue(1, 9); scope.$gameSwitches.setValue(1, false);
  assert.equal(scope.$gameVariables.value(1), 4); assert.equal(scope.$gameSwitches.value(1), true);
  names.length = 3;
  scope.$gameVariables.setValue(1, 9); scope.$gameSwitches.setValue(1, false);
  assert.equal(scope.$gameVariables.value(1), 9); assert.equal(scope.$gameSwitches.value(1), false);
});

test('Tiled collision validates live passage length without reading unrelated cells', t => {
  const data = fixture([]), passage = [0, 0, 0];
  Object.defineProperty(passage, 2, { configurable: true, get() { throw new Error('unrelated passage cell must not be visited'); } });
  const session = api.create(data); t.after(() => api.dispose(session));
  api.databaseInvoke(session, 'publish', { tiledMaps: { 1: { width: 3, height: 1, tilewidth: 48, tileheight: 48, passage } } });
  const { scope } = createScriptRuntime(api, session); api.newGame(session);
  scope.$gamePlayer.locate(0, 0); scope.$gamePlayer.moveStraight(6);
  assert.equal(scope.$gamePlayer.x, 1);
  scope.$gamePlayer.locate(1, 0); passage.length = 2;
  assert.throws(() => scope.$gamePlayer.moveStraight(4), /tile collision data is unavailable/);
  passage.length = 3; passage[1] = 2;
  scope.$gamePlayer.moveStraight(4); assert.equal(scope.$gamePlayer.x, 1);
  passage[1] = 0;
  scope.$gamePlayer.moveStraight(4); assert.equal(scope.$gamePlayer.x, 0);
});

test('database bindings require named tables and preserve script-only metadata', t => {
  const session = api.create(fixture([]));
  t.after(() => api.dispose(session));
  const before = api.databaseInvoke(session, 'read', 'actors');
  for (const invalid of [null, [], 'invalid'])
    assert.throws(() => api.databaseInvoke(session, 'publish', invalid), /named tables/);
  assert.deepEqual(api.databaseInvoke(session, 'read', 'actors'), before);
  const actors = [null, { id: 1, name: 'Changed', describe() { return this.name; } }];
  api.databaseInvoke(session, 'publish', { actors });
  assert.equal(api.databaseInvoke(session, 'read', 'actors'), actors);
  api.newGame(session);
  assert.equal(api.entityField(api.entity(session, 'actor', 1), 'name'), 'Changed');
  assert.equal(actors[1].describe(), 'Changed');
  assert.throws(() => api.databaseInvoke(session, 'publish', { actors: [] }), /before game state initialization/);
});

test('temporary game state shares reservations and destinations with native state', t => {
  const session = api.create(fixture([]));
  t.after(() => api.dispose(session));
  const runtime = createScriptRuntime(api, session, { guestArguments: ['test'] });
  const { scope } = runtime;
  runtime.runScript(`
    var tempInitialize = Game_Temp.prototype.initialize;
    Game_Temp.prototype.initialize = function() { tempInitialize.call(this); this.isManipulatingHud = false; };
    $gameTemp.initialize();
  `);
  assert.equal(scope.$gameTemp.isPlaytest(), true);
  assert.equal(scope.$gameTemp.isManipulatingHud, false);
  scope.$dataCommonEvents = [null, { id: 1 }];
  scope.$gameTemp.reserveCommonEvent(1);
  assert.equal(api.gameDataInvoke(session, 'temp', 'commonEventId', []), 1);
  assert.equal(scope.$gameTemp.reservedCommonEvent(), scope.$dataCommonEvents[1]);
  scope.$gameTemp.clearCommonEvent();
  assert.equal(scope.$gameTemp.isCommonEventReserved(), false);
  scope.$gameTemp.setDestination(5, 7);
  assert.equal(scope.$gameTemp.isDestinationValid(), true);
  assert.equal(api.gameDataInvoke(session, 'temp', 'destinationX', []), 5);
  assert.equal(scope.$gameTemp.destinationY(), 7);
  scope.$gameTemp.initialize();
  assert.equal(scope.$gameTemp.isDestinationValid(), false);
  assert.equal(scope.$gameTemp.destinationX(), null);
});

test('native battle actions dispatch hit and evasion aliases with retained battler identity', t => {
  const data = fixture([]);
  data.skills[2] = { id: 2, stypeId: 1, hitType: 1, successRate: 100, scope: 1, occasion: 0,
    damage: { type: 1, formula: '1', variance: 0, critical: false, elementId: 0 }, effects: [] };
  data.classes[1].traits.push({ code: 22, dataId: 0, value: 0.5 });
  data.enemies = [null, { name: 'Enemy', params: [100, 20, 10, 10, 10, 10, 10, 10], actions: [], traits: [{ code: 22, dataId: 1, value: 0.1 }] }];
  data.troops = [null, { members: [{ enemyId: 1, x: 100, y: 100 }], pages: [] }];
  const session = api.create(data); t.after(() => api.dispose(session));
  const { scope } = createScriptRuntime(api, session); api.newGame(session);
  scope.$dataSkills = data.skills; scope.$dataItems = data.items;
  scope.$dataEnemies = data.enemies;
  const hit = scope.Game_Action.prototype.itemHit, eva = scope.Game_Action.prototype.itemEva;
  let enemy, calls = 0;
  scope.Game_Action.prototype.itemHit = function(target) {
    ++calls; enemy = target; this.checkedHit = true;
    assert.equal(this.subject(), scope.$gameActors.actor(1));
    assert.ok(target instanceof scope.Game_BattlerBase);
    assert.equal(target.isEnemy(), true); assert.equal(target.isActor(), false);
    assert.equal(target.enemy(), data.enemies[1]);
    assert.equal(target._enemyId, 1);
    assert.equal(scope.$gameTroop.members()[0], target);
    assert.equal(target.index(), 0); assert.equal(target.friendsUnit(), scope.$gameTroop);
    assert.equal(this.opponentsUnit(), scope.$gameTroop);
    assert.equal(this.friendsUnit(), scope.$gameParty);
    assert.equal(hit.call(this, target), 0.5);
    return 1;
  };
  scope.Game_Action.prototype.itemEva = function(target) {
    assert.equal(target, enemy);
    assert.equal(this.checkedHit, true);
    assert.equal(eva.call(this, target), 0.1);
    return 0;
  };
  api.setRandomStream(session, Array(1000).fill(0.5));
  api.startBattle(session, 1, true, true); api.acknowledge(session);
  for (let i = 0; i < 120 && !scope.BattleManager.isInputting(); ++i) api.step(session, {});
  assert.equal(scope.BattleManager.isInputting(), true);
  assert.equal(scope.BattleManager.actor(), scope.$gameActors.actor(1));
  api.chooseAction(session, 0, 2, 0, false);
  for (let i = 0; i < 120 && !calls; ++i) { api.acknowledge(session); api.step(session, {}); }
  assert.equal(calls, 1);
  const retainedHp = enemy.hp;
  api.startBattle(session, 1, true, true);
  assert.equal(enemy.hp, retainedHp, 'old enemy reference must retain its previous state');
});

test('turn completion dispatches actor and enemy overrides and shares regeneration and buff state', t => {
  const data = fixture([command(301, [0, 1, false, false]), command(230, [20])]);
  data.classes[1].traits.push({ code: 22, dataId: 7, value: 0.1 }, { code: 22, dataId: 8, value: 0.2 }, { code: 22, dataId: 9, value: 0.05 });
  data.enemies = [null, { id: 1, name: 'Enemy', params: Array(8).fill(10), traits: [], actions: [], exp: 0, gold: 0 }];
  data.troops = [null, { id: 1, members: [{ enemyId: 1, x: 0, y: 0, hidden: false }], pages: [] }];
  const session = api.create(data); t.after(() => api.dispose(session));
  const { scope } = createScriptRuntime(api, session);
  const seen = [], original = scope.Game_Battler.prototype.onTurnEnd;
  scope.Game_Battler.prototype.onTurnEnd = function() { seen.push(this); return original.call(this); };
  api.newGame(session);
  const actor = scope.$gameActors.actor(1);
  actor.setHp(4); actor.setMp(1);
  api.step(session, {});
  actor.setTp(0); actor.addBuff(2, 1);
  api.gameDataInvoke(session, 'battle', 'endTurn', []);
  assert.equal(actor.hp, 5); assert.equal(actor.mp, 3); assert.equal(actor.tp, 5);
  assert.equal(actor._buffTurns[2], 0); assert.equal(actor.buff(2), 1);
  actor.onAllActionsEnd(); assert.equal(actor.buff(2), 0);
  assert.deepEqual(Array.from(actor.result().removedBuffs), [2]);
  assert.equal(seen[0], actor);
  assert.equal(seen[1], scope.$gameTroop.members()[0]);
  assert.ok(seen[1] instanceof scope.Game_Enemy);
  for (const name of ['actors', 'classes', 'weapons', 'armors', 'states', 'system', 'enemies'])
    scope['$data' + name[0].toUpperCase() + name.slice(1)] = data[name];
  let gains = 0; const gainHp = actor.gainHp;
  actor.gainHp = function(value) { ++gains; return gainHp.call(this, value); };
  actor.setHp(4); actor.setMp(1); actor.setTp(0); actor.onTurnEnd();
  assert.equal(gains, 1); assert.equal(actor.hp, 5); assert.equal(actor.mp, 3); assert.equal(actor.tp, 5);
  actor.addDebuff(2, 2); assert.equal(actor.buff(2), -1);
  actor.addBuff(2, 1); assert.equal(actor.buff(2), 0); assert.equal(actor._buffTurns[2], 2);
  actor.addBuff(2, 3); assert.equal(actor.buff(2), 1); assert.equal(actor._buffTurns[2], 3);
});

test('action targeting, damage and equipment optimization use live native battlers and inventory', t => {
  const data = fixture([]);
  data.skills[1] = { id: 1, scope: 7, repeats: 2, hitType: 0, effects: [], damage: { type: 5 } };
  data.weapons.push({ id: 2, etypeId: 1, wtypeId: 1, params: [0, 0, 5, 0, 0, 0, 0, 0] });
  data.states.push({ id: 2, removeByDamage: true, chanceByDamage: 100, traits: [], minTurns: 1, maxTurns: 1 });
  const session = api.create(data); t.after(() => api.dispose(session));
  const { scope } = createScriptRuntime(api, session);
  for (const name of ['actors', 'classes', 'weapons', 'armors', 'states', 'system', 'skills', 'items'])
    scope['$data' + name[0].toUpperCase() + name.slice(1)] = data[name];
  api.newGame(session);
  const actor = scope.$gameActors.actor(1), target = scope.$gameActors.actor(2);
  const action = new scope.Game_Action(actor); action.setSkill(1); action.setTarget(0);
  assert.deepEqual(Array.from(action.makeTargets()), [actor, actor]);
  assert.equal(action.testApply(actor), false);
  actor.setHp(4); assert.equal(action.testApply(actor), false);
  assert.equal(action.testItemEffect(actor, { code: 11, value1: 0, value2: 1 }), true);
  target.setHp(3); target.addState(2); target.setTp(0);
  action.executeDamage(target, 9);
  assert.equal(target.hp, 0); assert.equal(actor.hp, 7);
  assert.equal(target.result().hpDamage, 3); assert.equal(target.result().success, true);
  assert.equal(target.isStateAffected(2), false);
  assert.equal(target.tp, 15);
  actor.result().critical = true; action.executeDamage(actor, 0); assert.equal(actor.result().critical, false);
  scope.$gameParty.gainItem(data.weapons[2], 1);
  let comparisons = 0; const score = actor.calcEquipItemPerformance;
  actor.calcEquipItemPerformance = function(item) { ++comparisons; return score.call(this, item); };
  actor.optimizeEquipments();
  assert.equal(actor.equips()[0], data.weapons[2]); assert.ok(comparisons > 0);
  assert.equal(scope.$gameParty.numItems(data.weapons[2]), 0);
  assert.equal(scope.$gameParty.numItems(data.weapons[1]), 1);
});

test('script-created interpreters and common events execute native commands with independent state', t => {
  const data = fixture([]), session = api.create(data); t.after(() => api.dispose(session));
  const { scope } = createScriptRuntime(api, session); scope.$dataCommonEvents = data.commonEvents;
  api.newGame(session);
  const interpreter = new scope.Game_Interpreter(3);
  assert.equal(interpreter._depth, 3); assert.equal(interpreter.isRunning(), false);
  const source = [variable(7, 12), command(230, [2]), variable(8, 21), command(0)];
  interpreter.setup(source, 9); interpreter.update();
  assert.equal(scope.$gameVariables.value(7), 12); assert.equal(interpreter.isRunning(), true);
  assert.equal(interpreter._eventId, 9); assert.equal(interpreter._waitCount, 1);
  interpreter.update(); interpreter.update(); interpreter.update();
  assert.equal(scope.$gameVariables.value(8), 21); assert.equal(interpreter.isRunning(), false);
  assert.equal(source.length, 4); assert.equal(source[0].code, 122);
  interpreter.setup([variable(10, 5), command(0)]);
  interpreter.setupChild([variable(9, 4), command(230, [1]), command(0)], 11);
  const child = interpreter._childInterpreter;
  assert.equal(child._depth, 4); assert.equal(child._eventId, 11);
  interpreter.update(); assert.equal(scope.$gameVariables.value(9), 4); assert.equal(scope.$gameVariables.value(10), 0);
  interpreter.update(); interpreter.update(); assert.equal(scope.$gameVariables.value(10), 5);
  data.commonEvents[1] = { id: 1, trigger: 2, switchId: 1, list: [variable(12, 18), command(0)] };
  const common = new scope.Game_CommonEvent(1); assert.equal(common._interpreter, null);
  scope.$gameSwitches.setValue(1, true); common.refresh(); common.update();
  assert.equal(scope.$gameVariables.value(12), 18);
  const retained = common._interpreter; scope.$gameSwitches.setValue(1, false); common.refresh();
  assert.equal(common._interpreter, null); retained.setup([variable(13, 7), command(0)]); retained.update();
  assert.equal(scope.$gameVariables.value(13), 7);
  api.newGame(session); retained.setup([variable(14, 8), command(0)]); retained.update();
  assert.equal(scope.$gameVariables.value(14), 8);
  scope.$gameVariables.setValue(12, 0);
  scope.$gameTemp.reserveCommonEvent(1); assert.equal(interpreter.setupReservedCommonEvent(), true);
  assert.equal(scope.$gameTemp.isCommonEventReserved(), false); interpreter.update();
  assert.equal(scope.$gameVariables.value(12), 18);
});

test('idle autorun queries preserve live definitions, priority, aliases and exception identity', t => {
  const data = fixture([]); data.maps[1].events = [null];
  const events = Array(2001).fill(null);
  events[4] = { id: 4, trigger: 0, switchId: 1, list: [variable(12, 42), command(230, [30]), command(0)] };
  events[5] = { id: 5, trigger: 1, switchId: 2, list: [variable(11, 23), command(230, [30]), command(0)] };
  data.commonEvents = events;
  const session = api.create(data); t.after(() => api.dispose(session));
  api.databaseInvoke(session, 'publish', { commonEvents: events });
  const runtime = createScriptRuntime(api, session), { scope } = runtime;
  scope.$dataCommonEvents = events; api.newGame(session);
  const failure = runtime.runScript('new Error("unvisited autorun entry")');
  Object.defineProperty(events, 1500, { configurable: true, get() { throw failure; } });
  const original = scope.Game_Map.prototype.setupAutorunCommonEvent;
  let queries = 0, selected;
  scope.Game_Map.prototype.setupAutorunCommonEvent = function() { ++queries; return original.call(this); };
  const setup = scope.Game_Interpreter.prototype.setup;
  scope.Game_Interpreter.prototype.setup = function(list, ...args) { selected = list; return setup.call(this, list, ...args); };
  scope.$gameSwitches.setValue(2, true); api.step(session, {});
  assert.equal(queries, 1); assert.equal(selected, events[5].list);
  assert.equal(scope.$gameVariables.value(11), 23);
  scope.$gameMap._interpreter.clear();
  events[4] = { ...events[4], trigger: 1 };
  scope.$gameSwitches.setValue(1, true); api.step(session, {});
  assert.equal(selected, events[4].list); assert.equal(scope.$gameVariables.value(12), 42);
  scope.$gameMap._interpreter.clear();
  Object.defineProperty(events[4], 'trigger', { configurable: true, get() { throw failure; } });
  assert.throws(() => api.step(session, {}), error => error === failure);
});

test('map parallel common events retain setup membership while refreshing live switch state', t => {
  const data = fixture([]);
  data.commonEvents = [null,
    { id: 1, trigger: 2, switchId: 1, list: [variable(12, 18), command(230, [1]), command(0)] },
    { id: 2, trigger: 0, switchId: 2, list: [command(0)] }];
  const session = api.create(data); t.after(() => api.dispose(session));
  api.databaseInvoke(session, 'publish', { commonEvents: data.commonEvents });
  const { scope } = createScriptRuntime(api, session);
  scope.$dataCommonEvents = data.commonEvents;
  api.newGame(session);
  const first = scope.$gameMap._commonEvents[0];
  assert.equal(first._commonEventId, 1);
  data.commonEvents[2].trigger = 2;
  scope.$gameSwitches.setValue(1, true); api.step(session, {});
  assert.equal(scope.$gameMap._commonEvents.length, 1);
  assert.equal(scope.$gameMap._commonEvents[0], first);
  assert.equal(scope.$gameVariables.value(12), 18);
  scope.$gameSwitches.setValue(1, false); api.step(session, {});
  assert.equal(first._interpreter, null);
  data.commonEvents[1].trigger = 0;
  scope.$gameMap.setup(1);
  assert.deepEqual(Array.from(scope.$gameMap._commonEvents, event => event._commonEventId), [2]);
});

test('window tone events dispatch aliases and expose shared native tone values', t => {
  const { session, scope, step } = create(t, [command(138, [[12, -8, 20]])]);
  const original = scope.Game_System.prototype.setWindowTone; let calls = 0;
  scope.Game_System.prototype.setWindowTone = function(tone) { ++calls; return original.call(this, tone); };
  step(); assert.equal(calls, 1);
  const tone = scope.$gameSystem.windowTone(); assert.deepEqual(Array.from(tone), [12, -8, 20]);
  tone[1] = 6; assert.deepEqual(api.save(session).system._windowTone, [12, 6, 20]);
  scope.$gameSystem.setWindowTone([1, 2, 3]); assert.deepEqual(Array.from(tone), [1, 2, 3]);
});

test('native movement routes dispatch processMoveCommand aliases without losing route state', t => {
  const route = { list: [{ code: 42, parameters: [123] }, { code: 27, parameters: [4] }, { code: 0, parameters: [] }], repeat: false, skippable: true, wait: true };
  const data = fixture([command(205, [-1, route]), variable(15, 1)]); data.system.switches = Array(100).fill('');
  const session = api.create(data); t.after(() => api.dispose(session));
  const { scope } = createScriptRuntime(api, session); api.newGame(session);
  const step = () => api.step(session, {});
  const original = scope.Game_Character.prototype.processMoveCommand, seen = [];
  scope.Game_Character.prototype.processMoveCommand = function(command) {
    seen.push([this, command.code]);
    if (command.code === 42) command.parameters[0] += 1;
    original.call(this, command);
  };
  for (let frame = 0; frame < 12; ++frame) step();
  assert.equal(scope.$gamePlayer._opacity, 124); assert.equal(scope.$gameSwitches.value(4), true);
  assert.equal(scope.$gameVariables.value(15), 1);
  assert.deepEqual(seen.map(entry => entry[1]), [42, 27, 0]);
  assert.ok(seen.every(entry => entry[0] === scope.$gamePlayer));
  assert.equal(scope.$gamePlayer.isMoveRouteForcing(), false);
  assert.equal(route.list[0].parameters[0], 123);
  const index = scope.$gamePlayer._moveRouteIndex;
  scope.$gamePlayer.processMoveCommand({ code: 42, parameters: [66] });
  assert.equal(scope.$gamePlayer._opacity, 67); assert.equal(scope.$gamePlayer._moveRouteIndex, index);
  assert.equal(api.snapshot(session).switches[4], true);
});

test('player vehicle and encounter queries share native boarding and movement state', t => {
  const data = fixture([]);
  data.system.boat = { startMapId: 1, startX: 1, startY: 2, characterName: '', characterIndex: 0, bgm: { name: '', volume: 90, pitch: 100, pan: 0 } };
  const session = api.create(data); t.after(() => api.dispose(session));
  const { scope } = createScriptRuntime(api, session);
  for (const name of ['actors', 'classes', 'weapons', 'armors', 'states', 'system', 'skills', 'items'])
    scope['$data' + name[0].toUpperCase() + name.slice(1)] = data[name];
  scope.Input = { isPressed: () => false };
  api.newGame(session);
  const player = scope.$gamePlayer;
  assert.equal(player._followers, player.followers()); assert.equal(player.isInVehicle(), false);
  assert.equal(player.canMove(), true); assert.equal(player.canEncounter(), true);
  data.classes[1].traits.push({ code: 64, dataId: 1, value: 1 }); assert.equal(player.canEncounter(), false);
  assert.equal(player.getOnVehicle(), true); assert.equal(player.isInBoat(), true);
  assert.equal(player.vehicle(), scope.$gameMap.boat()); assert.equal(player._vehicleGettingOn, true);
  assert.equal(player.canMove(), false); assert.equal(player.getOnVehicle(), false);
  for (let frame = 0; frame < 40; ++frame) api.step(session, {});
  assert.equal(player._vehicleGettingOn, false); assert.equal(player.canMove(), true);
  player._vehicleGettingOff = true; assert.equal(player.canMove(), false); player._vehicleGettingOff = false;
  assert.equal(scope.$gameMap.event(1).isNormalPriority(), true);
  assert.equal(scope.$gameMap.event(1).isCollidedWithPlayerCharacters(player.x, player.y), true);
  player.setThrough(true); assert.equal(scope.$gameMap.event(1).isCollidedWithPlayerCharacters(player.x, player.y), false);
});

test('troop APIs share event flags, interpreter state and retained enemy identity', t => {
  const data = fixture([command(301, [0, 1, true, true]), command(230, [20])]);
  data.enemies = [null, { id: 1, name: 'First', params: Array(8).fill(10), traits: [], actions: [], exp: 0, gold: 0 },
    { id: 2, name: 'Second', params: Array(8).fill(20), traits: [], actions: [], exp: 0, gold: 0 }];
  const page = { span: 1, conditions: { switchValid: true, switchId: 1 }, list: [command(122, [21, 21, 1, 0, 1]), command(0)] };
  data.troops = [null, { id: 1, members: [{ enemyId: 1, x: 0, y: 0, hidden: false }], pages: [page] },
    { id: 2, members: [{ enemyId: 2, x: 0, y: 0, hidden: false }], pages: [] }];
  const session = api.create(data); t.after(() => api.dispose(session));
  const { scope } = createScriptRuntime(api, session); scope.$dataTroops = data.troops;
  let setups = 0, turns = 0;
  const setup = scope.Game_Troop.prototype.setup, increaseTurn = scope.Game_Troop.prototype.increaseTurn;
  scope.Game_Troop.prototype.setup = function(id) { ++setups; return setup.call(this, id); };
  scope.Game_Troop.prototype.increaseTurn = function() { ++turns; return increaseTurn.call(this); };
  api.newGame(session); api.step(session, {});
  assert.equal(setups, 1); const troop = scope.$gameTroop, first = troop.members()[0];
  scope.$gameSwitches.setValue(1, true);
  troop.setupBattleEvent(); assert.equal(troop._interpreter.isRunning(), true); troop.updateInterpreter();
  assert.equal(scope.$gameVariables.value(21), 1);
  troop.setupBattleEvent(); troop.updateInterpreter(); assert.equal(scope.$gameVariables.value(21), 1);
  troop.increaseTurn(); assert.equal(troop.turnCount(), 1);
  troop.setupBattleEvent(); troop.updateInterpreter(); assert.equal(scope.$gameVariables.value(21), 2);
  api.gameDataInvoke(session, 'battle', 'startTurn', []); assert.equal(turns, 2); assert.equal(troop.turnCount(), 2);
  troop.setup(2); assert.equal(troop.turnCount(), 0); assert.equal(troop.troop(), data.troops[2]);
  const second = troop.members()[0]; assert.notEqual(first, second); assert.equal(second.hp, 20);
  first.setHp(3); assert.equal(first.hp, 3); assert.equal(second.hp, 20);
});

test('native event refresh dispatches page-condition and setup aliases on the same event', t => {
  const data = fixture([]), pages = data.maps[1].events[1].pages;
  pages[0].trigger = 0; pages[0].image.characterName = 'First';
  pages[1].trigger = 0; pages[1].conditions = { switch1Valid: true, switch1Id: 1 }; pages[1].image.characterName = 'Second';
  const session = api.create(data); t.after(() => api.dispose(session));
  const { scope } = createScriptRuntime(api, session); scope.$dataMap = data.maps[1];
  const condition = scope.Game_Event.prototype.meetsConditions, setup = scope.Game_Event.prototype.setupPage;
  const update = scope.Game_Event.prototype.updateSelfMovement, configured = []; let updates = 0;
  scope.Game_Event.prototype.meetsConditions = function(page) {
    if (page === pages[1]) return scope.$gameVariables.value(3) === 7;
    return condition.call(this, page);
  };
  scope.Game_Event.prototype.setupPage = function() { setup.call(this); this._opacity = 100 + this._pageIndex; configured.push(this); };
  scope.Game_Event.prototype.updateSelfMovement = function() { ++updates; return update.call(this); };
  api.newGame(session); const event = scope.$gameMap.event(1);
  assert.equal(event._pageIndex, 0); assert.equal(event._characterName, 'First'); assert.equal(event._opacity, 100);
  assert.equal(configured[0], event);
  scope.$gameVariables.setValue(3, 7); api.step(session, {});
  assert.equal(event._pageIndex, 1); assert.equal(event.findProperPageIndex(), 1);
  assert.equal(event._characterName, 'Second'); assert.equal(event._opacity, 101);
  assert.equal(configured[1], event); assert.ok(updates > 0);
  scope.$gameVariables.setValue(3, 0); api.step(session, {}); assert.equal(event._pageIndex, 0);
  assert.equal(condition.call(event, { conditions: { variableValid: true, variableId: 3, variableValue: 1 } }), false);
});

test('party last-item memory preserves item classes, native saves and retained views', t => {
  const data = fixture([]), session = api.create(data); t.after(() => api.dispose(session));
  const { scope } = createScriptRuntime(api, session);
  for (const name of ['items', 'weapons', 'armors', 'skills']) scope['$data' + name[0].toUpperCase() + name.slice(1)] = data[name];
  api.newGame(session); const party = scope.$gameParty, memory = party._lastItem;
  assert.equal(party.lastItem(), null);
  party.setLastItem(data.weapons[1]); assert.equal(party.lastItem(), data.weapons[1]); assert.equal(memory._dataClass, 'weapon');
  const saved = api.save(session); assert.equal(saved.party._lastItem._dataClass, 'weapon');
  party.setLastItem(data.items[1]); assert.equal(memory.object(), data.items[1]);
  api.load(session, saved); assert.equal(party.lastItem(), data.weapons[1]); assert.equal(memory, party._lastItem);
  const replacement = new scope.Game_Item(data.armors[1]); party._lastItem = replacement; replacement.setObject(null);
  assert.equal(party.lastItem(), data.armors[1]); assert.notEqual(party._lastItem, replacement);
  memory.setObject(data.skills[1]); assert.equal(party.lastItem(), data.skills[1]);
  party.setLastItem(null); assert.equal(party.lastItem(), null);
});

test('character pattern overrides affect native animation and retain event defaults after replacement', t => {
  const { session, scope, step } = create(t, []), player = scope.$gamePlayer;
  player._stepAnime = true; player._pattern = 1; let calls = 0;
  player.maxPattern = function() { ++calls; return 2; };
  for (let frame = 0; frame < 15; ++frame) step();
  assert.ok(calls > 0); assert.equal(player._pattern, 0); assert.equal(player._animationCount, 0);
  player._stepAnime = false; player._stopCount = 1; player.updatePattern(); assert.equal(player._pattern, 1);
  const event = scope.$gameMap.event(1); event._originalPattern = 2; event.setPattern(0); event.resetPattern();
  assert.equal(event._pattern, 2); assert.equal(event.isOriginalPattern(), true);
  api.newGame(session); event.setPattern(0); event.resetPattern(); assert.equal(event._pattern, 2);
  assert.notEqual(scope.$gameMap.event(1), event); assert.equal(scope.$gameMap.event(1)._originalPattern, 1);
});

test('native battle presentation dispatches damage aliases and public motion requests', t => {
  const data = fixture([command(301, [0, 1, true, true]), command(230, [20])]);
  data.system.optSideView = true; data.system.attackMotions = [null, { type: 1, weaponImageId: 2 }];
  data.skills[1] = { id: 1, name: 'Attack', scope: 1, occasion: 1, hitType: 0, successRate: 100, repeats: 1, speed: 0,
    mpCost: 0, tpCost: 0, tpGain: 0, stypeId: 1, animationId: 0, damage: { type: 1, formula: '2', elementId: 0, variance: 0, critical: false }, effects: [] };
  data.enemies = [null, { id: 1, name: 'Enemy', params: [4, 10, 10, 10, 10, 10, 10, 10], traits: [],
    actions: [{ skillId: 1, conditionType: 0, rating: 5 }], exp: 0, gold: 0 }];
  data.troops = [null, { id: 1, members: [{ enemyId: 1, x: 0, y: 0, hidden: false }], pages: [] }];
  const session = api.create(data); t.after(() => api.dispose(session));
  const { scope } = createScriptRuntime(api, session); let damages = 0; const motions = [];
  const performDamage = scope.Game_Actor.prototype.performDamage, requestMotion = scope.Game_Battler.prototype.requestMotion;
  scope.Game_Actor.prototype.performDamage = function() { ++damages; return performDamage.call(this); };
  scope.Game_Battler.prototype.requestMotion = function(type) { motions.push(type); return requestMotion.call(this, type); };
  api.newGame(session); const actor = scope.$gameActors.actor(1);
  actor.performDamage(); assert.equal(actor.motionType(), 'damage'); actor.clearMotion(); assert.equal(actor.motionType(), undefined);
  actor.performAttack(); assert.equal(actor.motionType(), 'swing'); assert.deepEqual(motions, ['damage', 'swing']);
  actor.isSpriteVisible = () => false; actor.performDamage(); assert.equal(scope.$gameScreen._shakePower, 5);
  delete actor.isSpriteVisible; damages = 0;
  api.step(session, {});
  for (let frame = 0; frame < 800 && api.snapshot(session).battle.active; ++frame) {
    if (api.snapshot(session).message.busy) api.acknowledge(session);
    api.step(session, { ok: frame % 2 === 0 });
  }
  assert.ok(damages > 0, 'native damage playback must dispatch the actor alias');
  assert.ok(motions.filter(type => type === 'damage').length > 1);
});

test('native common-event ticking honors class aliases and preserves detached interpreters', t => {
  const data = fixture([]);
  data.commonEvents[1] = { id: 1, trigger: 2, switchId: 1, list: [command(122, [21, 21, 1, 0, 1]), command(230, [2]), command(0)] };
  const session = api.create(data); t.after(() => api.dispose(session));
  const { scope } = createScriptRuntime(api, session); scope.$dataCommonEvents = data.commonEvents;
  const initialize = scope.Game_CommonEvent.prototype.initialize, update = scope.Game_CommonEvent.prototype.update, isActive = scope.Game_CommonEvent.prototype.isActive;
  scope.Game_CommonEvent.prototype.initialize = function(id) { initialize.call(this, id); this.pluginInitialized = true; };
  scope.Game_CommonEvent.prototype.isActive = function() { return isActive.call(this) && scope.$gameVariables.value(3) === 7; };
  scope.Game_CommonEvent.prototype.update = function() { this.pluginUpdates = (this.pluginUpdates || 0) + 1; return update.call(this); };
  api.newGame(session); const common = scope.$gameMap._commonEvents[0];
  assert.equal(common.pluginInitialized, true); assert.equal(common, scope.$gameMap._commonEvents[0]); assert.equal(common._interpreter, null);
  scope.$gameSwitches.setValue(1, true); api.step(session, {}); assert.equal(common._interpreter, null);
  scope.$gameVariables.setValue(3, 7); api.step(session, {});
  assert.equal(scope.$gameVariables.value(21), 1); assert.ok(common.pluginUpdates > 0);
  const retained = common._interpreter, saved = api.save(session);
  assert.equal(saved.map._commonEvents[0]._interpreter._waitCount, retained._waitCount);
  scope.$gameSwitches.setValue(1, false); api.step(session, {}); assert.equal(common._interpreter, null);
  retained.setup([variable(22, 8), command(0)]); retained.update(); assert.equal(scope.$gameVariables.value(22), 8);
  api.load(session, saved); const restored = scope.$gameMap._commonEvents[0], currentInterpreter = restored._interpreter;
  assert.notEqual(restored, common); assert.equal(currentInterpreter._waitCount, saved.map._commonEvents[0]._interpreter._waitCount);
  common.refresh(); assert.notEqual(common._interpreter, currentInterpreter); assert.equal(restored._interpreter, currentInterpreter);
  retained.setup([variable(23, 9), command(0)]); retained.update(); assert.equal(scope.$gameVariables.value(23), 9);
});


test('battler action slots share native identities and survive action replacement and saves', t => {
  const data = fixture([]), session = api.create(data); t.after(() => api.dispose(session));
  const { scope } = createScriptRuntime(api, session);
  for (const name of ['actors', 'classes', 'weapons', 'armors', 'states', 'system', 'skills', 'items']) scope['$data' + name[0].toUpperCase() + name.slice(1)] = data[name];
  api.newGame(session);
  const actor = scope.$gameActors.actor(1);
  actor.makeActions();
  assert.equal(actor.numActions(), 1);
  const action = actor.currentAction();
  assert.equal(action, actor._actions[0]);
  assert.equal(action.subject(), actor);
  action.setSkill(2); action.setTarget(3); action.initialize(actor, true);
  assert.equal(actor.currentAction(), action);
  assert.equal(api.save(session).actors._data[1]._actions[0]._item._itemId, 0);
  action._subject = null; assert.equal(action.subject(), null); action._subject = actor;
  const replacement = new scope.Game_Action(actor, true);
  replacement.setItem(1); replacement.setTarget(2);
  actor.setAction(0, replacement);
  assert.equal(actor.currentAction(), replacement);
  actor.setActionState('waiting'); actor.select();
  const saved = api.save(session);
  assert.equal(saved.actors._data[1]._actions[0]._item._dataClass, 'item');
  assert.equal(saved.actors._data[1]._actions[0]._forcing, true);
  api.load(session, saved);
  const restored = scope.$gameActors.actor(1);
  assert.equal(restored.numActions(), 1);
  assert.equal(restored.currentAction().subject(), restored);
  assert.equal(restored.currentAction()._targetIndex, 2);
  assert.equal(restored._actionState, 'waiting'); assert.equal(restored.isSelected(), true);
  assert.equal(action.subject(), actor);
  actor.clearActions(); assert.equal(actor.numActions(), 0);
  assert.equal(replacement.subject(), actor);
  assert.equal(restored.numActions(), 1);
});

test('script actions apply authored recovery effects and evaluate formulas in the game context', t => {
  const data = fixture([]), session = api.create(data); t.after(() => api.dispose(session));
  data.items[1] = { id: 1, itypeId: 1, hitType: 0, scope: 7, successRate: 100, repeats: 1, tpGain: 0,
    damage: { type: 0, elementId: 0 }, effects: [{ code: 11, dataId: 0, value1: 0, value2: 3 }] };
  const { scope } = createScriptRuntime(api, session);
  for (const name of ['actors', 'classes', 'weapons', 'armors', 'states', 'system', 'skills', 'items']) scope['$data' + name[0].toUpperCase() + name.slice(1)] = data[name];
  api.newGame(session);
  const actor = scope.$gameActors.actor(1), action = new scope.Game_Action(actor);
  actor.setHp(1); action.setItem(1); action.apply(actor);
  assert.equal(actor.hp, 4); assert.equal(actor.result().success, true); assert.equal(actor.result().hpDamage, -3);
  scope.$gameVariables.setValue(1, 7);
  data.items[1].damage = { type: 1, formula: '$gameVariables.value(1) + a.hp - b.hp', variance: 0, elementId: 0 };
  assert.equal(action.evalDamageFormula(actor), 7);
  assert.equal(action.makeDamageValue(actor, false), 7);
});


test('replacing an unconfirmed action preserves earlier native command selections', t => {
  const data = fixture([]);
  data.classes[1].traits.push({ code: 61, dataId: 0, value: 1 });
  data.skills[2] = { id: 2, stypeId: 1, hitType: 1, successRate: 100, scope: 1, occasion: 0,
    damage: { type: 1, formula: '1', variance: 0, critical: false, elementId: 0 }, effects: [] };
  data.enemies = [null, { name: 'Enemy', params: [100, 20, 10, 10, 10, 10, 10, 10], actions: [], traits: [] }];
  data.troops = [null, { members: [{ enemyId: 1, x: 100, y: 100 }], pages: [] }];
  const session = api.create(data); t.after(() => api.dispose(session));
  const { scope } = createScriptRuntime(api, session); api.newGame(session);
  api.startBattle(session, 1, true, true); api.acknowledge(session);
  for (let i = 0; i < 120 && !scope.BattleManager.isInputting(); ++i) api.step(session, {});
  const actor = scope.BattleManager.actor(); assert.equal(actor.numActions(), 2);
  actor.inputtingAction().setSkill(2); actor.inputtingAction().setTarget(0); scope.BattleManager.selectNextCommand();
  assert.equal(actor._actionInputIndex, 1);
  scope.BattleManager.selectPreviousCommand(); assert.equal(actor._actionInputIndex, 0);
  scope.BattleManager.selectNextCommand(); assert.equal(actor._actionInputIndex, 1);
  const replacement = new scope.Game_Action(actor); replacement.setSkill(2); replacement.setTarget(0);
  actor.setAction(1, replacement); assert.equal(scope.BattleManager.inputtingAction(), replacement);
  scope.BattleManager.selectNextCommand(); assert.equal(scope.BattleManager.isInputting(), false);
});


test('a retained action owns its original script subject across collection and a new game', { skip: typeof global.gc !== 'function' }, async t => {
  const { session, scope } = create(t, []);
  let action, subject;
  (() => { const actor = scope.$gameActors.actor(1); subject = new WeakRef(actor); action = new scope.Game_Action(actor); })();
  api.newGame(session);
  for (let i = 0; i < 3; ++i) { await new Promise(resolve => setImmediate(resolve)); global.gc(); }
  assert.ok(subject.deref(), 'retaining an action must retain its subject');
  assert.equal(action.subject(), subject.deref());
  assert.notEqual(action.subject(), scope.$gameActors.actor(1));
});
