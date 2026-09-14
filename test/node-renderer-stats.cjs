'use strict';

const path = require('node:path');
const native = require(path.resolve(process.argv[2]));
native.initialize({gameRoot:path.resolve(process.argv[3]),assetRoot:'',width:32,height:32,windowTitle:'pmjs test'});

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
    stats.filterApplications.length !== 30 ||
    stats.filterApplications[3] !== 1) {
  throw new Error('alpha-mask application was not attributed: ' +
    JSON.stringify(stats));
}
if (stats.toneAdjustDrawCalls !== 0 ||
    stats.toneComposedPresentationFrames !== 1 || stats.filterDrawCalls !== 1) {
  throw new Error('filter draw categories are inconsistent: ' +
    JSON.stringify(stats));
}
if (stats.filterTargetAcquires !== 1 || stats.filterTargetReuses !== 1 ||
    stats.filterTargetClears !== 1 || stats.rendererTargetCreates < 9 ||
    stats.rendererTargetDestroys !== 0 || stats.framebufferChecks < 9) {
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
const composedFrame = native.canvas.captureScene();
const composedPixel = native.canvas.readPixels(composedFrame.handle, 16, 16, 1, 1);
native.canvas.release(composedFrame.handle);
const expected = [64, 0, 128, 255];
if (!expected.every((value, index) => Math.abs(composedPixel[index] - value) <= 2)) {
  throw new Error('tone presentation composition changed pixel semantics: actual=' +
    Array.from(composedPixel) + ' expected=' + expected);
}
