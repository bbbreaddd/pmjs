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
  assert.throws(() => { interpreter._index = -1; }, /nonnegative integer/);
  api.load(session, api.save(session));
  assert.throws(() => interpreter._index, /no longer attached/);
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
