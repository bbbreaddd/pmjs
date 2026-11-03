'use strict';

process.env.PMJS_GRAPHICS_DIAGNOSTICS = '1';

// Geometry test, one case per ctest registration via environment:
// PMJS_TEST_GAME, PMJS_WINDOW_SIZE, PMJS_PRESENT_SCALE,
// PMJS_TEST_EXPECT=vw,vh,vx,vy,filter,letterboxed (or "auto").
const path = require('node:path');
const assert = require('node:assert/strict');

const parseSize = (text) => {
  const match = /^(\d+)x(\d+)$/.exec(String(text || ''));
  assert(match, `bad size: ${text}`);
  return [Number(match[1]), Number(match[2])];
};

const [gameWidth, gameHeight] = parseSize(process.env.PMJS_TEST_GAME || '64x64');
const native = require(path.resolve(process.argv[2]));
native.initialize({
  gameRoot: path.resolve(process.argv[3]),
  assetRoot: '',
  width: gameWidth,
  height: gameHeight,
  windowTitle: 'pmjs presentation test',
});

native.beginFrame();
native.render.quad(0, 0, gameWidth, gameHeight, 1, 1, 1, 1);
native.renderFrame();

const p = native.render.presentation();
const stats = native.render.stats();
assert.equal(p.sourceWidth, gameWidth);
assert.equal(p.sourceHeight, gameHeight);

const expectation = String(process.env.PMJS_TEST_EXPECT || 'auto');
if (expectation === 'auto') {
  const dw = p.drawableWidth, dh = p.drawableHeight;
  assert(dw > 0 && dh > 0);
  let vw, vh;
  if (dw * gameHeight <= dh * gameWidth) {
    vw = dw;
    vh = Math.round((gameHeight * dw) / gameWidth);
  } else {
    vh = dh;
    vw = Math.round((gameWidth * dh) / gameHeight);
  }
  assert(Math.abs(p.viewportWidth - vw) <= 1);
  assert(Math.abs(p.viewportHeight - vh) <= 1);
  assert.equal(p.viewportX, Math.floor((dw - p.viewportWidth) / 2));
  assert.equal(p.viewportY, Math.floor((dh - p.viewportHeight) / 2));
  const integerMapping = p.viewportWidth % gameWidth === 0 &&
    p.viewportHeight % gameHeight === 0 &&
    p.viewportWidth / gameWidth === p.viewportHeight / gameHeight;
  assert.equal(p.filter, integerMapping ? 'nearest' : 'linear');
  assert.equal(p.letterboxed, true);
} else {
  const [vw, vh, vx, vy, filter, letterboxed] = expectation.split(',');
  assert.equal(p.viewportWidth, Number(vw));
  assert.equal(p.viewportHeight, Number(vh));
  assert.equal(p.viewportX, Number(vx));
  assert.equal(p.viewportY, Number(vy));
  assert.equal(p.filter, filter);
  assert.equal(p.letterboxed, letterboxed === '1');
}

const scaledFrames = stats.scaledPresentationFrames;
const letterboxedFrames = stats.presentationLetterboxedFrames;
const exact = p.viewportX === 0 && p.viewportY === 0 &&
  p.viewportWidth === p.drawableWidth &&
  p.viewportHeight === p.drawableHeight &&
  p.drawableWidth === gameWidth && p.drawableHeight === gameHeight;
assert.equal(scaledFrames, exact ? 0 : 1);
assert.equal(letterboxedFrames,
  p.viewportWidth < p.drawableWidth || p.viewportHeight < p.drawableHeight
    ? 1 : 0);
assert.equal(p.letterboxed, letterboxedFrames === 1);

native.render.setPresentScaleMode('stretch');
const stretched = native.render.presentation();
assert.equal(stretched.scale, 'stretch');
assert.equal(stretched.viewportWidth, stretched.drawableWidth);
assert.equal(stretched.viewportHeight, stretched.drawableHeight);
assert.equal(stretched.viewportX, 0);
assert.equal(stretched.viewportY, 0);
native.render.setPresentScaleMode('fit');
const fitted = native.render.presentation();
assert.equal(fitted.scale, 'fit');
assert(Math.abs(fitted.viewportWidth * gameHeight - fitted.viewportHeight * gameWidth) <= Math.max(gameWidth, gameHeight));
native.render.setPresentScaleMode('integer');
const integer = native.render.presentation();
assert.equal(integer.scale, 'integer');
if (gameWidth > integer.drawableWidth || gameHeight > integer.drawableHeight) {
  const divisor = Math.max(Math.ceil(gameWidth / integer.drawableWidth), Math.ceil(gameHeight / integer.drawableHeight));
  assert.equal(integer.viewportWidth, Math.max(1, Math.round(gameWidth / divisor)));
  assert.equal(integer.viewportHeight, Math.max(1, Math.round(gameHeight / divisor)));
}
native.render.setPresentScaleMode('crop');
const crop = native.render.presentation();
assert.equal(crop.scale, 'crop');
assert(crop.viewportWidth >= crop.drawableWidth && crop.viewportHeight >= crop.drawableHeight);
assert(Math.abs(crop.viewportWidth * gameHeight - crop.viewportHeight * gameWidth) <= Math.max(gameWidth, gameHeight));
assert(Math.abs(crop.viewportX * 2 + crop.viewportWidth - crop.drawableWidth) <= 1);
assert(Math.abs(crop.viewportY * 2 + crop.viewportHeight - crop.drawableHeight) <= 1);
native.render.setPresentScaleMode('default');
assert.equal(native.render.presentation().scale, process.env.PMJS_PRESENT_SCALE === 'integer' ? 'integer' : 'fit');

// Presenting must leave the scene framebuffer intact: clear it through an
// empty submit, present repeatedly, and verify black every time.
const schema = native.scene.schema;
for (let frame = 0; frame < 20; frame++) {
  native.beginFrame();
  native.scene.submit(schema.version, new Uint32Array(0), new Float32Array(0), 0);
  native.renderFrame();
  const capture = native.canvas.captureScene();
  const pixel = native.canvas.pixel(capture.handle, 0, 0);
  native.canvas.release(capture.handle);
  assert.equal(pixel >>> 8, 0, `scene corrupted after present on frame ${frame}`);
}
