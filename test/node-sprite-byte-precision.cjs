'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const native = require(path.resolve(process.argv[2]));
native.initialize({ gameRoot: path.resolve(process.argv[3]), width: 256, height: 256,
  windowTitle: 'sprite byte precision' });
const schema = native.scene.schema;
const image = native.canvas.create(256, 1);
try {
  const pixels = new Uint8Array(256 * 4);
  for (let byte = 0; byte < 256; byte++) pixels.set([byte, byte, byte, 255], byte * 4);
  native.canvas.writePremultipliedPixels(image.handle, 0, 0, 256, 1, pixels);
  for (const region of [false, true]) {
    const metadata = new Uint32Array(256 * schema.metadataStride);
    const values = new Float32Array(256 * schema.valueStride);
    for (let opacity = 0; opacity < 256; opacity++) {
      const color = (opacity << 24) | (opacity << 16) | (opacity << 8) | opacity;
      metadata.set([1, 0xffffffff, image.handle, color, 1, 8 | 2048 | (region ? (1 << 13) | (1 << 10) : 0), 0],
        opacity * schema.metadataStride);
      values.set([1, 0, 0, 1, 0, opacity, 1], opacity * schema.valueStride);
      values.set([0, 0, 256, 1, 256, 1], opacity * schema.valueStride + 9);
    }
    native.render.setClearColor(144 / 255, 144 / 255, 144 / 255, 1);
    native.beginFrame();
    native.scene.submit(schema.version, metadata, values, 256);
    native.renderScene();
    const actual = Buffer.from(native.canvas.captureSceneRawPremultiplied());
    for (let opacity = 0; opacity < 256; opacity++) for (let byte = 0; byte < 256; byte++) {
      const expected = Math.min(255, 144 + Math.floor((byte * opacity + 127) / 255));
      const offset = (opacity * 256 + byte) * 4;
      assert.deepEqual(Array.from(actual.subarray(offset, offset + 4)),
        [expected, expected, expected, 255], `${region ? 'region' : 'sprite'} sample ${byte}, opacity ${opacity}`);
    }
  }
} finally {
  native.canvas.release(image.handle);
}
