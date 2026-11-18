'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../js/pmjs-mv/update-scheduler.js'), 'utf8');
function fixture() {
  const context = { PMJS: {} };
  vm.runInNewContext(source, context);
  const schedule = context.PMJS.mv.createUpdateSchedule({ active: object => object.active,
    counters: [{ name: 'stopped', rate: 1 }] });
  function object(id, callback = () => {}) {
    const result = { active: false, stopped: 0, calls: 0,
      update() { this.calls++; this.stopped++; callback(this); } };
    schedule.register(result, id);
    return result;
  }
  return { schedule, object };
}
test('explicit wakeups activate sleeping objects without installing field accessors', () => {
  const { schedule, object } = fixture(), event = object(1);
  schedule.run(); for (let i = 0; i < 20; i++) schedule.run();
  assert.equal(event.calls, 1);
  schedule.synchronize(event);
  assert.equal(event.stopped, 21);
  event.active = true; schedule.wake(event);
  schedule.run(); schedule.run();
  assert.equal(event.calls, 3);
  assert.equal(event.stopped, 23);
  assert.equal(Object.getOwnPropertyDescriptor(event, 'stopped').get, undefined);
});
test('waking existing earlier and later objects preserves traversal order', () => {
  const { schedule, object } = fixture(), calls = [];
  const first = object(1, () => calls.push(1));
  const middle = object(2, () => { calls.push(2); schedule.wake(first); schedule.wake(last); });
  const last = object(3, () => calls.push(3));
  schedule.run(); calls.length = 0;
  schedule.wake(middle); schedule.run();
  assert.deepEqual(calls, [1, 2, 3]);
  calls.length = 0; schedule.wake(middle); schedule.run();
  assert.deepEqual(calls, [1, 2, 3]);
});
test('replacement during traversal updates the captured old owner, then the replacement next tick', () => {
  const { schedule, object } = fixture(), calls = [];
  let replace = false, replacement;
  const first = object(1, () => {
    calls.push('first');
    if (replace) { schedule.unregister(old); schedule.register(replacement, 2); replace = false; }
  });
  const old = object(2, () => calls.push('old'));
  replacement = { active: false, stopped: 0, update() { this.stopped++; calls.push('replacement'); } };
  schedule.run(); calls.length = 0;
  replace = true; schedule.wake(first); schedule.wake(old); schedule.run();
  assert.deepEqual(calls, ['first', 'old']);
  calls.length = 0; schedule.run();
  assert.deepEqual(calls, ['replacement']);
  assert.equal(old.stopped, 2);
});
test('counter synchronization respects earlier and later event boundaries', () => {
  const { schedule, object } = fixture(), seen = [];
  const before = object(1), observer = object(2, () => {
    schedule.synchronize(before); schedule.synchronize(after); seen.push([before.stopped, after.stopped]);
  });
  const after = object(3);
  schedule.run(); schedule.run(); schedule.run();
  schedule.wake(observer); schedule.run();
  assert.deepEqual(seen.at(-1), [4, 3]);
  schedule.materialize(); assert.equal(after.stopped, 4);
});
test('a thrown early update does not advance later sleeping counters', () => {
  const { schedule, object } = fixture();
  const first = object(1), later = object(3);
  schedule.run(); schedule.run();
  first.update = () => { throw new Error('failure'); }; schedule.wake(first);
  assert.throws(() => schedule.run(), /failure/);
  schedule.materialize(); assert.equal(later.stopped, 2);
  first.update = function() { this.stopped++; };
  schedule.run(); schedule.materialize(); assert.equal(later.stopped, 3);
});
test('unregister freezes ordinary counters and allows subsequent re-registration', () => {
  const { schedule, object } = fixture(), event = object(1);
  schedule.run(); schedule.run(); schedule.run(); schedule.unregister(event);
  assert.equal(event.stopped, 3);
  schedule.run(); schedule.run(); assert.equal(event.stopped, 3);
  schedule.register(event, 1); schedule.run(); schedule.run(); schedule.materialize();
  assert.equal(event.stopped, 5); assert.equal(event.calls, 2);
});
test('read-only counters are rejected without changing their descriptors', () => {
  const { schedule } = fixture(), event = { active: false, update() {} };
  Object.defineProperty(event, 'stopped', { configurable: true, enumerable: true, value: 2, writable: false });
  const descriptor = Object.getOwnPropertyDescriptor(event, 'stopped');
  assert.throws(() => schedule.register(event, 1), /Unsupported scheduled counter/);
  assert.deepEqual(Object.getOwnPropertyDescriptor(event, 'stopped'), descriptor);
});
test('dispose materializes counters and leaves objects independent of the old clock', () => {
  const { schedule, object } = fixture(), event = object(1);
  schedule.run(); schedule.run(); schedule.dispose(); schedule.run();
  assert.equal(event.stopped, 2);
});
test('optional diagnostics count dispatch and omit removed owners', () => {
  const { schedule, object } = fixture(), sleeping = object(1), active = object(2);
  active.active = true; schedule.run();
  assert.equal(schedule.diagnostics().enabled, false);
  schedule.setDiagnostics(true); schedule.run(); schedule.run();
  const report = schedule.diagnostics();
  assert.equal(report.queued, 1); assert.equal(report.sleeping, 1);
  assert.deepEqual(Array.from(report.events, e => [e.id, e.updates]), [[1, 0], [2, 2]]);
  schedule.unregister(active); assert.equal(schedule.diagnostics().registered, 1);
  schedule.setDiagnostics(false); schedule.run(); assert.equal(sleeping.calls, 1);
});
test('an aliased event object cannot silently acquire a second slot', () => {
  const { schedule, object } = fixture(), event = object(1);
  assert.throws(() => schedule.register(event, 2), /cannot occupy two/);
  schedule.run();
  assert.equal(event.calls, 1);
});
test('a notification issued during an update retains a turn on the next tick', () => {
  const { schedule, object } = fixture();
  const event = object(1, current => { if (current.calls === 1) schedule.wake(current); });
  schedule.run(); schedule.run(); schedule.run();
  assert.equal(event.calls, 2);
});
test('bound handles cannot wake or advance an owner after retirement', () => {
  const context = { PMJS: {} };
  vm.runInNewContext(source, context);
  let handle;
  const schedule = context.PMJS.mv.createUpdateSchedule({ active: () => false,
    counters: [{ name: 'stopped', rate: 1 }], registered(record) { handle = record; } });
  const event = { stopped: 0, calls: 0, update() { this.calls++; this.stopped++; } };
  schedule.register(event, 1);
  schedule.run(); schedule.run(); schedule.unregister(event);
  schedule.run();
  handle.synchronize();
  assert.equal(handle.wake(), false);
  schedule.run();
  assert.equal(event.stopped, 2);
  assert.equal(event.calls, 1);
});
