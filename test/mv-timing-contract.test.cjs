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

test('phase-locked gate: 60 Hz with +/- 1.0 ms jitter never yields 0 or 2 steps', () => {
  const ctx = loadTiming();
  const state = ctx.pmjsMvCreateStepGate({ renderHz: 60, catchupMode: 'smooth' });
  ctx.pmjsMvGateSteps(state, 0); // initial sync

  const stepMs = 1000 / 60;
  // Simulate 30 frames with random-like arrival jitter between -1.0 ms and +1.0 ms
  const jitters = [-0.7, 0.8, -0.9, 0.5, -0.4, 0.9, -0.8, 0.2, -0.6, 0.7,
                   -0.5, 0.6, -0.7, 0.4, -0.3, 0.8, -0.6, 0.3, -0.5, 0.7,
                   -0.8, 0.5, -0.4, 0.6, -0.7, 0.3, -0.5, 0.6, -0.4, 0.5];
  let time = 0;
  for (let i = 0; i < jitters.length; i++) {
    time = (i + 1) * stepMs + jitters[i];
    const gated = ctx.pmjsMvGateSteps(state, time);
    assert.equal(gated.steps, 1, `frame ${i} at ${time.toFixed(2)}ms expected 1 step, got ${gated.steps}`);
    assert.equal(gated.overload, false);
  }
});

test('phase-locked gate: smooth catchup rebases and avoids 2-step burst on 45 ms hitch', () => {
  const ctx = loadTiming();
  const state = ctx.pmjsMvCreateStepGate({ renderHz: 60, catchupMode: 'smooth' });
  ctx.pmjsMvGateSteps(state, 0);

  // Frame 1 normal
  const f1 = ctx.pmjsMvGateSteps(state, 16.67);
  assert.equal(f1.steps, 1);

  // 45 ms hitch: time jumps from 16.67 to 61.67
  const f2 = ctx.pmjsMvGateSteps(state, 61.67);
  assert.equal(f2.steps, 1, 'smooth catchup must execute exactly 1 step on slow frame');
  assert.equal(f2.overload, false);
  assert.ok(f2.droppedMs > 0, `expected droppedMs > 0, got ${f2.droppedMs}`);

  // Frame 3 returns to normal 16.67 ms cadence: should execute exactly 1 step (NO catchup burst)
  const f3 = ctx.pmjsMvGateSteps(state, 61.67 + 16.67);
  assert.equal(f3.steps, 1, 'subsequent frame must execute exactly 1 step without catchup burst');
  assert.equal(f3.overload, false);
});

test('phase-locked gate: burst catchup mode permits up to 2 steps after hitch', () => {
  const ctx = loadTiming();
  const state = ctx.pmjsMvCreateStepGate({ renderHz: 60, catchupMode: 'burst' });
  ctx.pmjsMvGateSteps(state, 0);

  // Hitch of 40 ms
  const gated = ctx.pmjsMvGateSteps(state, 40);
  assert.equal(gated.steps, 2, 'burst mode should catch up up to BASE_MAX_STEPS_PER_FRAME');
});

test('phase-locked gate: PLL tracking keeps phase aligned under 59.94 Hz drift', () => {
  const ctx = loadTiming();
  const state = ctx.pmjsMvCreateStepGate({ renderHz: 60, catchupMode: 'smooth' });
  ctx.pmjsMvGateSteps(state, 0);

  // 59.94 Hz = 16.6833 ms per frame. Run 120 frames (~2 seconds).
  const frameInterval = 1000 / 59.94;
  let time = 0;
  for (let i = 0; i < 120; i++) {
    time += frameInterval;
    const gated = ctx.pmjsMvGateSteps(state, time);
    assert.equal(gated.steps, 1, `frame ${i} should yield 1 step under drift`);
  }
});

test('phase-locked gate: 30 Hz render yields two 60 Hz logic steps per presentation slot', () => {
  const ctx = loadTiming();
  const state = ctx.pmjsMvCreateStepGate({ renderHz: 30 });
  ctx.pmjsMvGateSteps(state, 0);

  const slot30Ms = 1000 / 30;
  // Frame 1
  const f1 = ctx.pmjsMvGateSteps(state, slot30Ms);
  assert.equal(f1.steps, 2, '30 Hz presentation must yield 2 logic steps');

  // Frame 2
  const f2 = ctx.pmjsMvGateSteps(state, 2 * slot30Ms);
  assert.equal(f2.steps, 2, 'subsequent 30 Hz presentation must yield 2 logic steps');
});

test('phase-locked gate: 120 Hz render alternates 0 and 1 logic steps to maintain 60 Hz simulation', () => {
  const ctx = loadTiming();
  const state = ctx.pmjsMvCreateStepGate({ renderHz: 120 });
  ctx.pmjsMvGateSteps(state, 0);

  const slot120Ms = 1000 / 120;
  const f1 = ctx.pmjsMvGateSteps(state, slot120Ms);
  assert.equal(f1.steps, 0, 'first 120 Hz slot accumulates ~8.3 ms, yielding 0 steps');

  const f2 = ctx.pmjsMvGateSteps(state, 2 * slot120Ms);
  assert.equal(f2.steps, 1, 'second 120 Hz slot reaches ~16.7 ms, yielding 1 step');

  const f3 = ctx.pmjsMvGateSteps(state, 3 * slot120Ms);
  assert.equal(f3.steps, 0);

  const f4 = ctx.pmjsMvGateSteps(state, 4 * slot120Ms);
  assert.equal(f4.steps, 1);
});

test('phase-locked gate: reads globalThis.__pmjsTimingConfig when options omitted', () => {
  const ctx = loadTiming((context) => {
    context.globalThis.__pmjsTimingConfig = { renderHz: 30, catchupMode: 'burst' };
  });
  const state = ctx.pmjsMvCreateStepGate();
  assert.equal(state.renderHz, 30);
  assert.equal(state.catchupMode, 'burst');
  ctx.pmjsMvGateSteps(state, 0);
  const f1 = ctx.pmjsMvGateSteps(state, 1000 / 30);
  assert.equal(f1.steps, 2);
});

test('phase-locked gate: 30 Hz burst catchup mode pays off debt at bounded rate of 3 steps/frame', () => {
  const ctx = loadTiming();
  const state = ctx.pmjsMvCreateStepGate({ renderHz: 30, catchupMode: 'burst' });
  ctx.pmjsMvGateSteps(state, 0);

  const slot30Ms = 1000 / 30;
  // Normal frame 1: 2 steps
  const f1 = ctx.pmjsMvGateSteps(state, slot30Ms);
  assert.equal(f1.steps, 2);

  // Hitch: missed 1 presentation slot (elapsed = 2 * slot30Ms = 66.67 ms).
  // Total logic owed: 4 steps. With bounded catch-up (maxSteps = nominal 2 + 1 = 3):
  // executes 3 steps, retains 1 step of debt in accMs (~16.67 ms).
  const f2 = ctx.pmjsMvGateSteps(state, 3 * slot30Ms);
  assert.equal(f2.steps, 3, 'burst at 30 Hz must execute max 3 steps on hitch');
  assert.ok(Math.abs(state.accMs - (1000 / 60)) < 0.1, `expected ~16.67 ms debt, got ${state.accMs}`);

  // Normal frame 3 (elapsed = 1 slot): adds 2 steps, total debt = 3 steps.
  // Executes 3 steps, paying off all remaining debt!
  const f3 = ctx.pmjsMvGateSteps(state, 4 * slot30Ms);
  assert.equal(f3.steps, 3, 'burst at 30 Hz executes 3 steps to retire remaining debt');
  assert.ok(Math.abs(state.accMs) < 0.1, `expected 0 debt, got ${state.accMs}`);

  // Normal frame 4: back to nominal 2 steps.
  const f4 = ctx.pmjsMvGateSteps(state, 5 * slot30Ms);
  assert.equal(f4.steps, 2, 'subsequent frame returns to nominal 2 steps');
});

test('gate creation validates catchupMode and renderHz strictly', () => {
  const ctx = loadTiming();
  assert.throws(() => ctx.pmjsMvCreateStepGate({ catchupMode: 'smooh' }),
    /catchupMode must be "smooth" or "burst"/);
  assert.throws(() => ctx.pmjsMvCreateStepGate({ catchupMode: 'invalid' }),
    /catchupMode must be "smooth" or "burst"/);
  assert.throws(() => ctx.pmjsMvCreateStepGate({ renderHz: -60 }),
    /renderHz must be a non-negative finite number/);
  assert.throws(() => ctx.pmjsMvCreateStepGate({ renderHz: NaN }),
    /renderHz must be a non-negative finite number/);
});
