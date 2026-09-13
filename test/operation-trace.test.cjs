'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(
  path.join(__dirname, '../js/pmjs-core/operation-trace.js'), 'utf8');

function createTrace(frames = 2, events = 256) {
  let now = 0;
  const context = {
    NativeHost: { runtime: { env(name) {
      if (name === 'PMJS_OPERATION_TRACE_FRAMES') return String(frames);
      if (name === 'PMJS_OPERATION_TRACE_EVENTS') return String(events);
      return '';
    } } },
    performance: { now() { return ++now; } },
    WeakMap, Object, Number, Math
  };
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: 'operation-trace.js' });
  return context.__pmjsTrace;
}

test('operation trace remains inert until armed and stops at its frame bound', () => {
  const trace = createTrace(2);
  trace.event('canvas', 'ignored', {});
  assert.equal(trace.result().metadata.recordedEvents, 0);
  assert.equal(trace.arm(2), true);
  trace.beginFrame(10, 20);
  trace.event('canvas', 'kept', { bytes: 64 });
  trace.duration('phase', 'game.update', 1, 2.5);
  trace.endFrame();
  trace.beginFrame(11, 21);
  trace.endFrame();
  trace.beginFrame(12, 22);
  trace.event('canvas', 'ignored-after-bound', {});
  trace.endFrame();
  const result = trace.result();
  assert.equal(result.metadata.capturedFrames, 2);
  assert.equal(result.metadata.complete, true);
  assert.equal(result.metadata.droppedEvents, 0);
  assert.equal(result.traceEvents.some(event => event.name === 'kept'), true);
  assert.equal(result.traceEvents.find(event => event.name === 'game.update').dur,
    1500);
  assert.equal(result.traceEvents.some(event => event.name === 'ignored-after-bound'), false);
  assert.equal(result.metadata.coverage.executedDrawHook, false);
});

test('operation trace preserves resource identity and revisions', () => {
  const trace = createTrace(1);
  const resource = {};
  const first = trace.revision(resource, 'canvas');
  const second = trace.revision(resource, 'canvas', true);
  assert.equal(first.id, second.id);
  assert.equal(first.revision, 0);
  assert.equal(second.revision, 1);
  assert.equal(trace.result().metadata.resources[first.id].kind, 'canvas');
});

test('operation trace can be armed again for an independent live capture', () => {
  const trace = createTrace(0);
  assert.equal(trace.arm(1, 256), true);
  trace.beginFrame(1, 1);
  trace.event('first', 'discarded-by-reset', {});
  trace.endFrame();
  assert.equal(trace.arm(1, 512), true);
  trace.beginFrame(2, 2);
  trace.event('second', 'kept', {});
  trace.endFrame();
  const result = trace.result();
  assert.equal(result.metadata.capturedFrames, 1);
  assert.equal(result.metadata.eventCapacity, 512);
  assert.equal(result.traceEvents.some(event => event.cat === 'first'), false);
  assert.equal(result.traceEvents.some(event => event.cat === 'second'), true);
});
