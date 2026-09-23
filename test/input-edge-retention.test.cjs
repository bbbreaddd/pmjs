'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function setup() {
  let install;
  let consumed = 0;
  const listeners = {};
  const context = {
    NativeHost: {
      input: { consumePressed() { consumed++; } },
      runtime: { env: () => '', now: () => 0,
        platform: () => ({ platform: 'linux', arch: 'x64' }),
        displaySize: () => ({ width: 640, height: 480 }),
        windowSize: () => ({ width: 640, height: 480 }) }
    },
    PMJS: { phases: { on(_name, _owner, callback) { install = callback; } } },
    addEventListener(type, callback) { (listeners[type] ||= []).push(callback); },
    dispatchEvent(event) { for (const callback of listeners[event.type] || []) callback(event); },
    document: { addEventListener(type, callback) { (listeners[type] ||= []).push(callback); },
      dispatchEvent(event) { for (const callback of listeners[event.type] || []) callback(event); },
      hasFocus() { return context.nativeWindowState.focused; } }
  };
  context.globalThis = context;
  context.Input = {
    keyMapper: { 65: 'tag', 67: 'ok', 90: 'ok', 37: 'left' },
    gamepadMapper: { 3: 'tag', 12: 'up', 14: 'left' },
    clear() { this._currentState = {}; this._previousState = {}; this._gamepadStates = []; this._latestButton = null; this._pressedTime = 0; },
    _onKeyDown(event) { const action = this.keyMapper[event.keyCode]; if (action) this._currentState[action] = true; },
    _onKeyUp(event) { const action = this.keyMapper[event.keyCode]; if (action) this._currentState[action] = false; },
    _updateGamepadState(pad) {
      const previous = this._gamepadStates[pad.index] || [];
      const next = pad.buttons.map(button => button.pressed);
      next[12] ||= pad.axes[1] < -0.5;
      next[13] ||= pad.axes[1] > 0.5;
      next[14] ||= pad.axes[0] < -0.5;
      next[15] ||= pad.axes[0] > 0.5;
      for (let i = 0; i < next.length; i++) {
        if (next[i] !== previous[i] && this.gamepadMapper[i]) this._currentState[this.gamepadMapper[i]] = next[i];
      }
      this._gamepadStates[pad.index] = next;
    },
    update() {
      for (const pad of context.navigator.getGamepads()) if (pad?.connected) this._updateGamepadState(pad);
      if (this._currentState[this._latestButton]) this._pressedTime++;
      else this._latestButton = null;
      for (const action in this._currentState) {
        if (this._currentState[action] && !this._previousState[action]) {
          this._latestButton = action; this._pressedTime = 0;
        }
        this._previousState[action] = this._currentState[action];
      }
    },
    isPressed(action) { return !!this._currentState[action]; },
    isTriggered(action) { return this._latestButton === action && this._pressedTime === 0; }
  };
  context.Input.clear();
  context.document.addEventListener('keydown', event => context.Input._onKeyDown(event));
  context.document.addEventListener('keyup', event => context.Input._onKeyUp(event));
  context.addEventListener('blur', () => context.Input.clear());
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/pmjs-web/runtime.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/pmjs-rpgmaker/input.js'), 'utf8'), context);
  install();
  return { context, consumed: () => consumed };
}

function key(code, down, repeat = false) {
  return { keyCode: code, code: 'Key' + String.fromCharCode(code), key: String.fromCharCode(code), down, repeat };
}
function snapshot(keysDown = [], keysPressed = [], keyEvents = [], gamepads = []) {
  return { keysDown, keysPressed, keyEvents, gamepads };
}
function pad(buttonsDown = [], buttonsPressed = [], axes = [0, 0, 0, 0]) {
  return { index: 0, instance: 7, id: 'Xbox Controller', buttonsDown, buttonsPressed, axes };
}

test('keyboard events use live mapper and preserve a short tap for one logic step', () => {
  const { context: ctx, consumed } = setup();
  ctx.__pmjsReceiveInput(snapshot([], [65], [key(65, true), key(65, false)]));
  assert.equal(ctx.Input.isPressed('tag'), true);
  ctx.Input.update();
  assert.equal(ctx.Input.isTriggered('tag'), true);
  assert.equal(ctx.Input.isPressed('tag'), false);
  ctx.Input.update();
  assert.equal(ctx.Input.isTriggered('tag'), false);
  assert.equal(consumed(), 2);
  ctx.Input.keyMapper[65] = undefined;
  ctx.Input.keyMapper[67] = 'tag';
  ctx.__pmjsReceiveInput(snapshot([67], [67], [key(67, true)]));
  ctx.Input.update();
  assert.equal(ctx.Input.isPressed('tag'), true);
  assert.equal(ctx.Input.isTriggered('tag'), true);
  ctx.Input.update();
  assert.equal(ctx.Input.isTriggered('tag'), false);
});

test('gamepad shape, mapper, axes, and disconnect follow stock polling', () => {
  const { context: ctx } = setup();
  assert.deepEqual(Array.from(ctx.navigator.getGamepads()), []);
  ctx.__pmjsReceiveInput(snapshot([], [], [], [pad([3], [3])]));
  const first = ctx.navigator.getGamepads()[0];
  assert.equal(first.id, 'Xbox Controller');
  assert.equal(first.mapping, 'standard');
  assert.equal(first.buttons[3].pressed, true);
  const pressedDescriptor = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(first.buttons[3]), 'pressed');
  assert.equal(typeof pressedDescriptor.get, 'function');
  Object.defineProperty(first.buttons[3], 'pressed', pressedDescriptor);
  assert.equal(first.buttons[3].pressed, true);
  ctx.Input.update();
  assert.equal(ctx.Input.isTriggered('tag'), true);
  ctx.Input.gamepadMapper[3] = 'ok';
  ctx.Input.update();
  assert.equal(ctx.Input.isPressed('tag'), false);
  assert.equal(ctx.Input.isPressed('ok'), true);
  ctx.__pmjsReceiveInput(snapshot([], [], [], [pad([3], [], [-1, 0, 0, 0])]));
  assert.equal(ctx.navigator.getGamepads()[0], first);
  ctx.Input.update();
  assert.equal(ctx.Input.isPressed('left'), true);
  ctx.__pmjsReceiveInput(snapshot());
  ctx.Input.update();
  assert.equal(ctx.Input.isPressed('ok'), false);
  assert.equal(ctx.Input.isPressed('left'), false);
});

test('gamepads stay hidden until focused interaction and preserve the exposing state', () => {
  const { context: ctx } = setup();
  ctx.__pmjsReceiveInput(snapshot([], [], [], [pad()]));
  assert.deepEqual(Array.from(ctx.navigator.getGamepads()), []);

  ctx.__pmjsUpdateWindowState({ focused: false, visible: true });
  ctx.__pmjsReceiveInput(snapshot([], [], [], [pad([3], [3])]));
  assert.deepEqual(Array.from(ctx.navigator.getGamepads()), []);

  ctx.__pmjsUpdateWindowState({ focused: true, visible: true });
  ctx.__pmjsReceiveInput(snapshot([], [], [], [pad([], [], [0, -0.6, 0, 0])]));
  const [first] = ctx.navigator.getGamepads();
  assert.equal(first.axes[1], -0.6);
  assert.equal(first.buttons[3].pressed, false);

  ctx.__pmjsReceiveInput(snapshot([], [], [], [pad()]));
  assert.equal(ctx.navigator.getGamepads()[0], first);
  assert.equal(first.connected, true);
});

test('focus loss clears held keyboard state', () => {
  const { context: ctx } = setup();
  ctx.__pmjsReceiveInput(snapshot([37], [37], [key(37, true)]));
  ctx.Input.update();
  assert.equal(ctx.Input.isPressed('left'), true);
  ctx.__pmjsUpdateWindowState({ focused: false, visible: true });
  assert.equal(ctx.Input.isPressed('left'), false);
});

test('gamepad tap between logic steps triggers once', () => {
  const { context: ctx, consumed } = setup();
  ctx.__pmjsReceiveInput(snapshot([], [], [], [pad([], [3])]));
  assert.equal(ctx.navigator.getGamepads()[0].buttons[3].pressed, true);
  assert.equal(consumed(), 0);
  ctx.Input.update();
  assert.equal(ctx.Input.isTriggered('tag'), true);
  ctx.Input.update();
  assert.equal(ctx.Input.isTriggered('tag'), false);
  assert.equal(ctx.Input.isPressed('tag'), false);
});

test('disconnect keeps another controller at its browser index', () => {
  const { context: ctx } = setup();
  const second = { ...pad([3]), index: 1, instance: 8, id: 'Second Controller' };
  ctx.__pmjsReceiveInput(snapshot([], [], [], [pad(), second]));
  const stable = ctx.navigator.getGamepads()[1];
  ctx.__pmjsReceiveInput(snapshot([], [], [], [
    { index: 0, instance: -1, connected: false, id: '', buttonsDown: [], buttonsPressed: [], axes: [] },
    second
  ]));
  assert.equal(ctx.navigator.getGamepads()[0], null);
  assert.equal(ctx.navigator.getGamepads()[1], stable);
  assert.equal(stable.index, 1);
});

test('one keyboard event dispatch reaches the shared document and window target once', () => {
  const { context: ctx } = setup();
  let delivered = 0;
  ctx.addEventListener('keydown', () => { delivered++; });
  ctx.__pmjsReceiveInput(snapshot([65], [65], [key(65, true)]));
  assert.equal(delivered, 1);
});

test('remapping one of two held keys preserves their shared old action', () => {
  const { context: ctx } = setup();
  ctx.Input.keyMapper[13] = 'ok';
  ctx.__pmjsReceiveInput(snapshot([13, 90], [13, 90], [key(13, true), key(90, true)]));
  ctx.Input.update();
  assert.equal(ctx.Input.isPressed('ok'), true);
  ctx.Input.keyMapper[90] = 'tag';
  ctx.__pmjsReceiveInput(snapshot([13, 90]));
  ctx.Input.update();
  assert.equal(ctx.Input.isPressed('ok'), true);
  assert.equal(ctx.Input.isPressed('tag'), true);
});

test('gamepad remap preserves an action held by the keyboard', () => {
  const { context: ctx } = setup();
  ctx.Input.gamepadMapper[3] = 'ok';
  ctx.__pmjsReceiveInput(snapshot([67], [67], [key(67, true)], [pad([3], [3])]));
  ctx.Input.update();
  assert.equal(ctx.Input.isPressed('ok'), true);

  ctx.Input.gamepadMapper[3] = 'tag';
  ctx.__pmjsReceiveInput(snapshot([67], [], [], [pad([3])]));
  ctx.Input.update();
  assert.equal(ctx.Input.isPressed('ok'), true);
  assert.equal(ctx.Input.isPressed('tag'), true);
});

test('gamepad remap preserves an action held by another gamepad button', () => {
  const { context: ctx } = setup();
  ctx.Input.gamepadMapper[3] = 'ok';
  ctx.Input.gamepadMapper[2] = 'ok';
  ctx.__pmjsReceiveInput(snapshot([], [], [], [pad([2, 3], [2, 3])]));
  ctx.Input.update();
  assert.equal(ctx.Input.isPressed('ok'), true);

  ctx.Input.gamepadMapper[3] = 'tag';
  ctx.__pmjsReceiveInput(snapshot([], [], [], [pad([2, 3])]));
  ctx.Input.update();
  assert.equal(ctx.Input.isPressed('ok'), true);
  assert.equal(ctx.Input.isPressed('tag'), true);
});

test('gamepad remap includes a latched keyboard press', () => {
  const { context: ctx } = setup();
  ctx.Input.gamepadMapper[3] = 'ok';
  ctx.__pmjsReceiveInput(snapshot([], [], [], [pad([3], [3])]));
  ctx.Input.update();

  ctx.Input.gamepadMapper[3] = 'tag';
  ctx.__pmjsReceiveInput(snapshot([], [67], [], [pad([3])]));
  ctx.Input.update();
  assert.equal(ctx.Input.isPressed('ok'), true);
  assert.equal(ctx.Input.isPressed('tag'), true);
});
