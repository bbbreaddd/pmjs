'use strict';

const path = require('node:path');
const fs = require('node:fs');
const cases = require('./filter-bounds-cases.cjs');

const native = require(path.resolve(process.argv[2]));
native.initialize({
  gameRoot: path.resolve(process.argv[3]),
  assetRoot: '',
  width: 16,
  height: 16,
  windowTitle: 'pmjs filter bounds dump',
});

const caseName = process.argv[4];
const outPath = process.argv[5];
const stride = native.scene.schema.valueStride;
const image = native.images.load('fixture.png');
const records = cases.buildCases(stride, image.handle)[caseName];
if (!records) {
  throw new Error('unknown filter bounds case: ' + caseName);
}
const metadata = new Uint32Array(records.length * 7);
const values = new Float32Array(records.length * stride);
records.forEach((record, index) => {
  metadata.set(record.metadata, index * 7);
  values.set(record.values, index * stride);
});
native.beginFrame();
native.scene.submit(native.scene.packetVersion, metadata, values, records.length);
native.renderScene();
const frame = native.canvas.captureScene();
try {
  const pixels = native.canvas.readPixels(frame.handle, 0, 0, 16, 16);
  fs.writeFileSync(outPath, Buffer.from(pixels));
} finally {
  native.canvas.release(frame.handle);
}
