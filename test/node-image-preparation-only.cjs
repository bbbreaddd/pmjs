'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { temporaryDirectory } = require('./helpers/temp.cjs');
const { png } = require('./helpers/png.cjs');
const { spritePacket, drawPacket } = require('./helpers/sparse-palette.cjs');
const native = require(path.resolve(process.argv[2]));
const root = temporaryDirectory('image-preparation-only-');
const fixtures = ['missing', 'corrupt'].map(artifact => {
  const width = 128, height = 96, pixels = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++)
    pixels.set([i % 256, (i * 7) % 256, 73, [0, 85, 170, 255][i % 4]], i * 4);
  const bytes = png(width, height, pixels), source = artifact + '.png';
  fs.writeFileSync(path.join(root, source), bytes);
  const directory = path.join(root, artifact); fs.mkdirSync(directory);
  return { artifact, source, directory, bytes };
});
native.initialize({ gameRoot: root, width: 64, height: 48,
  windowTitle: 'Image preparation fallback', imageWarmCacheBytes: 0,
  preparedFrameCacheBytes: 1024 * 1024 });

async function run() {
  for (const { artifact, source, directory, bytes } of fixtures) {
    const descriptor = await native.assets.processImage(source, directory,
      { grid: [2, 1], framePages: true }, path.join(root, source), null, { pageCodec: 'lz4' });
    assert.ok(descriptor.pages.length);
    descriptor.framePages = true;
    descriptor.textureArtifact = 'texture.pmtx';
    const texture = path.join(directory, descriptor.textureArtifact);
    if (artifact === 'missing') fs.rmSync(texture, { force: true });
    else fs.writeFileSync(texture, Buffer.from('invalid texture artifact'));
    assert.equal(native.assets.installPrepared([{ source, directory, descriptor,
      sourceIdentity: native.assets.sourceIdentity(source) }]), 1);
    const prepared = await native.images.loadAsync(source), reference = native.images.loadBytes(bytes);
    try {
      for (const nearest of [true, false]) {
        const options = { nearest, crop: [0.25, 0.5, 63, 47], scale: 0.9 };
        const expected = drawPacket(native, spritePacket(native, reference, options));
        const actual = drawPacket(native, spritePacket(native, prepared, options));
        assert.deepEqual(actual, expected, artifact + ' artifact changed pixels');
      }
      const state = native.images.memory(100);
      assert.equal(state.largest.find(item => item.handle === prepared.handle).palette, false);
      for (const key of ['sourceTextureBuilds', 'preparedFrameConversions', 'preparedFrameCacheMisses']) {
        assert.equal(state[key], 0, key);
      }
      assert.ok(state.textureArtifactFailures > 0);
    } finally {
      native.beginFrame(); native.images.release(prepared.handle); native.images.release(reference.handle);
    }
  }
}
run().finally(() => native.runtime.quit()).catch(error => { console.error(error); process.exitCode = 1; });
