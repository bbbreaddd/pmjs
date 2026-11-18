'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const test = require('node:test');
const { temporaryDirectory } = require('./helpers/temp.cjs');
const { fixture, preparePair, spritePacket, drawPacket } = require('./helpers/sparse-palette.cjs');
const native = require(path.resolve(process.argv[2]));
const disabled = process.argv.includes('--disabled');

test('prepared images preserve pixels and ownership without GPU palettes', async () => {
  const root = temporaryDirectory('sparse-palette-');
  const source = fixture(root, 257, 259);
  if (disabled) fs.writeFileSync(path.join(root, 'artifact.png'), source.bytes);
  native.initialize({ ...(disabled ? {} : { imagePalettization: true }), gameRoot: root, width: 64, height: 48, windowTitle: 'Sparse palette', imageWarmCacheBytes: 0 });
  let pair, reference;
  const owner = image => native.images.memory(100).largest.find(entry => entry.handle === image.handle);
  const draw = (image, options) => drawPacket(native, spritePacket(native, image, options));
  try {
    pair = await preparePair(native, root);
    reference = native.images.loadBytes(source.bytes);
    draw(reference, { mipmap: true });
    assert.equal(owner(reference).palette, false, 'reference must use ordinary RGBA');
    for (const crop of [[0, 0, 64, 48], [31, 31, 64, 48], [193, 211, 64, 48]]) {
      for (const effect of [{}, { flash: [1, 0.5, 0.25, 0.5] },
        { tone: [0.13, -0.07, 0.04, 0.65], flash: [0.3, 0.7, 0.2, 0.3] }]) {
        assert.deepEqual(draw(pair.sparse, { crop, ...effect }), draw(reference, { crop, ...effect }));
        assert.deepEqual(draw(pair.dense, { crop, ...effect }), draw(reference, { crop, ...effect }));
      }
    }
    if (disabled) {
      const rawDirectory = path.join(root, 'raw'); fs.mkdirSync(rawDirectory);
      const raw = await native.assets.processImage('sparse.png', rawDirectory,
        { grid: [1, 1], backdrop: [0, 0, 0, 0] }, path.join(root, 'sparse.png'), null, { pageCodec: 'lz4' });
      assert.equal(fs.readFileSync(path.join(rawDirectory, raw.pages[0].path)).readUInt32LE(4), 1);
      const artifactDirectory = path.join(root, 'artifact'); fs.mkdirSync(artifactDirectory);
      const artifact = await native.assets.processImage('artifact.png', artifactDirectory,
        { grid: [1, 1], framePages: true }, path.join(root, 'artifact.png'), null,
        { pageCodec: 'lz4', allowPalettes: true });
      assert.ok(artifact.textureArtifact, 'fixture must contain an old palette texture artifact');
      assert.notEqual(fs.readFileSync(path.join(artifactDirectory, artifact.textureArtifact)).readUInt32LE(8), 5);
      native.assets.installPrepared([{ source: 'artifact.png', directory: artifactDirectory,
        descriptor: artifact, sourceIdentity: native.assets.sourceIdentity('artifact.png') }]);
      const image = await native.images.loadAsync('artifact.png');
      try {
        assert.deepEqual(draw(image), draw(reference));
        assert.equal(owner(image).palette, false, 'old texture artifact bypassed the default policy');
      } finally { native.images.release(image.handle); }
      for (const image of [pair.sparse, pair.dense]) {
        draw(image, { nearest: false });
        assert.equal(owner(image).palette, false, 'cached palette bypassed the default policy');
        assert.equal(owner(image).paletteSparse, false);
      }
      return;
    }
    native.beginFrame();
    const sparseOwner = owner(pair.sparse), denseOwner = owner(pair.dense);
    assert.equal(sparseOwner.palette, false);
    assert.equal(denseOwner.palette, false);
    const uploads = native.images.memory().textureUploadBytes;
    draw(pair.sparse); draw(pair.sparse);
    assert.equal(native.images.memory().textureUploadBytes, uploads, 'stable sparse draw reuploaded its planes');

    const canvas = native.canvas.create(9, 3);
    try {
      native.canvas.drawImage(canvas.handle, pair.sparse.handle, 31, 31, 9, 3, 0, 0, 9, 3, 1);
      const pixels = Buffer.from(native.canvas.readPixels(canvas.handle, 0, 0, 9, 3));
      // Canvas applies alpha compositing; compare against the ordinary source path.
      native.canvas.clear(canvas.handle);
      native.canvas.drawImage(canvas.handle, reference.handle, 31, 31, 9, 3, 0, 0, 9, 3, 1);
      assert.deepEqual(pixels, Buffer.from(native.canvas.readPixels(canvas.handle, 0, 0, 9, 3)));
      assert.equal(owner(pair.sparse).palette, false, 'pixel reads do not create palette storage');
    } finally { native.canvas.release(canvas.handle); }

    const alias = await native.images.loadAsync('sparse.png');
    assert.equal(alias.handle, pair.sparse.handle);
    native.images.release(alias.handle);
    assert.deepEqual(draw(pair.sparse, { nearest: false, crop: [0.25, 0.5, 63, 47], scale: 0.9 }),
      draw(reference, { nearest: false, crop: [0.25, 0.5, 63, 47], scale: 0.9 }));
    native.beginFrame();
    assert.equal(owner(pair.sparse).paletteSparse, false, 'LINEAR must use dense decoded-color sampling');
    const settled = native.images.memory().textureUploadBytes;
    draw(pair.sparse);
    assert.equal(owner(pair.sparse).paletteSparse, false, 'nearest draw must reuse dense backing');
    assert.equal(native.images.memory().textureUploadBytes, settled);
    assert.deepEqual(draw(pair.sparse, { standalone: true }), draw(reference, { standalone: true }));
    console.log(JSON.stringify({ sparseBytes: sparseOwner.gpuBytes, denseBytes: denseOwner.gpuBytes }));
  } finally {
    native.beginFrame();
    for (const image of [reference, pair?.dense, pair?.sparse]) if (image) native.images.release(image.handle);
    native.runtime.quit();
  }
});
