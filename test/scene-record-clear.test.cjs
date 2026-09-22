'use strict';

// Record tail clear: one prefix fill and the explicit zero loop must produce
// byte-identical records; the flag is resolved once per frame.
const assert = require('node:assert');
const test = require('node:test');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const modulePath = path.join(__dirname, '../js/pmjs-pixi4/scene-primitives.js');
const moduleSource = fs.readFileSync(modulePath, 'utf8');

function makeHost(bulkClear) {
  const context = {
    Math, Number, String, Array, Object, Float32Array, Uint32Array, Error,
    PIXI: { Container: function Container() {
      this.worldAlpha = 1;
      this.transform = { worldTransform: { identity() {} } };
    } },
    PMJS: { optimizations: { register() {}, isEnabled: id =>
      (id === 'scene.record-bulk-clear' ? bulkClear : true) } },
    NativeHost: { scene: { packetVersion: 1,
      schema: { version: 1, metadataStride: 7,
      valueStride: 41, transactionalSubmit: true } }, render: {} }
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(moduleSource, context, { filename: 'scene-primitives.js' });
  return context;
}

function recordValues(context) {
  context.resetNativeSceneRecords();
  context.nativeSceneRecord(0, 1, 7, 0xffffff, 0,
    { a: 1, b: 0, c: 0, d: 1, tx: 5, ty: 6 }, 1, null, null, null);
  context.nativeSceneRecord(0, 2, 9, 0x112233, 1,
    { a: 2, b: 0, c: 0, d: 2, tx: 7, ty: 8 }, 0.5, null, null, null);
  return Array.from(context.nativeSceneValues.slice(0, 82));
}

test('prefix fill and zero loop emit identical reused records', () => {
  const fillHost = makeHost(true);
  const loopHost = makeHost(false);
  recordValues(fillHost);
  recordValues(loopHost);
  const filled = recordValues(fillHost);
  const looped = recordValues(loopHost);
  assert.deepEqual(filled, looped);
});

test('bulk-clear flag resolves once per frame', () => {
  let reads = 0;
  const context = makeHost(true);
  const host = context.PMJS.optimizations.isEnabled;
  context.PMJS.optimizations.isEnabled = id => { reads++; return host(id); };
  context.resetNativeSceneRecords();
  for (let i = 0; i < 5; i++) {
    context.nativeSceneRecord(0, 1, 7, 0xffffff, 0,
      { a: 1, b: 0, c: 0, d: 1, tx: 5, ty: 6 }, 1, null, null, null);
  }
  assert.equal(reads, 1);
});

test('prefix fill clears records dirtied by an abandoned build', () => {
  const context = makeHost(true);
  recordValues(context);
  context.nativeSceneValues[40] = 9;
  context.nativeSceneValues[81] = 9;
  context.resetNativeSceneRecords();
  assert.equal(context.nativeSceneCount, 0);
  assert.equal(context.nativeSceneValues[40], 0);
  assert.equal(context.nativeSceneValues[81], 0);
});
