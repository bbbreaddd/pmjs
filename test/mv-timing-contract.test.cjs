'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function loadTiming(extra) {
  const code = fs.readFileSync(path.join(__dirname, '../js/pmjs-mv/timing.js'), 'utf8');
  const context = {
    console, performance, Math, Number,
    globalThis: null, SceneManager: undefined,
  };
  context.globalThis = context;
  if (extra) extra(context);
  vm.createContext(context);
  vm.runInContext(code, context);
  return context;
}

test('gate: first call syncs the clock and runs zero steps', () => {
  const ctx = loadTiming();
  const state = ctx.pmjsMvCreateStepGate();
  const gated = ctx.pmjsMvGateSteps(state, 1000);
  assert.equal(gated.steps, 0);
  assert.equal(gated.overload, false);
  assert.equal(state.clockMs, 1000);
});

test('gate: 60 Hz render yields one step per frame', () => {
  const ctx = loadTiming();
  const state = ctx.pmjsMvCreateStepGate();
  ctx.pmjsMvGateSteps(state, 0);
  const gated = ctx.pmjsMvGateSteps(state, 1000 / 60);
  assert.equal(gated.steps, 1);
  assert.equal(gated.overload, false);
});

test('gate: 30 Hz render yields two steps per frame', () => {
  const ctx = loadTiming();
  const state = ctx.pmjsMvCreateStepGate();
  ctx.pmjsMvGateSteps(state, 0);
  const gated = ctx.pmjsMvGateSteps(state, 1000 / 30);
  assert.equal(gated.steps, 2);
  assert.ok(Math.abs(gated.feedMs - 1000 / 30) < 1e-6);
});

test('gate: 120 Hz render alternates zero and one steps', () => {
  const ctx = loadTiming();
  const state = ctx.pmjsMvCreateStepGate();
  ctx.pmjsMvGateSteps(state, 0);
  const first = ctx.pmjsMvGateSteps(state, 1000 / 120);
  const second = ctx.pmjsMvGateSteps(state, 2 * 1000 / 120);
  assert.equal(first.steps, 0);
  assert.equal(second.steps, 1);
});

test('gate: ordinary debt is retained, not discarded', () => {
  const ctx = loadTiming();
  const state = ctx.pmjsMvCreateStepGate();
  ctx.pmjsMvGateSteps(state, 0);
  const gated = ctx.pmjsMvGateSteps(state, 20);
  assert.equal(gated.steps, 1);
  assert.ok(state.accMs > 3 && state.accMs < 3.5,
    `expected ~3.3 ms retained, got ${state.accMs}`);
  const next = ctx.pmjsMvGateSteps(state, 20 + 1000 / 60);
  assert.equal(next.steps, 1);
  assert.equal(next.overload, false);
});

test('gate: 300 ms stall rebases with zero steps and reports overload', () => {
  const ctx = loadTiming();
  const state = ctx.pmjsMvCreateStepGate();
  ctx.pmjsMvGateSteps(state, 0);
  const gated = ctx.pmjsMvGateSteps(state, 300);
  assert.equal(gated.steps, 0);
  assert.equal(gated.overload, true);
  assert.ok(gated.droppedMs >= 300);
  assert.equal(state.accMs, 0);
  const next = ctx.pmjsMvGateSteps(state, 300 + 1000 / 60);
  assert.equal(next.steps, 1);
  assert.equal(next.overload, false);
});

test('gate: sustained overload below the threshold never bursts', () => {
  const ctx = loadTiming();
  const state = ctx.pmjsMvCreateStepGate();
  ctx.pmjsMvGateSteps(state, 0);
  let now = 0;
  for (let frame = 0; frame < 10; frame++) {
    now += 40;
    const gated = ctx.pmjsMvGateSteps(state, now);
    assert.ok(gated.steps <= 2, `frame ${frame} ran ${gated.steps} steps`);
  }
});

test('gate: clock step-back resyncs without steps or overload', () => {
  const ctx = loadTiming();
  const state = ctx.pmjsMvCreateStepGate();
  ctx.pmjsMvGateSteps(state, 1000);
  const gated = ctx.pmjsMvGateSteps(state, 500);
  assert.equal(gated.steps, 0);
  assert.equal(gated.overload, false);
});

function stockShapedScene() {
  return {
    _deltaTime: 1 / 60,
    _currentTime: 0,
    _accumulator: 0,
    _getTimeInMsWithoutMobileSafari() { return this._now; },
    _now: 0,
    logicSteps: 0,
    renders: 0,
    updateInputData() {},
    changeScene() {},
    updateScene() { this.logicSteps++; },
    renderScene() { this.renders++; },
    requestUpdate() {},
    updateMain() {
      const newTime = this._getTimeInMsWithoutMobileSafari();
      let fTime = (newTime - this._currentTime) / 1000;
      if (fTime > 0.25) fTime = 0.25;
      this._currentTime = newTime;
      this._accumulator += fTime;
      while (this._accumulator >= this._deltaTime) {
        this.updateInputData();
        this.changeScene();
        this.updateScene();
        this._accumulator -= this._deltaTime;
      }
      this.renderScene();
      this.requestUpdate();
    },
  };
}

test('contract: stock-shaped updateMain is bounded to 2 steps at 30 Hz', () => {
  const ctx = loadTiming();
  ctx.SceneManager = stockShapedScene();
  ctx.performance = { now: () => ctx.SceneManager._now };
  assert.equal(ctx.pmjsMvInstallTimingContract(), true);
  assert.equal(ctx.SceneManager._deltaTime, 1 / 60);
  ctx.SceneManager._now = 0;
  ctx.SceneManager.updateMain();
  assert.equal(ctx.SceneManager.logicSteps, 0); // clock sync, no debt yet
  ctx.SceneManager._now = 1000 / 30;
  ctx.SceneManager.updateMain();
  assert.equal(ctx.SceneManager.logicSteps, 2);
  assert.equal(ctx.SceneManager.renders, 2); // one presentation per call
});

test('contract: 300 ms stall executes zero catch-up steps then recovers', () => {
  const ctx = loadTiming();
  const logs = [];
  ctx.console = { log: (message) => logs.push(String(message)) };
  ctx.SceneManager = stockShapedScene();
  ctx.performance = { now: () => ctx.SceneManager._now };
  ctx.pmjsMvInstallTimingContract();
  ctx.SceneManager._now = 0;
  ctx.SceneManager.updateMain();
  ctx.SceneManager._now = 300;
  ctx.SceneManager.updateMain();
  assert.equal(ctx.SceneManager.logicSteps, 0);
  assert.ok(logs.some((line) => line.includes('overload-discontinuity')),
    `expected overload log, got ${JSON.stringify(logs)}`);
  ctx.SceneManager._now = 300 + 1000 / 60;
  ctx.SceneManager.updateMain();
  assert.equal(ctx.SceneManager.logicSteps, 1);
});

test('contract: stock-shaped plugin override is wrapped, not replaced', () => {
  const ctx = loadTiming();
  ctx.SceneManager = stockShapedScene();
  ctx.performance = { now: () => ctx.SceneManager._now };
  ctx.pmjsMvInstallTimingContract();
  const wrapped = ctx.SceneManager.updateMain;
  ctx.SceneManager.updateMain = stockShapedScene().updateMain;
  assert.equal(ctx.pmjsMvEnsureTimingContract(), true);
  assert.notEqual(ctx.SceneManager.updateMain, wrapped);
  assert.equal(ctx.SceneManager.updateMain._pmjsTimingWrapped, true);
  ctx.SceneManager._now = 0;
  ctx.SceneManager.updateMain();
  ctx.SceneManager._now = 1000 / 30;
  ctx.SceneManager.updateMain();
  assert.equal(ctx.SceneManager.logicSteps, 2);
});

test('contract: direct-stepping override is refused, never wrapped', () => {
  const logs = [];
  const ctx = loadTiming((context) => {
    context.console = { log: (message) => logs.push(String(message)) };
  });
  ctx.SceneManager = stockShapedScene();
  ctx.performance = { now: () => ctx.SceneManager._now };
  ctx.SceneManager.updateMain = function() {
    this.updateInputData();
    this.changeScene();
    this.updateScene();
    this.renderScene();
  };
  assert.equal(ctx.pmjsMvRecognizesUpdateMain(ctx.SceneManager.updateMain), false);
  assert.equal(ctx.pmjsMvInstallTimingContract(), false);
  assert.equal(ctx.SceneManager.updateMain._pmjsTimingWrapped, undefined);
  assert.equal(ctx.__pmjsTimingFallback, 'unrecognized-updateMain');
  assert.ok(logs.some((line) => line.includes('timing-contract refused')));
  assert.equal(ctx.pmjsMvEnsureTimingContract(), false);
  assert.equal(ctx.SceneManager.updateMain._pmjsTimingWrapped, undefined);
});

test('contract: stock clock drift inside updateMain cannot add a step', () => {
  const ctx = loadTiming();
  ctx.SceneManager = stockShapedScene();
  const STEP = 1000 / 60;
  ctx.performance = { now: () => ctx.SceneManager._now };
  ctx.SceneManager._getTimeInMsWithoutMobileSafari = function() {
    return this._now + 0.005; // 5us of re-read drift per stock call
  };
  ctx.pmjsMvInstallTimingContract();
  ctx.SceneManager._now = 0;
  ctx.SceneManager.updateMain();
  ctx.SceneManager._now = STEP - 0.001; // gate: 0 steps, feed just under STEP
  ctx.SceneManager.updateMain();
  assert.equal(ctx.SceneManager.logicSteps, 0);
  ctx.SceneManager._now = STEP + 0.001;
  ctx.SceneManager.updateMain();
  assert.equal(ctx.SceneManager.logicSteps, 1);
});

test('contract: install is a no-op without SceneManager', () => {
  const ctx = loadTiming();
  assert.equal(ctx.pmjsMvInstallTimingContract(), false);
  assert.equal(ctx.pmjsMvEnsureTimingContract(), false);
});
