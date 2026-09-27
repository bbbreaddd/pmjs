'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const native = require(path.resolve(process.argv[2]));
native.initialize({ gameRoot: path.resolve(process.argv[3]), assetRoot: '',
  width: 16, height: 16, windowTitle: 'pmjs mesh post-tint overlay' });
native.render.configurePixiFragmentPrecision('highp');
native.render.setClearColor(0, 0, 0, 0);

const source = native.canvas.create(1, 1);
native.canvas.writePixels(source.handle, 0, 0, 1, 1,
  new Uint8Array([64, 128, 192, 255]));
const image = native.images.loadBytes(native.canvas.encodePng(source.handle));
const mesh = native.render.createMesh(image.handle,
  [2, 2, 14, 2, 2, 14, 14, 14],
  [0, 0, 1, 0, 0, 1, 1, 1],
  [0, 1, 2, 2, 1, 3], 1);
const schema = native.scene.schema;

function capturePixels() {
  const frame = native.canvas.captureScene();
  try {
    return native.canvas.readPixels(frame.handle, 0, 0, 16, 16);
  } finally {
    native.canvas.release(frame.handle);
  }
}

function pixelAt(pixels, x, y) {
  const offset = (y * 16 + x) * 4;
  return Array.from(pixels.slice(offset, offset + 4));
}

function sample(overlayAlpha, meshAlpha, resource = mesh, tint = 0xffffff) {
  const metadata = new Uint32Array([8, 0xffffffff, resource,
    tint, 0, overlayAlpha > 0 ? 512 : 0, 0]);
  const values = new Float32Array(schema.valueStride);
  values.set([1, 0, 0, 1, 0, 0, meshAlpha]);
  values.set([1, 0, 0, overlayAlpha], 37);
  native.beginFrame();
  native.scene.submit(schema.version, metadata, values, 1);
  native.renderScene();
  return pixelAt(capturePixels(), 8, 8);
}

function expectPixel(actual, expected, label) {
  for (let index = 0; index < 4; index++) {
    assert.ok(Math.abs(actual[index] - expected[index]) <= 2,
      `${label} channel ${index}: ${actual} / ${expected}`);
  }
}

function sampleSprite(blendAlpha, spriteAlpha) {
  const metadata = new Uint32Array([1, 0xffffffff, image.handle,
    0xffffff, 0, 16, 0]);
  const values = new Float32Array(schema.valueStride);
  values.set([16, 0, 0, 16, 0, 0, spriteAlpha]);
  values.set([0, 0, 1, 1], 9);
  values.set([1, 1], 13);
  values.set([1, 0, 0, blendAlpha], 37);
  native.beginFrame();
  native.scene.submit(schema.version, metadata, values, 1);
  native.renderScene();
  return pixelAt(capturePixels(), 8, 8);
}

const plain = sample(0, 1);
const overlaid = sample(0.5, 1);
const halfAlpha = sample(0.5, 0.5);
for (let index = 0; index < 3; index++) {
  assert.ok(Math.abs(plain[index] - [64, 128, 192][index]) <= 2,
    `plain channel ${index}: ${plain}`);
  assert.ok(Math.abs(overlaid[index] - [160, 64, 96][index]) <= 2,
    `overlay channel ${index}: ${overlaid}`);
  assert.ok(Math.abs(halfAlpha[index] - overlaid[index]) <= 2,
    `half-alpha channel ${index}: ${halfAlpha}`);
}
assert.equal(plain[3], 255);
assert.equal(overlaid[3], 255);
assert.ok(Math.abs(halfAlpha[3] - 128) <= 1);
const spriteBlend = sampleSprite(0.5, 1);
const spriteHalfAlpha = sampleSprite(0.5, 0.5);
for (let index = 0; index < 4; index++) {
  assert.ok(Math.abs(overlaid[index] - spriteBlend[index]) <= 2,
    `opaque mesh/sprite color channel ${index}: ${overlaid} / ${spriteBlend}`);
  assert.ok(Math.abs(halfAlpha[index] - spriteHalfAlpha[index]) <= 2,
    `mesh/sprite half-alpha channel ${index}: ${halfAlpha} / ${spriteHalfAlpha}`);
}

const translucentSource = native.canvas.create(1, 1);
native.canvas.writePixels(translucentSource.handle, 0, 0, 1, 1,
  new Uint8Array([64, 128, 192, 128]));
const translucentImage = native.images.loadBytes(
  native.canvas.encodePng(translucentSource.handle));
const translucentMesh = native.render.createMesh(translucentImage.handle,
  [2, 2, 14, 2, 2, 14, 14, 14],
  [0, 0, 1, 0, 0, 1, 1, 1], [0, 1, 2, 2, 1, 3], 1);
expectPixel(sample(0, 1, translucentMesh), [64, 128, 192, 128],
  'translucent plain');
expectPixel(sample(0.5, 1, translucentMesh), [160, 64, 96, 128],
  'translucent overlay');
expectPixel(sample(0.5, 0.5, translucentMesh), [160, 64, 96, 64],
  'translucent overlay with mesh opacity');
expectPixel(sample(0.5, 1, mesh, 0x80ff40), [144, 64, 24, 255],
  'mesh post-tint overlay');
expectPixel(sample(0.5, 1, translucentMesh, 0x80ff40), [144, 64, 24, 128],
  'translucent mesh post-tint overlay');

const pairMetadata = new Uint32Array([
  8, 0xffffffff, mesh, 0xffffff, 0, 512, 0,
  8, 0xffffffff, mesh, 0xffffff, 0, 0, 0
]);
const pairValues = new Float32Array(schema.valueStride * 2);
pairValues.set([0.5, 0, 0, 1, 0, 0, 1]);
pairValues.set([1, 0, 0, 0.5], 37);
pairValues.set([0.5, 0, 0, 1, 8, 0, 1], schema.valueStride);
native.beginFrame();
native.scene.submit(schema.version, pairMetadata, pairValues, 2);
native.renderScene();
const pairPixels = capturePixels();
expectPixel(pixelAt(pairPixels, 4, 8), [160, 64, 96, 255], 'overlaid first mesh');
expectPixel(pixelAt(pairPixels, 12, 8), [64, 128, 192, 255], 'plain mesh after overlaid mesh');

const corners = native.canvas.create(4, 4);
const cornerPixels = new Uint8Array(4 * 4 * 4);
for (let y = 0; y < 4; y++) {
  for (let x = 0; x < 4; x++) {
    cornerPixels.set(x < 2 ? y < 2 ? [255, 0, 0, 255] : [0, 0, 255, 255]
      : y < 2 ? [0, 255, 0, 255] : [255, 255, 0, 255],
    (y * 4 + x) * 4);
  }
}
native.canvas.writePixels(corners.handle, 0, 0, 4, 4, cornerPixels);
const cornerImage = native.images.loadBytes(native.canvas.encodePng(corners.handle));
const cornerMesh = native.render.createMesh(cornerImage.handle,
  [0, 0, 16, 0, 0, 16, 16, 16],
  [0, 0, 1, 0, 0, 1, 1, 1], [0, 1, 2, 2, 1, 3], 1);
const stripMesh = native.render.createMesh(cornerImage.handle,
  [0, 0, 16, 0, 0, 16, 16, 16],
  [0, 0, 1, 0, 0, 1, 1, 1], [0, 1, 2, 3], 0);
function cornerFrame(kind, meshResource = cornerMesh) {
  const resource = kind === 8 ? meshResource : cornerImage.handle;
  const metadata = new Uint32Array([kind, 0xffffffff, resource,
    0xffffff, 0, 0, 0]);
  const values = new Float32Array(schema.valueStride);
  values.set(kind === 8 ? [1, 0, 0, 1, 0, 0, 1] :
    [4, 0, 0, 4, 0, 0, 1]);
  if (kind === 1) {
    values.set([0, 0, 4, 4], 9);
    values.set([4, 4], 13);
  }
  native.beginFrame();
  native.scene.submit(schema.version, metadata, values, 1);
  native.renderScene();
  const pixels = capturePixels();
  return [[2, 2], [13, 2], [2, 13], [13, 13]].map(([x, y]) => pixelAt(pixels, x, y));
}
assert.deepEqual(cornerFrame(8), cornerFrame(1));
assert.deepEqual(cornerFrame(8, stripMesh), cornerFrame(1));

const separatedMesh = native.render.createMesh(image.handle,
  [1, 2, 7, 2, 1, 14, 9, 2, 15, 2, 15, 14],
  [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 1, 1], [0, 1, 2, 3, 4, 5], 1);
sample(0, 1, separatedMesh);
const separatedPixels = capturePixels();
expectPixel(pixelAt(separatedPixels, 2, 4), [64, 128, 192, 255], 'first independent triangle');
expectPixel(pixelAt(separatedPixels, 14, 4), [64, 128, 192, 255], 'second independent triangle');
expectPixel(pixelAt(separatedPixels, 8, 6), [0, 0, 0, 0], 'gap between independent triangles');
native.render.releaseMesh(separatedMesh);

const invalidValues = new Float32Array(schema.valueStride);
invalidValues.set([1, 0, 0, 1, 0, 0, 1]);
assert.throws(() => native.scene.submit(schema.version,
  new Uint32Array([8, 0xffffffff, mesh, 0xffffff, 0, 16, 0]),
  invalidValues, 1), 'meshes must not reuse the sprite-color flag');
assert.throws(() => native.scene.submit(schema.version,
  new Uint32Array([1, 0xffffffff, image.handle, 0xffffff, 0, 512, 0]),
  invalidValues, 1), 'mesh post-tint overlay must be rejected on other node kinds');
native.render.releaseMesh(stripMesh);
native.render.releaseMesh(cornerMesh);
native.images.release(cornerImage.handle);
native.canvas.release(corners.handle);
native.render.releaseMesh(translucentMesh);
native.images.release(translucentImage.handle);
native.canvas.release(translucentSource.handle);
native.render.releaseMesh(mesh);
native.images.release(image.handle);
native.canvas.release(source.handle);
