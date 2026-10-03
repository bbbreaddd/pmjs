'use strict';

process.env.PMJS_GRAPHICS_DIAGNOSTICS = '1';

const assert = require('node:assert/strict');
const path = require('node:path');
const native = require(path.resolve(process.argv[2]));
native.initialize({
  gameRoot: path.resolve(process.argv[3]),
  assetRoot: '',
  width: 16,
  height: 16,
  windowTitle: 'pmjs render-to-image test',
});

native.beginFrame();
native.render.quad(0, 0, 16, 16, 0, 1, 0, 1);
native.renderFrame();

native.beginFrame();
native.render.quad(0, 0, 16, 8, 1, 0, 0, 0.5);
native.render.quad(0, 8, 16, 8, 0, 0, 1, 1);
const rendered = native.render.renderToImage(16, 16);
if (!rendered || !rendered.handle || rendered.width !== 16 ||
    rendered.height !== 16) {
  throw new Error('renderToImage did not return a native image');
}

// Offscreen generation must not replace the last valid presentation frame.
native.renderFrame();
const retainedFrame = native.canvas.captureScene();
const retainedPixel = native.canvas.pixel(retainedFrame.handle, 8, 8);
native.canvas.release(retainedFrame.handle);
if (((retainedPixel >>> 16) & 0xff) < 240 ||
    ((retainedPixel >>> 24) & 0xff) > 15 ||
    ((retainedPixel >>> 8) & 0xff) > 15) {
  throw new Error('offscreen generation overwrote the retained scene');
}

native.beginFrame();
native.render.image(rendered.handle,
  1, 0, 0, 1, 0, 0,
  0, 0, 16, 16,
  1, 0xffffff, 0);
native.renderFrame();
const frame = native.canvas.captureScene();
const topPixel = native.canvas.pixel(frame.handle, 8, 2);
const bottomPixel = native.canvas.pixel(frame.handle, 8, 13);
native.canvas.release(frame.handle);
native.images.release(rendered.handle);
const topRed = (topPixel >>> 24) & 0xff;
if (topRed < 112 || topRed > 144 || ((topPixel >>> 16) & 0xff) > 15 ||
    ((topPixel >>> 8) & 0xff) > 15 || (topPixel & 0xff) < 240) {
  throw new Error('GPU render image did not preserve straight alpha: ' +
    topPixel.toString(16));
}
if (((bottomPixel >>> 8) & 0xff) < 240 ||
    ((bottomPixel >>> 24) & 0xff) > 15 ||
    ((bottomPixel >>> 16) & 0xff) > 15 || (bottomPixel & 0xff) < 240) {
  throw new Error('GPU render image orientation is inverted: ' +
    bottomPixel.toString(16));
}

native.beginFrame();
native.render.setRenderTargetSize(32, 8);
native.render.quad(0, 0, 32, 8, 1, 1, 1, 0.5);
const premultiplied = native.render.renderToImage(32, 8, { alphaMode: 'premultiplied' });
native.renderFrame();
const afterResize = native.canvas.captureScene();
assert.equal(native.canvas.pixel(afterResize.handle, 8, 2), topPixel,
  'different-size GPU image discarded retained screen pixels');
assert.equal(native.canvas.pixel(afterResize.handle, 8, 13), bottomPixel);
native.canvas.release(afterResize.handle);
const beforeRepeat = native.render.stats();
native.beginFrame();
native.render.setRenderTargetSize(32, 8);
native.render.quad(0, 0, 32, 8, 0, 0, 1, 1);
const repeated = native.render.renderToImage(32, 8);
assert.equal(native.render.stats().rendererTargetCreates, beforeRepeat.rendererTargetCreates);
assert.equal(native.render.stats().rendererTargetDestroys, beforeRepeat.rendererTargetDestroys);
native.images.release(repeated.handle);
const bitmap = native.mv.createBitmapMesh(premultiplied.handle,
  [0, 0, 16, 0, 16, 16, 0, 16], [0, 0, 1, 0, 1, 1, 0, 1],
  [0, 1, 2, 0, 2, 3], 1, { texelBounds: [0, 0, 31, 7], alphaMode: 'premultiplied' });
const schema = native.scene.schema;
native.render.setClearColor(0, 0, 0, 0);
for (const blend of [0, 0.5]) {
  native.beginFrame();
  const values = new Float32Array(schema.valueStride);
  values.set([1, 0, 0, 1, 0, 0, 1]);
  values.set([1, 0, 0, blend], 37);
  native.scene.submit(schema.version,
    new Uint32Array([8, 0xffffffff, bitmap, 0xffffff, 0, blend ? 16384 : 0, 0]), values, 1);
  native.renderScene();
  const capture = native.canvas.captureScene();
  const bytes = native.canvas.readPixels(capture.handle, 8, 8, 1, 1);
  native.canvas.release(capture.handle);
  const expected = blend ? [191, 64, 64, 128] : [255, 255, 255, 128];
  if (!bytes.every((value, index) => Math.abs(value - expected[index]) <= 2)) {
    throw new Error('offscreen premultiplied bitmap color mismatch: ' + bytes);
  }
}
native.render.releaseMesh(bitmap);
native.images.release(premultiplied.handle);

// A tall retained atlas must preserve one-pixel rows through GPU normalization.
// Medium-precision UVs round adjacent rows together above ~1024 texels.
const atlasHeight = 2158;
native.beginFrame();
native.render.setRenderTargetSize(16, atlasHeight);
for (let row = 0; row < atlasHeight; row++) {
  const shade = row % 2;
  native.render.quad(0, row, 16, 1, shade, shade, shade, 1);
}
const tallAtlas = native.render.renderToImage(16, atlasHeight, { alphaMode: 'premultiplied' });
for (const top of [0, 900, 1800, 2140]) {
  const crop = native.mv.createBitmapMesh(tallAtlas.handle,
    [0, 0, 16, 0, 16, 16, 0, 16],
    [0, top / atlasHeight, 1, top / atlasHeight,
      1, (top + 16) / atlasHeight, 0, (top + 16) / atlasHeight],
    [0, 1, 2, 0, 2, 3], 1, { texelBounds: [0, top, 15, top + 15], alphaMode: 'premultiplied' });
  native.beginFrame();
  const values = new Float32Array(schema.valueStride);
  values.set([1, 0, 0, 1, 0, 0, 1]);
  native.scene.submit(schema.version,
    new Uint32Array([8, 0xffffffff, crop, 0xffffff, 0, 8, 0]), values, 1);
  native.renderScene();
  const pixels = native.canvas.captureSceneRawPremultiplied();
  for (let y = 0; y < 16; y++) {
    const offset = (y * 16 + 8) * 4;
    const expected = (top + y) % 2 * 255;
    if (pixels[offset] !== expected || pixels[offset + 3] !== 255) {
      throw new Error(`Tall GPU atlas row ${top + y} changed: ${pixels.slice(offset, offset + 4)}`);
    }
  }
  native.render.releaseMesh(crop);
}
native.images.release(tallAtlas.handle);

// A clip-clear preserves the A8 edge mask, including repeated partial clears.
// It must leave queued scene commands intact and reject invalid batches atomically.
native.beginFrame();
native.render.setRenderTargetSize(16, 16);
native.render.quad(0, 0, 16, 16, 1, 1, 1, 1);
const erased = native.render.renderToImage(16, 16, { alphaMode: 'premultiplied' });
const erasedMesh = native.mv.createBitmapMesh(erased.handle,
  [0, 0, 16, 0, 16, 16, 0, 16], [0, 0, 1, 0, 1, 1, 0, 1],
  [0, 1, 2, 0, 2, 3], 1, { texelBounds: [0, 0, 15, 15], alphaMode: 'premultiplied' });
const triangle = [0, 0, 16, 0, 0, 16];
function erasedPixels(points) {
  native.beginFrame();
  const values = new Float32Array(schema.valueStride);
  values.set([1, 0, 0, 1, 0, 0, 1]);
  native.scene.submit(schema.version,
    new Uint32Array([8, 0xffffffff, erasedMesh, 0xffffff, 0, 8, 0]), values, 1);
  native.plugins.mpp.clearBackgroundTriangles(erased.handle, points);
  native.renderScene();
  return native.canvas.captureSceneRawPremultiplied();
}
assert.throws(() => native.plugins.mpp.clearBackgroundTriangles(erased.handle,
  [...triangle, 0, 0, Infinity, 0, 0, 16]), RangeError);
assert.throws(() => native.plugins.mpp.clearBackgroundTriangles(erased.handle, [1]), RangeError);
const intact = erasedPixels([]);
assert.equal(intact[(2 * 16 + 2) * 4 + 3], 255);
const once = erasedPixels(triangle);
assert.equal(once[(2 * 16 + 2) * 4 + 3], 0);
assert.equal(once[(13 * 16 + 13) * 4 + 3], 255);
assert.ok(Math.abs(once[(8 * 16 + 7) * 4 + 3] - 127) <= 1);
const twice = erasedPixels([0, 16, 16, 0, 16, 16]);
assert.ok(Math.abs(twice[(8 * 16 + 7) * 4 + 3] - 63) <= 1);
native.render.releaseMesh(erasedMesh);
native.images.release(erased.handle);
assert.throws(() => native.plugins.mpp.clearBackgroundTriangles(erased.handle, triangle), RangeError);

// A clear rectangle limits the triangle mask and remains transactional.
native.beginFrame(); native.render.quad(0, 0, 16, 16, 1, 1, 1, 1);
const bounded = native.render.renderToImage(16, 16, { alphaMode: 'premultiplied' });
const boundedSprite = new Float32Array(schema.valueStride);
boundedSprite.set([1, 0, 0, 1, 0, 0, 1]);
boundedSprite.set([0, 0, 16, 16], 9); boundedSprite.set([16, 16], 13);
assert.throws(() => native.plugins.mpp.clearBackgroundTriangles(bounded.handle, triangle, [0, 0, -1, 4]), RangeError);
native.plugins.mpp.clearBackgroundTriangles(bounded.handle, triangle, [0, 0, 4, 16]);
native.beginFrame();
native.scene.submit(schema.version, new Uint32Array([1, 0xffffffff, bounded.handle, 0xffffff, 0, 1032, 0]), boundedSprite, 1);
native.renderScene();
const boundedPixels = native.canvas.captureSceneRawPremultiplied();
assert.equal(boundedPixels[(2 * 16 + 2) * 4 + 3], 0);
assert.equal(boundedPixels[(2 * 16 + 6) * 4 + 3], 255);
native.images.release(bounded.handle);


// A toned translucent GPU Sprite must normalize premultiplied RGB exactly once.
native.beginFrame();
native.render.setRenderTargetSize(16, 16);
native.render.quad(0, 0, 16, 16, 0.5, 0.5, 0.5, 0.5);
const tonedSource = native.render.renderToImage(16, 16, { alphaMode: 'premultiplied' });
native.beginFrame();
native.render.setClearColor(0, 0, 0, 0);
const tonedValues = new Float32Array(schema.valueStride);
tonedValues.set([1, 0, 0, 1, 0, 0, 1]);
tonedValues.set([0, 0, 16, 16], 9); tonedValues.set([16,16], 13);
tonedValues[33] = 0.1;
native.scene.submit(schema.version,
  new Uint32Array([1, 0xffffffff, tonedSource.handle, 0xffffff, 0, 1024 | 16 | 8, 0]), tonedValues, 1);
native.renderScene();
const tonedCapture = native.canvas.captureScene();
const tonedPixel = native.canvas.readPixels(tonedCapture.handle, 8, 8, 1, 1);
const tonedExpected = [153, 128, 128, 128];
if (!tonedPixel.every((byte,index) => Math.abs(byte-tonedExpected[index]) <= 2)) {
  throw new Error('premultiplied Sprite tone normalized incorrectly: ' + tonedPixel);
}
native.canvas.release(tonedCapture.handle); native.images.release(tonedSource.handle);


assert.throws(() => native.render.renderToImage(16, 16, 1), /alphaMode|object/,
  'positional alpha booleans are rejected');
assert.throws(() => native.render.renderToImage(16, 16, {alphaMode:'unknown'}), /alphaMode/);
