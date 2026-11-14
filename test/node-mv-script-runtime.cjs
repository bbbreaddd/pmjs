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

test('native interpreter waits for a script-driven finite picture animation and sprite frame', t => {
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
  const baseSprite = scope.Sprite_Picture.prototype.updateOther;
  scope.Sprite_Picture.prototype.updateOther = function() {
    baseSprite.call(this);
    const remaining = this.picture().framesRemaining;
    this.setFrame((3 - remaining) * 8, 0, 8, 8);
  };
  step(); step();
  assert.equal(api.snapshot(session).variables[9], undefined);
  step();
  assert.equal(scope.$gameScreen.picture(1).framesRemaining, 0);
  assert.equal(api.snapshot(session).variables[9], undefined);
  const sprite = scope.SceneManager._scene._spriteset._pictureContainer.children[1];
  assert.deepEqual([sprite._frame.x, sprite._frame.width], [24, 8]);
  const frame = sprite._frame;
  frame.x = 16;
  assert.equal(sprite._frame, frame);
  assert.equal(sprite._frame.x, 16);
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
  assert.throws(() => { interpreter._list = []; }, /native command array/);
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
