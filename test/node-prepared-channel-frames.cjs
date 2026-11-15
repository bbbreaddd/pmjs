'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { png } = require('./helpers/png.cjs');
const { temporaryDirectory } = require('./helpers/temp.cjs');
const { spritePacket, drawPacket } = require('./helpers/sparse-palette.cjs');
const native = require(path.resolve(process.argv[2]));
const budget = Number(process.argv[3]);
const root = temporaryDirectory('prepared-channel-frames-');
const width = 768, height = 256, pixels = Buffer.alloc(width * height * 4);
for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
  pixels.set([x % 251, y % 251, (x + y) % 251,
    (Math.floor(x / 8) + Math.floor(y / 8)) % 3 ? 96 + x % 8 * 19 : 0], (y * width + x) * 4);
}
const bytes = png(width, height, pixels);
fs.writeFileSync(path.join(root, 'sheet.png'), bytes);
native.initialize({ gameRoot: root, width: 280, height: 280, windowTitle: 'Prepared channel frames',
  imageWarmCacheBytes: 0, preparedFrameCacheBytes: budget });
(async function() {
  let image, original, retained;
  try {
    const directory = path.join(root, 'prepared'); fs.mkdirSync(directory);
    const descriptor = await native.assets.processImage('sheet.png', directory,
      { grid: [3, 1], framePages: true }, path.join(root, 'sheet.png'), null, { pageCodec: 'lz4' });
    assert.ok(descriptor.textureArtifact);
    native.assets.installPrepared([{ source: 'sheet.png', directory, descriptor,
      sourceIdentity: native.assets.sourceIdentity('sheet.png') }]);
    image = await native.images.loadAsync('sheet.png');
    retained = native.images.acquireCached('sheet.png');
    original = native.images.loadBytes(bytes);
    function packet(source, frame) {
      return spritePacket(native, source, { crop: [frame * 256, 0, 256, 256], scale: 1, nearest: false });
    }
    const expected = [0, 1, 2].map(frame => drawPacket(native, packet(original, frame)));
    const baseline = native.images.memory();
    for (let frame = 0; frame < 3; frame++) {
      const actual = drawPacket(native, packet(image, frame));
      let delta = 0;
      for (let i = 0; i < actual.length; i++) delta = Math.max(delta, Math.abs(actual[i] - expected[frame][i]));
      assert.ok(delta <= 1, `frame ${frame}: pixel difference ${delta}`);
    }
    for (let repeat = 0; repeat < 20; repeat++) for (let frame = 0; frame < 3; frame++)
      drawPacket(native, packet(image, frame), false);
    const warm = native.images.memory();
    native.images.release(image.handle); image = null;
    for (let repeat = 0; repeat < 4; repeat++) for (let frame = 0; frame < 3; frame++)
      drawPacket(native, packet(retained, frame), false);
    const after = native.images.memory();
    assert.ok(after.blockTextureUploads > baseline.blockTextureUploads);
    assert.equal(after.preparedMaterializations, baseline.preparedMaterializations);
    assert.ok(after.preparedFrameCacheBytes <= budget);
    assert.equal(after.preparedFrameCacheMisses, warm.preparedFrameCacheMisses);
    assert.equal(after.textureUploadBytes, warm.textureUploadBytes);
    assert.equal(after.preparedPageDecodes, warm.preparedPageDecodes);
    assert.equal(after.renderReadbacks, baseline.renderReadbacks);
    if (budget >= 3 * 258 * 258 * 4) {
      assert.ok(after.preparedFrameCacheHits > warm.preparedFrameCacheHits);
      assert.equal(after.preparedFrameCacheEvictions, baseline.preparedFrameCacheEvictions);
    } else if (budget >= 258 * 258 * 4) {
      assert.ok(after.preparedFrameCacheEvictions > baseline.preparedFrameCacheEvictions);
    } else assert.equal(after.preparedFrameCacheMisses, baseline.preparedFrameCacheMisses);
  } finally {
    for (const owner of [image, original, retained]) if (owner) native.images.release(owner.handle);
    native.beginFrame();
    assert.equal(native.images.memory().preparedFrameCacheBytes, 0);
    assert.equal(native.images.memory().preparedFrameResidentBytes, 0);
    native.runtime.quit();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
