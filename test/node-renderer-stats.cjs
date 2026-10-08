'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const native = require(path.resolve(process.argv[2]));
const diagnostics = process.argv[4] !== '--without-diagnostics';
let ordinaryPixels;
if (diagnostics) {
  const output = execFileSync(process.execPath,
    [__filename, ...process.argv.slice(2, 4), '--without-diagnostics'], { encoding: 'utf8' });
  const frame = output.match(/^\[pmjs-uninstrumented-frame\] ([A-Za-z0-9+/=]+)$/m);
  assert.ok(frame, 'uninstrumented child returned its captured frame');
  ordinaryPixels = Buffer.from(frame[1], 'base64');
}
process.env.PMJS_GRAPHICS_DIAGNOSTICS = diagnostics ? '1' : '0';
native.initialize({gameRoot:path.resolve(process.argv[3]),assetRoot:'',width:32,height:32,windowTitle:'pmjs test'});

native.beginFrame();
native.render.quad(0, 0, 32, 32, 0.2, 0.3, 0.4, 1);
native.renderFrame();
const ordinaryPresentationStats = native.render.stats();
if (!diagnostics) {
  assert.equal(ordinaryPresentationStats.diagnostics, false);
  for (const [name, value] of Object.entries(ordinaryPresentationStats)) {
    if (typeof value === 'number' && !['rendererTargetBytes', 'rendererTargetPeakBytes',
      'rendererTargetCacheBytes'].includes(name)) assert.equal(value, 0, name + ' is disabled');
  }
  assert.equal(ordinaryPresentationStats.rendererTargetBytes, 32 * 32 * 8);
  assert.equal(ordinaryPresentationStats.rendererTargetPeakBytes, 32 * 32 * 8);
  assert.equal(ordinaryPresentationStats.rendererTargetCacheBytes, 0);
  assert.ok(ordinaryPresentationStats.filterApplications.every(value => value === 0));
  const frame = native.canvas.captureScene();
  const pixels = native.canvas.readPixels(frame.handle, 0, 0, 32, 32);
  console.log('[pmjs-uninstrumented-frame] ' + Buffer.from(pixels).toString('base64'));
  native.canvas.release(frame.handle);
  native.runtime.quit();
  process.exit(0);
}
assert.equal(ordinaryPresentationStats.diagnostics, true);
if (ordinaryPresentationStats.drawCalls !== 1 ||
    ordinaryPresentationStats.toneComposedPresentationFrames !== 0) {
  throw new Error('ordinary gameplay left the direct blit path: ' +
    JSON.stringify(ordinaryPresentationStats));
}

assert.equal(ordinaryPresentationStats.rendererTargetCreates, 1,
  'ordinary rendering should allocate only the scene target');
const withDiagnostics = native.canvas.captureScene();
assert.deepEqual(Buffer.from(native.canvas.readPixels(withDiagnostics.handle, 0, 0, 32, 32)), ordinaryPixels);
native.canvas.release(withDiagnostics.handle);

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
    stats.filterApplications.length !== 32 ||
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
    stats.rendererTargetDestroys !== 0 || stats.framebufferChecks !== 5) {
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
