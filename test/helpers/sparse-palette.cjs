'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { png } = require('./png.cjs');

function fixture(root, width = 512, height = 512, alpha = true, clustered = false) {
  const pixels = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; ++i) {
    const rare = i % 31 === 0 || (clustered && i % width < 32 && Math.floor(i / width) < 32);
    pixels.set([i & 255, rare ? (i >>> 8) & 31 : 97, rare ? 137 : 51,
      alpha && rare ? i % 255 : 255], i * 4);
  }
  const bytes = png(width, height, pixels);
  for (const name of ['dense.png', 'sparse.png']) fs.writeFileSync(path.join(root, name), bytes);
  return { width, height, pixels, bytes };
}

async function preparePair(native, root) {
  const sparseDirectory = path.join(root, 'sparse'), denseDirectory = path.join(root, 'dense');
  fs.mkdirSync(sparseDirectory); fs.mkdirSync(denseDirectory);
  const recipe = { grid: [1, 1], backdrop: [0, 0, 0, 0] };
  const sparse = await native.assets.processImage('sparse.png', sparseDirectory, recipe,
    path.join(root, 'sparse.png'), null, { pageCodec: 'lz4' });
  assert.ok(sparse && sparse.pages.length === 1);
  const header = fs.readFileSync(path.join(sparseDirectory, sparse.pages[0].path));
  assert.equal(header.readUInt32LE(4), 2, 'fixture did not activate offline sparse encoding');
  const dense = await native.assets.processImage('dense.png', denseDirectory, recipe,
    path.join(root, 'dense.png'), sparse, { pageCodec: 'png' });
  assert.deepEqual(dense.cells, sparse.cells, 'controls must use the same prepared layout');
  assert.deepEqual(dense.pages.map(p => [p.width, p.height]), sparse.pages.map(p => [p.width, p.height]));
  assert.equal(native.assets.installPrepared([
    { source: 'dense.png', directory: denseDirectory, descriptor: dense,
      sourceIdentity: native.assets.sourceIdentity('dense.png') },
    { source: 'sparse.png', directory: sparseDirectory, descriptor: sparse,
      sourceIdentity: native.assets.sourceIdentity('sparse.png') },
  ]), 2);
  return { dense: await native.images.loadAsync('dense.png'), sparse: await native.images.loadAsync('sparse.png'),
    descriptor: sparse, sparseFile: path.join(sparseDirectory, sparse.pages[0].path) };
}

async function preparedImage(native, root, source, bytes) {
  fs.writeFileSync(path.join(root, source), bytes);
  const directory = path.join(root, source + '-prepared');
  fs.mkdirSync(directory);
  const descriptor = await native.assets.processImage(source, directory, { grid: [1, 1], framePages: true });
  assert.ok(descriptor.textureArtifact, 'fixture must prepare its texture before loading');
  assert.equal(native.assets.installPrepared([{ source, directory, descriptor,
    sourceIdentity: native.assets.sourceIdentity(source) }]), 1);
  return native.images.load(source);
}

function spritePacket(native, image, { nearest = true, count = 1, crop = [0, 0, 64, 48],
  tone, flash, mipmap = false, standalone = false, premultiplied = false, scale = 1 } = {}) {
  const schema = native.scene.schema;
  const metadata = new Uint32Array(schema.metadataStride * count);
  const values = new Float32Array(schema.valueStride * count);
  const flags = (nearest ? 8 : 0) | (tone || flash ? 1 << 4 : 0) | (1 << 17) |
    (mipmap ? 1 << 16 : 0) | (standalone ? (1 << 13) | (1 << 10) : 0) |
    (premultiplied ? 1 << 10 : 0);
  for (let i = 0; i < count; ++i) {
    metadata.set([1, 0xffffffff, image.handle, 0xa7c3e9, 0, flags, 0], i * schema.metadataStride);
    const at = i * schema.valueStride;
    values.set([scale, 0, 0, scale, 0, 0, 0.63], at);
    values.set(crop, at + 9); values.set(crop.slice(2), at + 13);
    if (tone) values.set(tone, at + 33);
    if (flash) values.set(flash, at + 37);
  }
  return { metadata, values, count };
}

function drawPacket(native, packet, capture = true) {
  native.beginFrame();
  native.scene.submit(native.scene.schema.version, packet.metadata, packet.values, packet.count);
  native.renderScene();
  return capture ? Buffer.from(native.canvas.captureSceneRawPremultiplied()) : null;
}

module.exports = { fixture, preparePair, preparedImage, spritePacket, drawPacket };
