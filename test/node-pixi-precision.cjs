'use strict';

const path = require('node:path');
const cases = require('./filter-bounds-cases.cjs');

const native = require(path.resolve(process.argv[2]));
native.initialize({
  gameRoot: path.resolve(process.argv[3]),
  assetRoot: '',
  width: 64,
  height: 64,
  windowTitle: 'pmjs pixi precision test',
});

const stride = native.scene.schema.valueStride;
const image = native.images.load('fixture.png');
const records = cases.buildCases(stride, image.handle)['blur filter'];

function submit() {
  const metadata = new Uint32Array(records.length * 7);
  const values = new Float32Array(records.length * stride);
  records.forEach((record, index) => {
    metadata.set(record.metadata, index * 7);
    values.set(record.values, index * stride);
  });
  native.beginFrame();
  native.scene.submit(native.scene.packetVersion, metadata, values, records.length);
  native.renderScene();
}

function fail(label, detail) {
  throw new Error('pixi precision first frame: ' + label + ' ' + detail);
}

let stats = native.render.stats();
if (stats.pixiFragmentPrecision !== 'mediump') {
  fail('default', 'expected mediump, got ' + stats.pixiFragmentPrecision);
}

native.render.configurePixiFragmentPrecision('highp');
const before = native.render.stats();
submit();
const after = native.render.stats();
if (after.pixiFragmentPrecision !== 'highp') {
  fail('applied', 'first filtered frame did not use highp');
}
if (after.filterApplications[0] - before.filterApplications[0] < 1) {
  fail('filter path', 'no kind-0 application observed on the first frame');
}
// Setup is synchronous and repeating the same value is harmless.
if (before.pixiFragmentPrecision !== 'highp') fail('setup', 'precision was deferred');
native.render.configurePixiFragmentPrecision('highp');
let changed = false;
try {
  native.render.configurePixiFragmentPrecision('lowp');
} catch (_) {
  changed = true;
}
if (!changed) fail('one-time setup', 'later precision mutation was accepted');
if (native.render.stats().pixiFragmentPrecision !== 'highp') {
  fail('one-time setup', 'rejected mutation changed precision');
}

let rejected = false;
try {
  native.render.configurePixiFragmentPrecision('ultra');
} catch (_) {
  rejected = true;
}
if (!rejected) fail('validation', 'bogus precision was accepted');

console.log('node-pixi-precision: first filtered frame used the authored program');
