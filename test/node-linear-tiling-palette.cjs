'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { png } = require('./helpers/png.cjs');
const { spritePacket, drawPacket } = require('./helpers/sparse-palette.cjs');
const native = require(path.resolve(process.argv[2]));
native.initialize({ imagePalettization: true, gameRoot: __dirname, width: 64, height: 48,
  windowTitle: 'Linear tiling storage', imageWarmCacheBytes: 0 });
const pixels = Buffer.alloc(64 * 64 * 4);
for (let i = 0; i < 64 * 64; i++) {
  const c = i % 7, gray = c * 31;
  pixels.set([gray, gray, gray, c * 37], i * 4);
}
const bytes = png(64, 64, pixels);
const reference = native.images.loadBytes(bytes);
const owner = image => native.images.memory(100).largest.find(entry => entry.handle === image.handle);
let comparisons = 0;
try {
  drawPacket(native, spritePacket(native, reference, { mipmap: true }));
  for (const nearest of [false, true]) for (const clamped of [false, true]) for (const offset of [-1.25, 0, 3.375]) {
    const indexed = native.images.loadBytes(bytes);
    try {
      assert.equal(owner(indexed).palette, false, 'images use ordinary texture storage');
      function packet(image) {
        const p = spritePacket(native, image, { nearest, crop: [0.25, 0.5, 48, 36], scale: 0.875 });
        p.metadata[0] = 2;
        p.metadata[5] &= ~(1 << 17);
        if (clamped) p.metadata[5] |= 1 << 15;
        p.values[4] = offset;
        return p;
      }
      assert.deepEqual(drawPacket(native, packet(indexed)), drawPacket(native, packet(reference)),
        'tiling pixels differ from independent ordinary RGBA backing');
      assert.equal(owner(indexed).palette, false, 'tiling does not create indexed storage');
      assert.ok(owner(indexed).gpuBytes >= 64 * 64 * 4, 'ordinary RGBA storage');
      const uploads = native.images.memory().textureUploadBytes;
      drawPacket(native, packet(indexed));
      assert.equal(native.images.memory().textureUploadBytes, uploads, 'stable tiling must not upload again');
      comparisons++;
    } finally { native.images.release(indexed.handle); }
  }
  console.log(JSON.stringify({ comparisons }));
} finally {
  native.images.release(reference.handle); native.runtime.quit();
}
