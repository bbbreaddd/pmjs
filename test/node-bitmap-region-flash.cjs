'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const native = require(path.resolve(process.argv[2]));
native.initialize({ gameRoot: path.resolve(process.argv[3]), width: 816, height: 624,
  windowTitle: 'bitmap region flash' });
const schema = native.scene.schema;
const width = 97, height = 158;
const atlasX = 346, atlasY = 188;
const atlas = native.canvas.create(2048, 2048), image = native.canvas.create(width, height);
const pixels = new Uint8Array(width * height * 4);
for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
  const alpha = (x * 19 + y * 31) % 256;
  pixels.set([Math.floor(((x * 13 + y * 7) % 256) * alpha / 255),
    Math.floor(((x * 17 + y * 3) % 256) * alpha / 255),
    Math.floor(((x * 7 + y * 11) % 256) * alpha / 255), alpha], (y * width + x) * 4);
}

function render(handle, region, opacity, nearest, rotation) {
  const flags = 1024 | (region ? 8192 : 0) | (opacity > 0 ? 16 : 0) | (nearest ? 8 : 0);
  const metadata = new Uint32Array([1, 0xffffffff, handle, 0xffffff, 0, flags, 0]);
  const values = new Float32Array(schema.valueStride);
  values.set([Math.cos(rotation) * 1.17, Math.sin(rotation) * 1.17,
    -Math.sin(rotation) * 0.91, Math.cos(rotation) * 0.91, 318.13, 177.81, 0.83]);
  values.set([region ? atlasX : 0, region ? atlasY : 0, width, height, width, height], 9);
  values.set([1, 1, 1, opacity / 255], 37);
  native.render.setClearColor(0.17, 0.17, 0.17, 1);
  native.beginFrame();
  native.scene.submit(schema.version, metadata, values, 1);
  native.renderScene();
  return Buffer.from(native.canvas.captureSceneRawPremultiplied());
}

try {
  native.canvas.writePremultipliedPixels(atlas.handle, atlasX, atlasY, width, height, pixels);
  for (const opacity of [0, 25, 33.6, 128, 255]) {
    const alpha = Math.min(255, Math.floor(opacity / 255 * 256));
    const flashed = pixels.slice();
    for (let offset = 0; offset < flashed.length; offset += 4) for (let channel = 0; channel < 3; channel++) {
      if (opacity > 0) {
        const atop = Math.floor((pixels[offset + channel] * (255 - alpha) + 255 * alpha + 127) / 255);
        flashed[offset + channel] = Math.floor(atop * (pixels[offset + 3] + 1) / 256);
      }
    }
    native.canvas.writePremultipliedPixels(image.handle, 0, 0, width, height, flashed);
    for (const nearest of [false, true]) for (const rotation of [0, 0.23, -0.41]) {
      assert.deepEqual(render(atlas.handle, true, opacity, nearest, rotation),
        render(image.handle, false, 0, nearest, rotation),
        `stored flash versus atlas flash: opacity ${opacity}, nearest ${nearest}, rotation ${rotation}`);
    }
  }
} finally {
  native.canvas.release(image.handle);
  native.canvas.release(atlas.handle);
}
