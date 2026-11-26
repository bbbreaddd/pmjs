'use strict';

process.env.PMJS_GRAPHICS_DIAGNOSTICS = '1';

const assert = require('node:assert/strict');
const path = require('node:path');
const native = require(path.resolve(process.argv[2]));

const width = 32;
const height = 32;
const spriteSize = 16;
const step = 4;
native.initialize({
  gameRoot: path.resolve(process.argv[3]),
  assetRoot: '',
  width,
  height,
  windowTitle: 'pmjs multi-texture sprite pixels',
});

const schema = native.scene.schema;
const noParent = 0xffffffff;
const colors = [
  [255, 0, 0, 255],
  [0, 255, 0, 255],
  [0, 0, 255, 255],
  [255, 255, 0, 255],
];
const images = colors.map((color) => {
  const image = native.canvas.create(spriteSize, spriteSize);
  const pixels = new Uint8Array(spriteSize * spriteSize * 4);
  for (let offset = 0; offset < pixels.length; offset += 4) pixels.set(color, offset);
  native.canvas.writePixels(image.handle, 0, 0, spriteSize, spriteSize, pixels);
  return image;
});

try {
  for (let rotation = 0; rotation < images.length; rotation++) {
    const metadata = new Uint32Array(images.length * schema.metadataStride);
    const values = new Float32Array(images.length * schema.valueStride);
    for (let index = 0; index < images.length; index++) {
      const image = images[(index + rotation) % images.length];
      metadata.set([1, noParent, image.handle, 0xffffff, 0, 0, 0],
        index * schema.metadataStride);

      const origin = index * step;
      const offset = index * schema.valueStride;
      values.set([1, 0, 0, 1, origin, origin, 1], offset);
      values.set([0, 0, spriteSize, spriteSize], offset + 9);
      values.set([spriteSize, spriteSize], offset + 13);
    }

    const before = native.render.stats();
    native.beginFrame();
    native.scene.submit(schema.version, metadata, values, images.length);
    native.renderFrame();
    const after = native.render.stats();

    assert.equal(after.drawCalls - before.drawCalls, 1,
      'four compatible sprites with four textures should use one draw');
    assert.equal(after.spriteTextureChangesBatched - before.spriteTextureChangesBatched, 3,
      'all three texture changes should be absorbed into that draw');

    const frame = native.canvas.captureScene();
    try {
      for (let index = 0; index < images.length; index++) {
        const sample = index * step + 1;
        const pixel = native.canvas.readPixels(frame.handle, sample, sample, 1, 1);
        assert.deepEqual(Array.from(pixel), colors[(index + rotation) % images.length],
          `sampler slot rotation ${rotation} sprite ${index} should preserve texture and order`);
      }
    } finally {
      native.canvas.release(frame.handle);
    }
  }
} finally {
  for (const image of images) native.canvas.release(image.handle);
  native.runtime.quit();
}

console.log('multi-texture sprite batching pixels and draw count passed');
