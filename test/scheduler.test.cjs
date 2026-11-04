'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const timers = require('node:timers');

function fixture(t, clock = performance, nodeReporter) {
  const errors = [], fatals = [];
  const globals = { PMJS: {}, __pmjsBuiltinRequire: require, performance: clock, console,
    NativeHost: { runtime: { scheduling: { ...timers, onFatal: error => fatals.push(error) } } },
    pmjsReportEventError: error => errors.push(error) };
  if (nodeReporter) globals.pmjsReportNodeException = nodeReporter;
  const context = vm.createContext(globals);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/pmjs-web/scheduler.js'), 'utf8'), context);
  t.after(() => context.PMJS.tasks.stop());
  return { context, errors, fatals };
}

for (const count of [2, 130, 1024]) test('FIFO callbacks checkpoint chained Promises, count=' + count, async t => {
  const { context } = fixture(t), trace = [];
  for (let i = 0; i < count; i++) context.PMJS.tasks.enqueue(() => {
    trace.push('task:' + i);
    Promise.resolve().then(() => Promise.resolve()).then(() => trace.push('micro:' + i));
  });
  await context.PMJS.tasks.idle();
  assert.deepEqual(trace, Array.from({ length: count }, (_, i) => ['task:' + i, 'micro:' + i]).flat());
});

test('work enqueued by a task follows existing tasks and its microtasks', async t => {
  const { context } = fixture(t), trace = [];
  context.PMJS.tasks.enqueue(() => {
    trace.push('A'); context.PMJS.tasks.enqueue(() => trace.push('C'));
    Promise.resolve().then(() => trace.push('micro'));
  });
  context.PMJS.tasks.enqueue(() => trace.push('B'));
  await context.PMJS.tasks.idle();
  assert.deepEqual(trace, ['A', 'micro', 'B', 'C']);
});

test('rAF snapshots retain cancellation, timestamps and next-frame registrations', async t => {
  const { context } = fixture(t), trace = [];
  let cancelled;
  context.requestAnimationFrame(now => {
    trace.push(['A', now]); context.cancelAnimationFrame(cancelled);
    Promise.resolve().then(() => {
      trace.push(['micro']); context.requestAnimationFrame(time => trace.push(['next', time]));
    });
  });
  cancelled = context.requestAnimationFrame(() => trace.push(['cancelled']));
  context.requestAnimationFrame(now => trace.push(['B', now]));
  await context.PMJS.tasks.runFrame(() => context.pmjsDrainScheduler(100));
  assert.deepEqual(trace, [['A', 100], ['micro'], ['B', 100]]);
  await context.PMJS.tasks.runFrame(() => context.pmjsDrainScheduler(116));
  assert.deepEqual(trace.at(-1), ['next', 116]);
});

test('rendering checkpoints hold resource callbacks and timer callbacks until submission', async t => {
  const { context } = fixture(t), trace = [];
  context.requestAnimationFrame(() => {
    trace.push('A'); context.PMJS.tasks.enqueue(() => trace.push('resource'));
    context.setTimeout(() => trace.push('timer'), 0);
    Promise.resolve().then(() => trace.push('micro'));
    Promise.resolve().then(() => context.PMJS.tasks.invoke(() => trace.push('io-completion')));
  });
  context.requestAnimationFrame(() => trace.push('B'));
  await context.PMJS.tasks.runFrame(() => context.pmjsDrainScheduler(1).then(() => trace.push('submit')));
  assert.deepEqual(trace.slice(0, 4), ['A', 'micro', 'B', 'submit']);
  await new Promise(resolve => timers.setTimeout(resolve, 10));
  await context.PMJS.tasks.idle();
  assert.ok(trace.includes('resource')); assert.ok(trace.includes('timer'));
  assert.ok(trace.indexOf('io-completion') > trace.indexOf('submit'));
});

test('pending frames bound a replenishing queue by callback count', async t => {
  const { context } = fixture(t, { now: () => 0 });
  let calls = 0;
  function replenish() { calls++; context.PMJS.tasks.enqueue(replenish); }
  context.PMJS.tasks.enqueue(replenish);
  await context.PMJS.tasks.runFrame(() => assert.equal(calls, 64));
  const before = calls;
  await context.PMJS.tasks.runFrame(() => assert.equal(calls - before, 64));
});

test('admission time includes callback microtasks and resets after expensive frames', async t => {
  let time = 0, calls = 0;
  const clock = { now: () => time };
  const { context } = fixture(t, clock);
  function replenish() {
    calls++;
    Promise.resolve().then(() => { time += 2; context.PMJS.tasks.enqueue(replenish); });
  }
  context.PMJS.tasks.enqueue(replenish);
  await context.PMJS.tasks.runFrame(() => { assert.equal(calls, 2); time += 50; });
  const before = calls;
  clock.now = () => 0;
  await context.PMJS.tasks.runFrame(() => assert.equal(calls - before, 2));
});

test('timers run without frames, checkpoint, accept arguments and cancel', async t => {
  const { context } = fixture(t), trace = [];
  const cancelled = context.setTimeout(() => trace.push('cancelled'), 0);
  context.clearTimeout(cancelled);
  context.setTimeout(value => {
    trace.push(value); Promise.resolve().then(() => trace.push('micro'));
  }, 0, 'A');
  await new Promise(resolve => context.setTimeout(() => { trace.push('B'); resolve(); }, 5));
  assert.deepEqual(trace, ['A', 'micro', 'B']);
});

test('global setImmediate uses guest Node exception delivery and supports cancellation', async t => {
  const nodeErrors = [], { context, fatals } = fixture(t, performance, error => nodeErrors.push(error)), trace = [];
  const error = new Error('setImmediate callback failure');
  const failed = context.setImmediate(function(value) {
    assert.ok(this);
    trace.push(value);
    throw error;
  }, 'first');
  const cancelled = context.setImmediate(() => trace.push('cancelled'));
  context.clearImmediate(cancelled);
  const next = context.setImmediate(value => trace.push(value), 'next');
  const returnedPromise = Promise.resolve('immediate result');
  context.setImmediate(() => returnedPromise);

  assert.equal(failed.hasRef(), true);
  assert.equal(failed.unref(), failed);
  assert.equal(failed.hasRef(), false);
  assert.equal(failed.ref(), failed);
  assert.equal(failed.hasRef(), true);
  assert.equal(next.hasRef(), true);
  await context.PMJS.tasks.idle();

  assert.equal(failed.hasRef(), false);
  assert.deepEqual(trace, ['first', 'next']);
  assert.deepEqual(nodeErrors, [error]);
  assert.deepEqual(fatals, []);
  assert.equal(context.PMJS.tasks.guestPromiseOrigin(returnedPromise), 'node');
});

test('intervals skip elapsed periods and stop after cancellation inside the callback', async t => {
  const { context } = fixture(t), trace = [];
  const completed = new Promise(resolve => {
    const id = context.setInterval(() => {
      trace.push(performance.now());
      if (trace.length === 2) { context.clearInterval(id); resolve(); }
    }, 2);
  });
  await completed;
  await new Promise(resolve => timers.setTimeout(resolve, 10));
  assert.equal(trace.length, 2);
});

test('browser callback errors report and preserve subsequent work', async t => {
  const { context, errors, fatals } = fixture(t), trace = [];
  context.PMJS.tasks.enqueue(() => { throw new Error('event failure'); }, { errorMode: 'event' });
  context.PMJS.tasks.enqueue(() => trace.push('next'));
  context.requestAnimationFrame(() => { throw new Error('raf failure'); });
  context.requestAnimationFrame(() => trace.push('raf'));
  await context.PMJS.tasks.idle();
  await context.PMJS.tasks.runFrame(() => context.pmjsDrainScheduler(10));
  assert.deepEqual(errors.map(e => e.message), ['event failure', 'raf failure']);
  assert.deepEqual(fatals, []); assert.deepEqual(trace, ['next', 'raf']);
});

test('uncaught-mode callback errors are logged like NW.js and preserve subsequent work', async t => {
  const { context, errors, fatals } = fixture(t), trace = [];
  const logged = t.mock.method(console, 'error', () => {});
  context.PMJS.tasks.enqueue(() => { throw new Error('ENOENT: /save/optional-state.json'); }, { errorMode: 'uncaught' });
  context.PMJS.tasks.enqueue(() => trace.push('next'));
  await context.PMJS.tasks.idle();
  assert.deepEqual(fatals, []);
  assert.deepEqual(errors, [], 'NW.js does not route Node callback exceptions to window.onerror');
  assert.deepEqual(trace, ['next']);
  assert.equal(logged.mock.callCount(), 1);
  assert.match(logged.mock.calls[0].arguments[0], /uncaught exception in Node callback/);
});

test('fatal callbacks stop delivery and discard retained results', async t => {
  const { context, fatals } = fixture(t), trace = [];
  context.PMJS.tasks.enqueue(() => { throw new Error('node callback'); });
  context.PMJS.tasks.enqueue(() => trace.push('unexpected'), { discard: () => trace.push('released') });
  await context.PMJS.tasks.idle();
  assert.deepEqual(fatals.map(e => e.message), ['node callback']);
  assert.deepEqual(trace, ['released']);
  assert.equal(context.PMJS.tasks.enqueue(() => trace.push('late'), { discard: () => trace.push('late release') }), false);
  assert.deepEqual(trace, ['released', 'late release']);
});

for (const stopAfter of [70, 600]) test('stopping a partially drained large queue discards only pending results, after=' + stopAfter, async t => {
  const { context, fatals } = fixture(t), delivered = [], discarded = [];
  for (let i = 0; i < 1024; i++) context.PMJS.tasks.enqueue(() => {
    delivered.push(i);
    if (i === stopAfter) context.PMJS.tasks.stop();
  }, { discard: () => discarded.push(i) });
  await context.PMJS.tasks.idle();
  assert.deepEqual(delivered, Array.from({ length: stopAfter + 1 }, (_, i) => i));
  assert.deepEqual(discarded, Array.from({ length: 1023 - stopAfter }, (_, i) => i + stopAfter + 1));
  assert.deepEqual(fatals, []);
});

test('timer and animation callback promises use browser rejection delivery without blocking', async t => {
  const { EventEmitter } = require('node:events');
  const { installPromiseRejectionBridge } = require('../runner/promise-rejections.cjs');
  const { context, fatals } = fixture(t), host = new EventEmitter(), delivered = [];
  const remove = installPromiseRejectionBridge(host, {
    getTasks: () => context.PMJS.tasks,
    reportUnhandled: (reason, promise, origin) => delivered.push([reason, promise, origin]),
    reportHandled() {}
  });
  t.after(remove);
  const promises = [];
  const pending = () => { const promise = new Promise(() => {}); promises.push(promise); return promise; };
  await new Promise(resolve => {
    context.setTimeout(pending, 0);
    context.setTimeout('globalThis.stringPromise = new Promise(function() {})', 0);
    const interval = context.setInterval(() => { context.clearInterval(interval); return pending(); }, 1);
    context.setTimeout(resolve, 5);
  });
  promises.push(context.stringPromise);
  context.requestAnimationFrame(pending);
  let nextRan = false;
  context.requestAnimationFrame(() => { nextRan = true; });
  await context.PMJS.tasks.runFrame(() => context.pmjsDrainScheduler(10));
  assert.equal(nextRan, true, 'unsettled callback promises must not hold the frame');
  assert.equal(promises.length, 4);
  for (const promise of promises) {
    host.emit('unhandledRejection', new Error('browser callback'), promise);
  }
  await context.PMJS.tasks.idle();
  assert.deepEqual(delivered.map(entry => entry[2]), ['browser', 'browser', 'browser', 'browser']);
  assert.deepEqual(delivered.map(entry => entry[1]), promises);
  const infrastructure = new Error('infrastructure');
  assert.throws(() => host.emit('unhandledRejection', infrastructure, Promise.resolve()), error => error === infrastructure);
  assert.deepEqual(fatals, []);
});

test('discarded promises retain guest origin through reactions and await without tagging host work', async t => {
  const { context } = fixture(t);
  vm.runInContext(`
    globalThis.created = [];
    setTimeout(() => {
      const rejection = Promise.reject(new Error('discarded timer'));
      created.push(rejection); rejection.catch(() => {});
      Promise.resolve().then(() => created.push(Promise.resolve('reaction')));
    }, 0);
    setImmediate(async () => {
      await Promise.resolve();
      created.push(Promise.resolve('await'));
    });
  `, context);
  await new Promise(resolve => timers.setTimeout(resolve, 20));
  await context.PMJS.tasks.idle();
  assert.equal(context.created.length, 3);
  assert.deepEqual(Array.from(context.created, p => context.PMJS.tasks.guestPromiseOrigin(p)).sort(),
    ['browser', 'browser', 'node']);
  const tasks = context.PMJS.tasks;
  let infrastructure, consumer;
  tasks.runGuest('browser', () => {
    tasks.runHost(() => { infrastructure = Promise.resolve(); });
    infrastructure.then(() => { consumer = Promise.resolve(); });
  });
  await tasks.idle();
  assert.equal(tasks.guestPromiseOrigin(infrastructure), undefined);
  assert.equal(tasks.guestPromiseOrigin(consumer), 'browser');
  const guestPromise = tasks.runGuest('browser', () => Promise.resolve());
  let hostChild;
  await guestPromise.then(() => { hostChild = Promise.resolve(); });
  assert.equal(tasks.guestPromiseOrigin(hostChild), undefined);
  assert.equal(tasks.guestPromiseOrigin(Promise.resolve()), undefined);
  assert.throws(() => tasks.runGuest('browser', () => { throw new Error('scope'); }), /scope/);
  assert.equal(tasks.guestPromiseOrigin(Promise.resolve()), undefined);
});

test('guest emitter listeners and script scopes attribute discarded promises and stop removes hooks', t => {
  const { context } = fixture(t), tasks = context.PMJS.tasks;
  const { EventEmitter } = require('node:events');
  const emitter = tasks.wrapNodeEmitter(new EventEmitter());
  let promise;
  emitter.on('data', () => { promise = Promise.resolve(); });
  emitter.emit('data');
  assert.equal(tasks.guestPromiseOrigin(promise), 'node');
  tasks.runGuest('browser', () => vm.runInContext('globalThis.scriptPromise = Promise.resolve()', context));
  assert.equal(tasks.guestPromiseOrigin(context.scriptPromise), 'browser');
  tasks.stop();
  tasks.runGuest('browser', () => { promise = Promise.resolve(); });
  assert.equal(tasks.guestPromiseOrigin(promise), undefined);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/pmjs-web/scheduler.js'), 'utf8'), context);
  context.PMJS.tasks.runGuest('browser', () => { promise = Promise.resolve(); });
  assert.equal(context.PMJS.tasks.guestPromiseOrigin(promise), 'browser');
  assert.equal(tasks.guestPromiseOrigin(promise), undefined);
});

test('a synchronous frame failure wakes work queued by the frame', async t => {
  const { context } = fixture(t), tasks = context.PMJS.tasks, trace = [];
  await assert.rejects(tasks.runFrame(() => {
    tasks.enqueue(() => trace.push('continued'));
    throw new Error('frame failed');
  }), /frame failed/);
  // No new enqueue or idle wake may be needed to resume the stranded work.
  await new Promise(timers.setImmediate);
  assert.deepEqual(trace, ['continued']);
});

test('ordinary callbacks remain held by an awaiting frame; explicit continuations can complete it', async t => {
  const { context } = fixture(t), tasks = context.PMJS.tasks, trace = [];
  let release;
  const frame = tasks.runFrame(() => new Promise(resolve => {
    release = resolve;
    tasks.enqueue(() => { trace.push('ordinary'); resolve(); });
  }));
  await new Promise(timers.setImmediate);
  await new Promise(timers.setImmediate);
  assert.deepEqual(trace, []);
  await tasks.invokeRendering(() => { trace.push('continuation'); release(); });
  await frame;
  await tasks.idle();
  assert.deepEqual(trace, ['continuation', 'ordinary']);
});
