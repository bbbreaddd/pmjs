'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');
const { loadPmjsRuntime } = require('../../helpers/runtime-context.cjs');
const source = fs.readFileSync(require.resolve('../../../patches/isat/static-events.js'), 'utf8');

function fixture({ unknownPredecessor = false, changedPredecessor = false } = {}) {
  const context = loadPmjsRuntime({ __pmjsBuiltinRequire: require });
  vm.runInContext(`
    function Game_CharacterBase() {}
    function Game_Character() {}
    function Game_Event() {}
    Game_Character.prototype = Object.create(Game_CharacterBase.prototype);
    Game_Event.prototype = Object.create(Game_Character.prototype);
    function Game_Map() { this._mapId = 30; this.events = []; }
    Game_Map.prototype.updateEvents = function() {
      for (const event of this.events) event.update();
      if (this.fail) throw this.fail;
    };
    var Galv = { CA: {} }, Yanfly = { ECP: {} };
  `, context);
  const digest = fn => context.PMJS.methods.fingerprint(context.PMJS.methods.sourceOf(fn));
  const hashes = JSON.parse(source.match(/var methodHashes = ([\s\S]*?);/)[1]);
  for (const [owner, methods] of Object.entries(hashes)) {
    for (const name of Object.keys(methods)) {
      context[owner].prototype[name] = vm.runInContext('(function() {})', context);
    }
  }
  context.Game_Event.prototype.update = function() {
    this.ordinary = (this.ordinary || 0) + 1;
    this._stopCount++;
    this._alertLock--;
  };
  const original = context.Game_Event.prototype.update;
  const predecessor = function() { this.predecessor = true; };
  context.Galv.CA.Game_Character_update = context.Game_CharacterBase.prototype.update;
  context.Yanfly.ECP.Game_Event_update = predecessor;
  let adapted = source.replace(/var methodHashes = ([\s\S]*?);/, () => {
    for (const [owner, methods] of Object.entries(hashes)) {
      for (const name of Object.keys(methods)) methods[name] = digest(context[owner].prototype[name]);
    }
    return 'var methodHashes = ' + JSON.stringify(hashes) + ';';
  }).replace('7d33fee1f625b00d52d89dc8c0bfbaa878ac997e10243572b0abb1a60fc5b629', digest(predecessor));
  context.PMJS.isatSourceQualification = { verified: true };
  if (unknownPredecessor) context.Yanfly.ECP.Game_Event_update = function customUpdate() {};
  if (changedPredecessor) context.Galv.CA.Game_Character_update = function customBaseUpdate() {};
  vm.runInContext(adapted, context);
  context.PMJS.phases.emit('afterGuestPlugins');
  const event = Object.assign(new context.Game_Event(), {
    _erased: false, _moveType: 0, _trigger: 0, disableCharAnims: true,
    _realX: 1, _x: 1, _realY: 2, _y: 2, _jumpCount: 0, _locked: false,
    _moveRouteForcing: false, _stepAnime: false, _isDashing: false,
    _pattern: 1, _originalPattern: 1, _animationCount: 0, _moveSpeed: 4,
    _chasePlayer: false, _fleePlayer: false, _alertPlayer: false, _returnPhase: false,
    _stopCount: 3, _alertLock: 5
  });
  const map = new context.Game_Map(); map.events.push(event);
  return { context, event, map, original };
}

test('qualified Map 30 events install successfully and advance both clocks without ordinary work', () => {
  const f = fixture();
  assert.notEqual(f.context.Game_Event.prototype.update, f.original);
  f.map.updateEvents();
  assert.equal(f.event.ordinary, undefined);
  assert.equal(f.event._stopCount, 4);
  assert.equal(f.event._alertLock, 4);
});

test('ordinary maps, unsettled events and direct updates retain authored execution', () => {
  const f = fixture();
  f.map._mapId = 29; f.map.updateEvents();
  f.map._mapId = 30; f.event._moveType = 1; f.map.updateEvents();
  f.event._moveType = 0; f.event.update();
  assert.equal(f.event.ordinary, 3);
  assert.equal(f.event._stopCount, 6);
  assert.equal(f.event._alertLock, 2);
});

for (const options of [{ unknownPredecessor: true }, { changedPredecessor: true }]) {
  test('unrecognized predecessors refuse activation without replacing the event method: ' + JSON.stringify(options), () => {
    const f = fixture(options);
    assert.equal(f.context.Game_Event.prototype.update, f.original);
    assert.match(f.context.PMJS.optimizations.reason('isat.dormont-static-events'), /unrecognized event update predecessors/);
  });
}

for (const change of [
  f => { f.context.Game_CharacterBase.prototype.updateAnimation = function changedAnimation() {}; },
  f => { f.context.Yanfly.ECP.Game_Event_update = function changedPredecessor() {}; }
]) {
  test('late update-graph changes delegate to authored execution', () => {
    const f = fixture(); change(f); f.map.updateEvents();
    assert.equal(f.event.ordinary, 1);
  });
}

test('throwing map updates restore the scope before subsequent direct event updates', () => {
  const f = fixture(); const failure = f.map.fail = new Error('map update');
  assert.throws(() => f.map.updateEvents(), error => error === failure);
  f.event.update();
  assert.equal(f.event.ordinary, 1);
});
