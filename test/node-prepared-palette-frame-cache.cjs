'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { temporaryDirectory } = require('./helpers/temp.cjs');
const { png } = require('./helpers/png.cjs');
const { spritePacket, drawPacket } = require('./helpers/sparse-palette.cjs');
const native = require(path.resolve(process.argv[2]));
const root = temporaryDirectory('palette-frame-cache-');
const width = 960, height = 256;
const pixels = Buffer.alloc(width * height * 4);
for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
  const color = (x + y * 13) % 512;
  pixels.set([color % 256, (color * 7) % 256, color < 256 ? 43 : 173,
    [0, 85, 170, 255][color % 4]], (y * width + x) * 4);
}
fs.writeFileSync(path.join(root, 'sheet.png'), png(width, height, pixels));
native.initialize({ gameRoot: root, width: 112, height: 96, windowTitle: 'Palette frame cache',
  imageWarmCacheBytes: 0, preparedFrameCacheBytes: 8 * 1024 * 1024 });

(async () => {
  let image, reference;
  try {
    const directory = path.join(root, 'prepared'); fs.mkdirSync(directory);
    const descriptor = await native.assets.processImage('sheet.png', directory,
      { grid: [3, 1], framePages: true }, path.join(root, 'sheet.png'), null, { pageCodec: 'lz4' });
    const storage = await native.assets.classifyImageStorage(path.join(root, 'sheet.png'));
    assert.ok(storage.paletteBits, 'fixture must exercise palette decoding');
    const sourceIdentity = native.assets.sourceIdentity('sheet.png');
    native.assets.installImageStorage([{ source: 'sheet.png', sourceIdentity, storage }]);
    native.assets.installPrepared([{ source: 'sheet.png', sourceIdentity, directory, descriptor }]);
    image = await native.images.loadAsync('sheet.png');
    reference = native.canvas.create(width, height);
    native.canvas.writePixels(reference.handle, 0, 0, width, height, pixels);
    function draw(source, crop, nearest, packed) {
      const packet = spritePacket(native, source, { crop, nearest, scale: 0.31,
        premultiplied: source === reference });
      if (packed) packet.metadata[5] &= ~(1 << 17);
      packet.values[4] = 0.25; packet.values[5] = 0.5;
      return drawPacket(native, packet);
    }
    for (const crop of [[0, 0, width, height], [0, 0, 320, height],
      [320, 0, 320, height], [640, 0, 320, height]]) {
      const before = native.images.memory();
      for (const nearest of [true, false]) for (const packed of [true, false]) {
        const expected = draw(reference, crop, nearest, packed);
        const actual = draw(image, crop, nearest, packed);
        let maximum = 0;
        for (let i = 0; i < actual.length; i++) maximum = Math.max(maximum, Math.abs(actual[i] - expected[i]));
        assert.ok(maximum <= 2, `crop ${crop}, nearest=${nearest}, packed=${packed}: delta ${maximum}`);
      }
      const warm = native.images.memory();
      assert.equal(warm.preparedFrameCacheMisses, 0);
      assert.equal(warm.preparedFrameConversions, 0);
      assert.equal(warm.sourceTextureBuilds, 0);
      for (let repeat = 0; repeat < 3; repeat++) draw(image, crop, true, false);
      const after = native.images.memory();
      assert.equal(after.preparedFrameConversions, warm.preparedFrameConversions);
      assert.equal(after.preparedFrameCacheMisses, warm.preparedFrameCacheMisses);
      assert.equal(after.textureUploadBytes, warm.textureUploadBytes);
      assert.equal(after.renderReadbacks, 0);
      assert.ok(after.preparedFrameCacheBytes <= after.preparedFrameCacheBudget);
    }
  } finally {
    if (reference) native.canvas.release(reference.handle);
    if (image) native.images.release(image.handle);
    native.beginFrame();
    assert.equal(native.images.memory().preparedFrameCacheBytes, 0);
    native.runtime.quit(); fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
