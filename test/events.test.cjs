'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const timers = require('node:timers');
const vm = require('node:vm');

function fixture(t) {
  const context = vm.createContext({ PMJS: {}, performance, console,
    NativeHost: { runtime: { scheduling: timers } } });
  for (const module of ['events', 'scheduler']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/pmjs-web', module + '.js'), 'utf8'), context);
  }
  t.after(() => context.PMJS.tasks.stop());
  return context;
}

for (const host of [false, true]) {
  const mode = host ? 'host' : 'synchronous';
  function dispatch(context, target) {
    const event = { type: 'load' };
    return host ? context.pmjsDispatchHostEvent(target, event) : target.dispatchEvent(event);
  }

  test(mode + ' dispatch skips a listener removed by an earlier listener', async t => {
    const context = fixture(t), target = new context.EventTarget(), trace = [];
    const later = () => trace.push('B');
    target.addEventListener('load', () => {
      trace.push('A'); target.removeEventListener('load', later);
    });
    target.addEventListener('load', later);
    await dispatch(context, target);
    assert.deepEqual(trace, ['A']);
  });

  test(mode + ' dispatch does not revive a removed registration when re-added', async t => {
    const context = fixture(t), target = new context.EventTarget(), trace = [];
    let first = true;
    const later = () => trace.push('B');
    target.addEventListener('load', () => {
      trace.push('A');
      if (first) {
        first = false;
        target.removeEventListener('load', later);
        target.addEventListener('load', later);
      }
    });
    target.addEventListener('load', later);
    await dispatch(context, target);
    assert.deepEqual(trace, ['A']);
    await dispatch(context, target);
    assert.deepEqual(trace, ['A', 'A', 'B']);
  });

  test(mode + ' dispatch defers additions and suppresses duplicate registrations', async t => {
    const context = fixture(t), target = new context.EventTarget(), trace = [];
    const later = () => trace.push('B');
    target.addEventListener('load', () => {
      trace.push('A'); target.addEventListener('load', later); target.addEventListener('load', later);
    });
    await dispatch(context, target);
    assert.deepEqual(trace, ['A']);
    await dispatch(context, target);
    assert.deepEqual(trace, ['A', 'A', 'B']);
  });

  test(mode + ' dispatch permits self-removal without skipping the next listener', async t => {
    const context = fixture(t), target = new context.EventTarget(), trace = [];
    function first() { trace.push('A'); target.removeEventListener('load', first); }
    target.addEventListener('load', first);
    target.addEventListener('load', () => trace.push('B'));
    await dispatch(context, target);
    await dispatch(context, target);
    assert.deepEqual(trace, ['A', 'B', 'B']);
  });

  test(mode + ' dispatch skips a registered handler cleared before its turn', async t => {
    const context = fixture(t), target = new context.EventTarget(), trace = [];
    context.EventTarget.defineEventHandlerProperty(target, 'load');
    target.addEventListener('load', () => { trace.push('A'); target.onload = null; });
    target.onload = () => trace.push('handler');
    await dispatch(context, target);
    assert.deepEqual(trace, ['A']);
    assert.equal(target.onload, null);
  });
}

test('browser event listeners and properties track returned Promises and cancellation', t => {
  const context = fixture(t), target = new context.EventTarget();
  const listener = Promise.resolve('listener'), property = Promise.resolve('property');
  target.addEventListener('click', () => listener);
  target.onclick = () => property;
  target.dispatchEvent({ type: 'click' });
  assert.equal(context.PMJS.tasks.guestPromiseOrigin(listener), 'browser');
  assert.equal(context.PMJS.tasks.guestPromiseOrigin(property), 'browser');
  target.oncancel = () => false;
  assert.equal(target.dispatchEvent({ type: 'cancel', preventDefault() { this.defaultPrevented = true; } }), false);
});

test('host dispatch observes removal in a listener microtask', async t => {
  const context = fixture(t), target = new context.EventTarget(), trace = [];
  const later = () => trace.push('B');
  target.addEventListener('load', () => {
    trace.push('A');
    Promise.resolve().then(() => { trace.push('micro'); target.removeEventListener('load', later); });
  });
  target.addEventListener('load', later);
  await context.pmjsDispatchHostEvent(target, { type: 'load' });
  assert.deepEqual(trace, ['A', 'micro']);
});

test('host and synchronous dispatch retain their distinct microtask checkpoints', async t => {
  const context = fixture(t), target = new context.EventTarget(), trace = [];
  target.addEventListener('load', () => {
    trace.push('A'); Promise.resolve().then(() => trace.push('micro'));
  });
  target.addEventListener('load', () => trace.push('B'));
  target.dispatchEvent({ type: 'load' });
  assert.deepEqual(trace, ['A', 'B']);
  await Promise.resolve();
  assert.deepEqual(trace, ['A', 'B', 'micro']);
  trace.length = 0;
  await context.pmjsDispatchHostEvent(target, { type: 'load' });
  assert.deepEqual(trace, ['A', 'micro', 'B']);
});

test('nested dispatch sees a new registration without reviving the outer snapshot', t => {
  const context = fixture(t), target = new context.EventTarget(), trace = [];
  const later = event => trace.push(event.depth + ':B');
  target.addEventListener('load', event => {
    trace.push(event.depth + ':A');
    if (event.depth === 'outer') {
      target.removeEventListener('load', later);
      target.addEventListener('load', later);
      target.dispatchEvent({ type: 'load', depth: 'inner' });
    }
  });
  target.addEventListener('load', later);
  target.dispatchEvent({ type: 'load', depth: 'outer' });
  assert.deepEqual(trace, ['outer:A', 'inner:A', 'inner:B']);
});

test('host dispatch retains generation guards, receivers and event error reporting', async t => {
  const context = fixture(t), target = new context.EventTarget(), trace = [], errors = [];
  context.onerror = message => { errors.push(message); return true; };
  let current = true;
  target.addEventListener('load', function(event) {
    assert.equal(this, target); assert.equal(event.target, target); assert.equal(event.currentTarget, target);
    trace.push('A'); throw new Error('listener failure');
  });
  target.addEventListener('load', () => { trace.push('B'); current = false; });
  target.addEventListener('load', () => trace.push('stale'));
  assert.equal(await context.pmjsDispatchHostEvent(target, { type: 'load' }, () => current), false);
  assert.deepEqual(trace, ['A', 'B']);
  assert.deepEqual(errors, ['listener failure']);
});
