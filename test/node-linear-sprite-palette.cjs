'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { png } = require('./helpers/png.cjs');
const { spritePacket, drawPacket } = require('./helpers/sparse-palette.cjs');
const native = require(path.resolve(process.argv[2]));
native.initialize({ imagePalettization: true, gameRoot: __dirname, width: 8, height: 8,
  windowTitle: 'Linear sprite storage', imageWarmCacheBytes: 0 });
const pixels = Buffer.alloc(64 * 64 * 4);
for (let i = 0; i < 64 * 64; i++) pixels.set([253, 253, 253, i === 66 ? 255 : 0], i * 4);
const bytes = png(64, 64, pixels);
const reference = native.images.loadBytes(bytes);
const indexed = native.images.loadBytes(bytes);
const owner = image => native.images.memory(100).largest.find(entry => entry.handle === image.handle);
function packet(image, mipmap = false) {
  const p = spritePacket(native, image, { nearest: false, crop: [0, 0, 64, 64], scale: 1.25, mipmap });
  p.metadata[3] = 0xffffff;
  p.values[6] = 1;
  return p;
}
try {
  native.render.setClearColor(0, 0, 0, 0);
  const expected = drawPacket(native, packet(reference, true));
  assert.equal(owner(reference).palette, false, 'control must use ordinary texture filtering');
  assert.equal(owner(indexed).palette, false, 'images use ordinary texture storage');
  const actual = drawPacket(native, packet(indexed));
  let differingBytes = 0, maxByteDelta = 0;
  for (let i = 0; i < actual.length; i++) {
    const delta = Math.abs(actual[i] - expected[i]);
    if (delta) differingBytes++;
    maxByteDelta = Math.max(maxByteDelta, delta);
  }
  assert.ok(maxByteDelta <= 1, 'decoded palette interpolation exceeded one byte of rounding');
  assert.equal(owner(indexed).palette, false, 'linear drawing does not create indexed storage');
  console.log(JSON.stringify({ differingBytes, maxByteDelta }));
  const uploads = native.images.memory().textureUploadBytes;
  assert.deepEqual(drawPacket(native, packet(indexed)), actual);
  assert.equal(native.images.memory().textureUploadBytes, uploads, 'stable draw must reuse texture backing');
} finally {
  native.images.release(indexed.handle);
  native.images.release(reference.handle);
  native.runtime.quit();
}
