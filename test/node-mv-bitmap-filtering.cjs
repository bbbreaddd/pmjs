'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const native = require(path.resolve(process.argv[2]));
native.initialize({ gameRoot: path.resolve(process.argv[3]), width: 64, height: 64,
  windowTitle: 'MV bitmap filtering' });
native.render.configurePixiFragmentPrecision('highp');
const schema = native.scene.schema, width = 17, height = 23;
const source = native.canvas.create(width, height), stored = native.canvas.create(width, height);
const pixels = new Uint8Array(width * height * 4);
for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
  const alpha = (x * 19 + y * 31) % 256;
  pixels.set([Math.floor(((x * 13 + y * 7) % 256) * alpha / 255),
    Math.floor(((x * 17 + y * 3) % 256) * alpha / 255),
    Math.floor(((x * 7 + y * 11) % 256) * alpha / 255), alpha], (y * width + x) * 4);
}
function mesh(image) {
  return native.mv.createBitmapMesh(image, [0, 0, width, 0, width, height, 0, height],
    [0, 0, 1, 0, 1, 1, 0, 1], [0, 1, 2, 0, 2, 3], 1,
    { texelBounds: [0, 0, width - 1, height - 1], alphaMode: 'premultiplied' });
}
const original = mesh(source.handle), reference = mesh(stored.handle);
function render(resource, opacity, nearest) {
  const values = new Float32Array(schema.valueStride), theta = 0.23;
  values.set([Math.cos(theta) * 1.17, Math.sin(theta) * 1.17,
    -Math.sin(theta) * 0.91, Math.cos(theta) * 0.91, 18.13, 7.81, 0.83]);
  values.set([1, 1, 1, opacity / 255], 37);
  native.render.setClearColor(0.17, 0.17, 0.17, 1);
  native.beginFrame();
  native.scene.submit(schema.version, new Uint32Array([8, 0xffffffff, resource, 0xffffff,
    0, (opacity ? 16384 : 0) | (nearest ? 8 : 0), 0]), values, 1);
  native.renderScene();
  return Buffer.from(native.canvas.captureSceneRawPremultiplied());
}
try {
  native.canvas.writePremultipliedPixels(source.handle, 0, 0, width, height, pixels);
  for (const opacity of [0, 25, 33.6, 128, 255]) {
    const alpha = Math.min(255, Math.floor(opacity / 255 * 256)), flashed = pixels.slice();
    for (let at = 0; at < pixels.length; at += 4) for (let channel = 0; channel < 3; channel++) {
      if (opacity) {
        const atop = Math.floor((pixels[at + channel] * (255 - alpha) + 255 * alpha + 127) / 255);
        flashed[at + channel] = Math.floor(atop * (pixels[at + 3] + 1) / 256);
      }
    }
    native.canvas.writePremultipliedPixels(stored.handle, 0, 0, width, height, flashed);
    for (const nearest of [false, true]) {
      assert.deepEqual(render(original, opacity, nearest), render(reference, 0, nearest),
        `stored versus sampled flash: opacity ${opacity}, nearest ${nearest}`);
    }
  }
} finally {
  native.render.releaseMesh(original); native.render.releaseMesh(reference);
  native.canvas.release(source.handle); native.canvas.release(stored.handle);
}
