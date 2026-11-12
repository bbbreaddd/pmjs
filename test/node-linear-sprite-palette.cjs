'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { png } = require('./helpers/png.cjs');
const { spritePacket, drawPacket, preparedImage } = require('./helpers/sparse-palette.cjs');
const { temporaryDirectory } = require('./helpers/temp.cjs');
const root = temporaryDirectory('linear-palette-');
const native = require(path.resolve(process.argv[2]));

const pixels = Buffer.alloc(64 * 64 * 4);
for (let i = 0; i < 64 * 64; i++) pixels.set([253, 253, 253, i === 66 ? 255 : 0], i * 4);
const bytes = png(64, 64, pixels);
fs.writeFileSync(path.join(root, 'sprite.png'), bytes);
native.initialize({ gameRoot: root, width: 8, height: 8,
  windowTitle: 'Linear sprite storage', imageWarmCacheBytes: 0 });
const reference = native.images.loadBytes(bytes);
let indexed;
const owner = image => native.images.memory(100).largest.find(entry => entry.handle === image.handle);
function packet(image, mipmap = false) {
  const p = spritePacket(native, image, { nearest: false, crop: [0, 0, 64, 64], scale: 1.25, mipmap });
  p.metadata[3] = 0xffffff;
  p.values[6] = 1;
  return p;
}
(async () => { try {
  indexed = await preparedImage(native, root, 'sprite.png', bytes);
  native.render.setClearColor(0, 0, 0, 0);
  const expected = drawPacket(native, packet(reference, true));
  assert.equal(owner(reference).palette, false, 'control must use ordinary texture filtering');
  const actual = drawPacket(native, packet(indexed));
  let differingBytes = 0, maxByteDelta = 0;
  for (let i = 0; i < actual.length; i++) {
    const delta = Math.abs(actual[i] - expected[i]);
    if (delta) differingBytes++;
    maxByteDelta = Math.max(maxByteDelta, delta);
  }
  assert.ok(maxByteDelta <= 1, 'decoded palette interpolation exceeded one byte of rounding');
  assert.equal(owner(indexed).palette, true, 'linear draw must retain indexed storage');
  console.log(JSON.stringify({ differingBytes, maxByteDelta }));
  const uploads = native.images.memory().textureUploadBytes;
  assert.deepEqual(drawPacket(native, packet(indexed)), actual);
  assert.equal(native.images.memory().textureUploadBytes, uploads, 'stable draw must reuse texture backing');
} finally {
  if (indexed) native.images.release(indexed.handle);
  native.images.release(reference.handle);
  native.runtime.quit();
}
})().catch(error => { console.error(error); process.exitCode = 1; });
