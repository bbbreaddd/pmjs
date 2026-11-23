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
  assert.deepEqual([image.width, image.height], [96, 24]);
  const originalPixels = readFrame(image);
  const originalTranslucent = readFrame(image, 1);
  const before = native.images.memory();
  assert.equal(before.preparedPageSplitThresholdBytes, disabled ? 0 : defaultBudget ? 33554432 : budget);
  for (const frames of [[0], [0, 1, 2, 0], [2, 1, 0]]) {
    assertCenters(render(image, frames), frames, colors);
  }
  const batch = Array.from({ length: 31 }, (_, index) => index % 3);
  assertCenters(render(image, batch, { overlap: true }), [0], colors);
  assertCenters(render(image, [1], { fractional: true }), [1], colors);
  const warm = native.images.memory();
  assertCenters(render(image, [1], { fractional: true }), [1], colors);
  const after = native.images.memory();
  assert.equal(after.textureUploadBytes, warm.textureUploadBytes);
  for (const key of ['preparedPageTextureBytes', 'sourceTextureBuilds']) {
    assert.equal(after[key], 0, key);
  }
  assert.deepEqual(readFrame(image), originalPixels);
  assert.deepEqual(readFrame(image, 1), originalTranslucent);
  native.images.release(image.handle);
  native.beginFrame();
  const replacementColors = [[223, 181, 19, 255], colors[1], colors[2]];
  const replacement = await prepare('replacement', replacementColors);
  assertCenters(render(replacement, [0]), [0], replacementColors);
  assertCenters(render(replacement, [0], { flags: 1 << 16 }), [0], replacementColors);
  native.images.release(replacement.handle);
}

test(`prepared sprite fallback ${disabled ? 'disabled' : defaultBudget ? 'default' : 'enabled'}`, async () => {
  try { await main(); }
  finally { native.runtime.quit(); }
});
