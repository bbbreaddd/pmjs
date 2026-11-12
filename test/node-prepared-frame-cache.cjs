'use strict';

process.env.PMJS_GRAPHICS_DIAGNOSTICS = '1';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { png } = require('./helpers/png.cjs');
const { temporaryDirectory } = require('./helpers/temp.cjs');
const native = require(path.resolve(process.argv[2]));
const root = temporaryDirectory('pmjs-prepared-frame-cache-');
const disabled = process.argv[4] === '--disabled';
const defaultBudget = process.argv[4] === '--default';
const budget = 5000;
const colors = [[237, 43, 89, 255], [32, 96, 128, 128], [66, 84, 240, 85]];
writeSheet(colors);
native.initialize({ gameRoot: root, width: 160, height: 56,
  windowTitle: 'prepared frame cache', imageWarmCacheBytes: 0,
  ...(defaultBudget ? {} : { preparedFrameCacheBytes: disabled ? 0 : budget }) });
native.render.setClearColor(0, 0, 0, 1);
const schema = native.scene.schema;

function writeSheet(palette) {
  const pixels = Buffer.alloc(96 * 24 * 4);
  for (let frame = 0; frame < 3; ++frame) {
    for (let y = 8; y < 16; ++y) for (let x = 10; x < 22; ++x) {
      pixels.set(palette[frame], (y * 96 + frame * 32 + x) * 4);
    }
  }
  fs.writeFileSync(path.join(root, 'sheet.png'), png(96, 24, pixels));
}

async function prepare(name, palette) {
  writeSheet(palette);
  const directory = path.join(root, name);
  fs.mkdirSync(directory);
  const descriptor = await native.assets.processImage('sheet.png', directory,
    { grid: [6, 2], backdrop: [0, 0, 0, 0] });
  assert.ok(descriptor, 'fixture must use prepared image storage');
  // Keep this fixture on ordinary storage so it exercises the frame cache.
  native.assets.installImageStorage([{ source: 'sheet.png',
    sourceIdentity: native.assets.sourceIdentity('sheet.png'),
    storage: { version: 1, width: 96, height: 24, paletteBits: 0, channels: 4,
      source: [0, 1, 2, 3], swizzle: [0, 1, 2, 3] } }]);
  native.assets.installPrepared([{ source: 'sheet.png', directory, descriptor,
    sourceIdentity: native.assets.sourceIdentity('sheet.png') }]);
  return native.images.loadAsync('sheet.png');
}

function render(image, frames, { fractional = false, flags = 0, overlap = false } = {}) {
  const metadata = new Uint32Array(frames.length * schema.metadataStride);
  const values = new Float32Array(frames.length * schema.valueStride);
  for (let i = 0; i < frames.length; ++i) {
    metadata.set([1, 0xffffffff, image.handle, 0xffffff, 0, flags, 0], i * schema.metadataStride);
    const offset = i * schema.valueStride;
    // Fractional placement/scaling selects linear sampling on an NPOT sheet.
    values.set([1.1, 0, 0, 1.1, 4.25 + (overlap ? 0 : i * 38), 8.25, 1], offset);
    values.set(fractional ? [frames[i] * 32 + 0.25, 0.5, 30.5, 22] :
      [frames[i] * 32, 0, 32, 24], offset + 9);
    values.set(fractional ? [30.5, 22] : [32, 24], offset + 13);
  }
  native.beginFrame();
  native.scene.submit(schema.version, metadata, values, frames.length);
  native.renderScene();
  return Buffer.from(native.canvas.captureSceneRawPremultiplied());
}

function assertCenters(pixels, frames, palette) {
  frames.forEach((frame, index) => {
    const offset = (21 * 160 + 21 + index * 38) * 4;
    const [r, g, b, alpha] = palette[frame];
    const expected = [r, g, b].map(channel => Math.round(channel * alpha / 255));
    assert.deepEqual(Array.from(pixels.subarray(offset, offset + 4)), [...expected, 255],
      `sprite ${index} lost its frame texture`);
  });
}

function readFrame(image, frame = 0) {
  const canvas = native.canvas.create(32, 24);
  try {
    native.canvas.drawImage(canvas.handle, image.handle, frame * 32, 0, 32, 24, 0, 0, 32, 24, 1);
    return Buffer.from(native.canvas.readPixels(canvas.handle, 0, 0, 32, 24));
  } finally { native.canvas.release(canvas.handle); }
}

async function main() {
  const image = await prepare('initial', colors);
  assert.deepEqual([image.width, image.height], [96, 24], 'logical sheet dimensions changed');
  const originalPixels = readFrame(image);
  const originalTranslucent = readFrame(image, 1);
  const translucentOffset = (12 * 32 + 16) * 4;
  assert.deepEqual(Array.from(originalTranslucent.subarray(translucentOffset, translucentOffset + 4)),
    colors[1], 'CPU pixels must remain straight alpha');
  const before = native.images.memory();
  assert.equal(before.preparedFrameCacheBudget, disabled ? 0 : defaultBudget ? 33554432 : budget);
  const first = render(image, [0]);
  assertCenters(first, [0], colors);
  const loaded = native.images.memory();
  if (disabled) {
    assert.equal(loaded.preparedFrameCacheBytes, 0);
    assert.equal(loaded.preparedFrameCacheMisses, before.preparedFrameCacheMisses);
    assert.equal(loaded.sourceTextureBuilds, 0, 'disabled caching must not compile textures during drawing');
    native.images.release(image.handle);
    return;
  }
  assert.ok(loaded.preparedFrameCacheMisses > before.preparedFrameCacheMisses);
  assert.ok(loaded.preparedFrameCacheBytes > 0);
  assert.ok(loaded.preparedFrameCacheBytes <= loaded.preparedFrameCacheBudget);
  assert.equal(loaded.preparedMaterializations, before.preparedMaterializations,
    'linear NPOT sprite reconstructed the full sheet');
  assertCenters(render(image, [0]), [0], colors);
  const repeated = native.images.memory();
  assert.ok(repeated.preparedFrameCacheHits > loaded.preparedFrameCacheHits);
  assert.equal(repeated.textureUploadBytes, loaded.textureUploadBytes,
    'cached frame uploaded its pixels again');
  if (defaultBudget) {
    native.images.release(image.handle);
    native.beginFrame();
    assert.equal(native.images.memory().preparedFrameCacheBytes, 0);
    return;
  }

  // Four queued draws exceed a one-frame cache, but every queued texture
  // must stay alive until the renderer consumes the complete scene.
  assertCenters(render(image, [0, 1, 2, 0]), [0, 1, 2, 0], colors);
  const evicted = native.images.memory();
  assert.ok(evicted.preparedFrameCacheEvictions > repeated.preparedFrameCacheEvictions);
  assert.ok(evicted.preparedFrameCacheBytes <= budget);
  assert.ok(evicted.preparedFrameResidentBytes > evicted.preparedFrameCacheBytes);
  assert.equal(evicted.preparedFrameEvictedBytes,
    evicted.preparedFrameResidentBytes - evicted.preparedFrameCacheBytes);
  const batch = Array.from({ length: 31 }, (_, index) => index % 3);
  assertCenters(render(image, batch, { overlap: true }), [0], colors);
  const peak = native.images.memory();
  assert.ok(peak.preparedFrameResidentBytes > 20 * budget,
    'physical accounting omitted textures evicted during the submitted batch');
  assert.ok(peak.preparedFramePeakResidentBytes >= peak.preparedFrameResidentBytes);
  assert.ok(peak.preparedFrameCacheBytes <= budget);
  assertCenters(render(image, [2]), [2], colors);
  native.beginFrame();
  const settled = native.images.memory();
  assert.equal(settled.preparedFrameResidentBytes, settled.preparedFrameCacheBytes);
  assert.equal(settled.sourceTextureBuilds, 0);
  assert.equal(settled.preparedFrameEvictedBytes, 0);

  assert.equal(evicted.preparedMaterializations, before.preparedMaterializations);
  assertCenters(render(image, [2, 1, 0]), [2, 1, 0], colors);
  assertCenters(render(image, [1], { fractional: true }), [1], colors);
  assert.equal(native.images.memory().preparedMaterializations, before.preparedMaterializations,
    'fractional source coordinates reconstructed the logical sheet');
  assert.deepEqual(readFrame(image), originalPixels,
    'frame caching changed the pixels read through the original image');
  assert.deepEqual(readFrame(image, 1), originalTranslucent,
    'premultiplied frame textures changed raw straight-alpha pixels');
  native.images.release(image.handle);
  native.beginFrame();
  assert.equal(native.images.memory().preparedFrameCacheBytes, 0,
    'releasing the source retained cached frame textures');
  assert.equal(native.images.memory().preparedFrameResidentBytes, 0);

  // Reloading the same logical source after release must not reuse a frame
  // from the previous image, even if native image slots are recycled.
  const replacementColors = [[223, 181, 19, 255], colors[1], colors[2]];
  const replacement = await prepare('replacement', replacementColors);
  assertCenters(render(replacement, [0]), [0], replacementColors);
  assert.equal(native.images.memory().preparedMaterializations, before.preparedMaterializations);
  const beforeMipmaps = native.images.memory();
  assertCenters(render(replacement, [0], { flags: 1 << 16 }), [0], replacementColors);
  const mipmaps = native.images.memory();
  assert.ok(mipmaps.preparedMaterializations > beforeMipmaps.preparedMaterializations,
    'mipmapped draws must retain full-sheet sampling');
  assert.equal(mipmaps.preparedFrameCacheMisses, beforeMipmaps.preparedFrameCacheMisses,
    'mipmap fallback constructed an approximate frame texture');
  native.images.release(replacement.handle);
}

test(`prepared frame cache ${disabled ? 'disabled' : defaultBudget ? 'default' : 'enabled'}`, async () => {
  try { await main(); }
  finally { native.runtime.quit(); }
});
