'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function loadInput(native) {
  const context = {
    console,
    NativeHost: {
      input: native,
      runtime: { loadScript() {} },
    },
    Input: {
      _currentState: {},
      _previousState: {},
      _latestButton: null,
      _pressedTime: 0,
      _date: 0,
      keyMapper: undefined,
      gamepadMapper: undefined,
      update() {
        if (this._currentState[this._latestButton]) {
          this._pressedTime++;
        } else {
          this._latestButton = null;
        }
        for (const name in this._currentState) {
          if (this._currentState[name] && !this._previousState[name]) {
            this._latestButton = name;
            this._pressedTime = 0;
            this._date = Date.now();
          }
          this._previousState[name] = this._currentState[name];
        }
      },
      isPressed(keyName) { return !!this._currentState[keyName]; },
      isTriggered(keyName) {
        return this._latestButton === keyName && this._pressedTime === 0;
      },
    },
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, '../js/pmjs-mv/input.js'), 'utf8'), context);
  return context;
}

function latchedNative() {
  const state = { down: false, pressed: false, consumes: 0 };
  return {
    state,
    down: (action) => action === 'ok' && state.down,
    pressed: (action) => action === 'ok' && state.pressed,
    consumePressed: () => { state.consumes++; state.pressed = false; },
  };
}

test('sub-frame tap triggers exactly once, then clears', () => {
  const native = latchedNative();
  const ctx = loadInput(native);
  native.state.down = false;
  native.state.pressed = true;
  ctx.Input.update();
  assert.equal(ctx.Input.isPressed('ok'), true);
  assert.equal(ctx.Input.isTriggered('ok'), true);
  assert.equal(native.state.consumes, 1);
  assert.equal(native.state.pressed, false);
  ctx.Input.update();
  assert.equal(ctx.Input.isPressed('ok'), false);
  assert.equal(ctx.Input.isTriggered('ok'), false);
});

test('held input triggers once, then reads as held', () => {
  const native = latchedNative();
  const ctx = loadInput(native);
  native.state.down = true;
  native.state.pressed = true;
  ctx.Input.update();
  assert.equal(ctx.Input.isTriggered('ok'), true);
  native.state.pressed = false;
  ctx.Input.update();
  assert.equal(ctx.Input.isTriggered('ok'), false);
  assert.equal(ctx.Input.isPressed('ok'), true);
});

test('two logic steps sharing one frame fire a single trigger', () => {
  const native = latchedNative();
  const ctx = loadInput(native);
  native.state.down = true;
  native.state.pressed = true;
  ctx.Input.update(); // step 1 of a 30 Hz frame
  assert.equal(ctx.Input.isTriggered('ok'), true);
  ctx.Input.update(); // step 2: latch consumed, held remains
  assert.equal(ctx.Input.isTriggered('ok'), false);
  assert.equal(ctx.Input.isPressed('ok'), true);
});

test('render-only frames do not consume the latch (no Input.update, no consume)', () => {
  const native = latchedNative();
  loadInput(native);
  native.state.down = false;
  native.state.pressed = true;
  assert.equal(native.state.consumes, 0);
  assert.equal(native.state.pressed, true);
});
