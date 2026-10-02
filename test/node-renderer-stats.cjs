'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const native = require(path.resolve(process.argv[2]));
native.initialize({gameRoot:path.resolve(process.argv[3]),assetRoot:'',width:32,height:32,windowTitle:'pmjs test'});

native.beginFrame();
native.render.quad(0, 0, 32, 32, 0.2, 0.3, 0.4, 1);
native.renderFrame();
const ordinaryPresentationStats = native.render.stats();
if (ordinaryPresentationStats.drawCalls !== 1 ||
    ordinaryPresentationStats.toneComposedPresentationFrames !== 0) {
  throw new Error('ordinary gameplay left the direct blit path: ' +
    JSON.stringify(ordinaryPresentationStats));
}

assert.equal(ordinaryPresentationStats.rendererTargetCreates, 1,
  'ordinary rendering should allocate only the scene target');

const image = native.images.load('fixture.png');
const stride = native.scene.schema.valueStride;
const end = [7, 0xffffffff, 0, 0xffffff, 0, 0, 0];
const maskMetadata = new Uint32Array([
  6, 0xffffffff, image.handle, 0xffffff, 3, 0, 0,
  1, 0xffffffff, image.handle, 0xffffff, 0, 0, 0,
  ...end
]);
const maskValues = new Float32Array(stride * 3);
for (let index = 0; index < 3; index++) {
  maskValues.set([1, 0, 0, 1, 0, 0, 1], index * stride);
}
maskValues.set([1, 0, 0, 1, 0, 0, 0, 0, 2, 2], 7);
maskValues.set([1, 0, 0, 2, 2], 22);
maskValues.set([0, 0, 2, 2], stride + 9);
maskValues.set([2, 2], stride + 13);
native.beginFrame();
native.scene.submit(native.scene.packetVersion, maskMetadata, maskValues, 3);
native.renderFrame();

const toneMetadata = new Uint32Array([
  3, 0xffffffff, 0, 0xff0000, 0, 0, 0,
  5, 0xffffffff, 0, 0xffffff, 0, 0, 0,
  3, 0xffffffff, 0, 0x0000ff, 0, 0, 0
]);
const toneValues = new Float32Array(stride * 3);
toneValues.set([1, 0, 0, 1, 0, 0, 1], 0);
toneValues.set([0, 0, 2, 2], 9);
toneValues.set([2, 2], 13);
toneValues.set([1, 0, 0, 1, 0, 0, 1], stride);
toneValues.set([0.5, 0, 0, 0, 0, 0, 1, 0, 0, 0,
  0, 0, 1, 0, 0, 0, 0, 0, 1, 0], stride + 7);
toneValues.set([1, 0, 0, 1, 0, 0, 0.5], stride * 2);
toneValues.set([0, 0, 2, 2], stride * 2 + 9);
toneValues.set([2, 2], stride * 2 + 13);
native.beginFrame();
native.scene.submit(native.scene.packetVersion, toneMetadata, toneValues, 3);
native.renderFrame();

const stats = native.render.stats();
if (!Array.isArray(stats.filterApplications) ||
    stats.filterApplications.length !== 31 ||
    stats.filterApplications[3] !== 1) {
  throw new Error('alpha-mask application was not attributed: ' +
    JSON.stringify(stats));
}
if (stats.toneAdjustDrawCalls !== 0 ||
    stats.toneComposedPresentationFrames !== 1 || stats.filterDrawCalls !== 1) {
  throw new Error('filter draw categories are inconsistent: ' +
    JSON.stringify(stats));
}
if (stats.filterTargetAcquires !== 1 || stats.filterTargetReuses !== 0 ||
    stats.filterTargetClears !== 1 || stats.rendererTargetCreates !== 4 ||
    stats.rendererTargetDestroys !== 0 || stats.framebufferChecks !== 4) {
  throw new Error('filter target lifecycle counters are inconsistent: ' +
    JSON.stringify(stats));
}
native.beginFrame();
native.renderFrame();
const retainedStats = native.render.stats();
if (retainedStats.retainedFrames !== 1 ||
    retainedStats.toneComposedPresentationFrames !== 2) {
  throw new Error('tone composition was not retained for presentation: ' +
    JSON.stringify(retainedStats));
}
// Resizing offscreen scratch must preserve the screen's pending tone and overlay.
for (const output of ['canvas', 'image']) {
  native.beginFrame();
  native.render.setRenderTargetSize(8, 8);
  native.scene.submit(native.scene.packetVersion, toneMetadata, toneValues, 3);
  if (output === 'canvas') {
    const target = native.canvas.create(8, 8);
    native.render.renderToCanvas(target.handle);
    const pixel = native.canvas.readPixels(target.handle, 4, 4, 1, 1);
    assert.ok([64, 0, 128, 255].every((value, index) => Math.abs(pixel[index] - value) <= 2),
      'offscreen tone must use its own scratch and preserve alpha');
    native.canvas.release(target.handle);
  } else {
    const target = native.render.renderToImage(8, 8);
    native.images.release(target.handle);
  }
  native.renderFrame();
}
const composedFrame = native.canvas.captureScene();
const composedPixel = native.canvas.readPixels(composedFrame.handle, 16, 16, 1, 1);
native.canvas.release(composedFrame.handle);
const expected = [64, 0, 128, 255];
if (!expected.every((value, index) => Math.abs(composedPixel[index] - value) <= 2)) {
  throw new Error('tone presentation composition changed pixel semantics: actual=' +
    Array.from(composedPixel) + ' expected=' + expected);
}

const beforeMaskReuse = native.render.stats();
native.beginFrame();
native.scene.submit(native.scene.packetVersion, maskMetadata, maskValues, 3);
native.renderFrame();
const afterMaskReuse = native.render.stats();
assert.equal(afterMaskReuse.filterTargetReuses - beforeMaskReuse.filterTargetReuses, 1);
assert.equal(afterMaskReuse.rendererTargetCreates, beforeMaskReuse.rendererTargetCreates);
assert.equal(afterMaskReuse.rendererTargetDestroys, beforeMaskReuse.rendererTargetDestroys);
