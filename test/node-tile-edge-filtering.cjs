'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const native = require(path.resolve(process.argv[2]));
native.initialize({ gameRoot: path.resolve(process.argv[3]), width: 8, height: 8,
  windowTitle: 'tile edge filtering' });
native.render.configurePixiFragmentPrecision('highp');
const image = native.canvas.create(2, 2), padded = native.canvas.create(4, 4);
const pixels = new Uint8Array(16).fill(255);
native.canvas.writePremultipliedPixels(image.handle, 0, 0, 2, 2, pixels);
native.canvas.writePremultipliedPixels(padded.handle, 1, 1, 2, 2, pixels);
const schema = native.scene.schema;
function render(handle, offset, phase) {
  const layer = native.render.createTileLayer(new Float32Array(
    [offset + phase, offset, 0, 0, 2, 2, 0, 0, 0]), [handle]);
  try {
    const values = new Float32Array(schema.valueStride);
    values.set([1, 0, 0, 1, 1, 1, 1]);
    native.render.setClearColor(0, 0, 0, 1);
    native.beginFrame();
    native.scene.submit(schema.version,
      new Uint32Array([4, 0xffffffff, layer, 0xffffff, 0, 0, 0]), values, 1);
    native.renderScene();
    return Buffer.from(native.canvas.captureSceneRawPremultiplied());
  } finally { native.render.releaseTileLayer(layer); }
}
try {
  for (const phase of [0, 1/512, 3/512, -1/512]) {
    assert.deepEqual(render(image.handle, 0, phase), render(padded.handle, 1, phase),
      `logical padding versus stored padding at source phase ${phase}`);
  }
} finally { native.canvas.release(image.handle); native.canvas.release(padded.handle); }
