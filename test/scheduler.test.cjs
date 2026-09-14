'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadSchedulerContext(extraSetup) {
  const schedulerCode = fs.readFileSync(
    path.join(__dirname, '../js/pmjs-web/scheduler.js'),
    'utf8'
  );
  const context = {
    console: console,
    performance: performance,
    Math: Math,
    Number: Number,
    TypeError: TypeError,
    Map: Map
  };
  context.globalThis = context;
  context.window = context;
  if (typeof extraSetup === 'function') {
    extraSetup(context);
  }
  vm.createContext(context);
  vm.runInContext(schedulerCode, context);
  return context;
}

test('RAF recursion: RAF scheduled inside an RAF waits until next frame', () => {
  const ctx = loadSchedulerContext();
  const result = [];

  ctx.requestAnimationFrame(() => {
    result.push('first');
    ctx.requestAnimationFrame(() => {
      result.push('second');
    });
  });

  ctx.pmjsDrainScheduler(100);
  assert.deepEqual(result, ['first']);

  ctx.pmjsDrainScheduler(116);
  assert.deepEqual(result, ['first', 'second']);
});

test('RAF cancellation: cancelled callback does not execute', () => {
  const ctx = loadSchedulerContext();
  let ran = false;

  const id = ctx.requestAnimationFrame(() => {
    ran = true;
  });

  ctx.cancelAnimationFrame(id);
  ctx.pmjsDrainScheduler(100);

  assert.equal(ran, false);
});

test('Timer non-reentrancy: setTimeout scheduled from callback runs on subsequent frame', () => {
  const ctx = loadSchedulerContext();
  const result = [];

  ctx.setTimeout(() => {
    result.push(1);
    ctx.setTimeout(() => {
      result.push(2);
    }, 0);
  }, 0);

  ctx.pmjsDrainScheduler(performance.now());
  assert.deepEqual(result, [1]);

  ctx.pmjsDrainScheduler(performance.now() + 16);
  assert.deepEqual(result, [1, 2]);
});

test('Timer deadlines and intervals: fires only when deadline reached and re-arms', () => {
  const ctx = loadSchedulerContext();
  const result = [];

  const base = performance.now();
  ctx.setTimeout((msg) => { result.push(msg); }, 50, 'timeout-50');
  const intervalId = ctx.setInterval((msg) => { result.push(msg); }, 30, 'interval-30');

  // At base + 10ms: nothing due
  ctx.pmjsDrainScheduler(base + 10);
  assert.deepEqual(result, []);

  // At base + 35ms: interval-30 due once
  ctx.pmjsDrainScheduler(base + 35);
  assert.deepEqual(result, ['interval-30']);

  // At base + 65ms: timeout-50 (deadline +50) and second interval-30 (deadline +60) due in deadline order
  ctx.pmjsDrainScheduler(base + 65);
  assert.deepEqual(result, ['interval-30', 'timeout-50', 'interval-30']);

  // Clear interval and advance
  ctx.clearInterval(intervalId);
  ctx.pmjsDrainScheduler(base + 120);
  assert.deepEqual(result, ['interval-30', 'timeout-50', 'interval-30']);
});

test('Plugin override preservation: SceneManager.updateMain override executes naturally via RAF', () => {
  const ctx = loadSchedulerContext((context) => {
    context.SceneManager = {
      _stopped: false,
      update() {
        this.updateMain();
      },
      updateMain() {
        this.rendered = true;
        this.requestUpdate();
      },
      requestUpdate() {
        if (!this._stopped) {
          context.requestAnimationFrame(this.update.bind(this));
        }
      }
    };
  });

  let pluginOverrideCalled = false;
  const originalUpdateMain = ctx.SceneManager.updateMain;
  ctx.SceneManager.updateMain = function() {
    pluginOverrideCalled = true;
    return originalUpdateMain.apply(this, arguments);
  };

  // Initial boot schedules first update
  ctx.SceneManager.requestUpdate();

  // Host frame 1 arrives
  ctx.pmjsDrainScheduler(100);
  assert.equal(pluginOverrideCalled, true);
  assert.equal(ctx.SceneManager.rendered, true);

  // Host frame 2 arrives: next frame's RAF was queued by requestUpdate inside updateMain
  let secondOverrideCalled = false;
  ctx.SceneManager.updateMain = function() {
    secondOverrideCalled = true;
  };
  ctx.pmjsDrainScheduler(116);
  assert.equal(secondOverrideCalled, true);
});

test('Ordering: RAF callback runs before next frame timers', async () => {
  const ctx = loadSchedulerContext();
  const order = [];

  ctx.requestAnimationFrame(() => {
    order.push('raf-1');
    Promise.resolve().then(() => {
      order.push('promise-microtask');
    });
    ctx.setTimeout(() => {
      order.push('timer-after-raf');
    }, 0);
  });

  ctx.pmjsDrainScheduler(100);
  // Wait microtask tick
  await Promise.resolve();
  assert.deepEqual(order, ['raf-1', 'promise-microtask']);

  ctx.pmjsDrainScheduler(116);
  assert.deepEqual(order, ['raf-1', 'promise-microtask', 'timer-after-raf']);
});

test('Intra-snapshot RAF cancellation: callback A cancels callback B scheduled in same snapshot', () => {
  const ctx = loadSchedulerContext();
  let bRan = false;
  let bId;

  ctx.requestAnimationFrame(() => {
    ctx.cancelAnimationFrame(bId);
  });

  bId = ctx.requestAnimationFrame(() => {
    bRan = true;
  });

  ctx.pmjsDrainScheduler(100);
  assert.equal(bRan, false, 'Callback B should have been cancelled by callback A in same snapshot');
});

test('Clock unification: timer scheduled during drain bases deadline on schedulerNow', () => {
  const ctx = loadSchedulerContext();
  let timerFired = false;

  ctx.requestAnimationFrame(() => {
    ctx.setTimeout(() => {
      timerFired = true;
    }, 50);
  });

  // Drain at scheduler frame timestamp 1000: deadline should be 1000 + 50 = 1050
  ctx.pmjsDrainScheduler(1000);
  assert.equal(timerFired, false);

  // At frame timestamp 1040: not yet due
  ctx.pmjsDrainScheduler(1040);
  assert.equal(timerFired, false);

  // At frame timestamp 1050: due and fires
  ctx.pmjsDrainScheduler(1050);
  assert.equal(timerFired, true);
});

test('RAF error isolation: error in first callback does not prevent second callback from running', () => {
  const ctx = loadSchedulerContext();
  let secondRan = false;

  ctx.requestAnimationFrame(() => {
    throw new Error('boom');
  });
  ctx.requestAnimationFrame(() => {
    secondRan = true;
  });

  // Does not throw out of pmjsDrainScheduler and runs second callback
  ctx.pmjsDrainScheduler(100);
  assert.equal(secondRan, true);
});
