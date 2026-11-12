'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { temporaryDirectory } = require('./helpers/temp.cjs');
const { fixture, preparePair, spritePacket, drawPacket } = require('./helpers/sparse-palette.cjs');
const native = require(path.resolve(process.argv[2]));

test('offline sparse palettes preserve pixels, ownership, and dense fallback', async () => {
  const root = temporaryDirectory('sparse-palette-');
  const source = fixture(root, 257, 259);
  native.initialize({ gameRoot: root, width: 64, height: 48, windowTitle: 'Sparse palette', imageWarmCacheBytes: 0 });
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
    native.beginFrame();
    const sparseOwner = owner(pair.sparse), denseOwner = owner(pair.dense);
    assert.equal(sparseOwner.paletteSparse, true);
    assert.equal(denseOwner.paletteSparse, false);
    assert.ok(sparseOwner.gpuBytes <= owner(reference).gpuBytes * 0.85, 'offline sparse storage must beat ordinary RGBA');
    assert.equal(sparseOwner.fullTextureResident, false);
    assert.ok(sparseOwner.cpuBytes < 128 * 1024, 'GPU upload retained packed planes or expanded RGBA');
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
      assert.equal(owner(pair.sparse).paletteSparse, true, 'pixel read promoted GPU backing');
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
