'use strict';

process.env.PMJS_GRAPHICS_DIAGNOSTICS = '1';

const assert = require('node:assert/strict');
const path = require('node:path');
const native = require(path.resolve(process.argv[2]));

native.initialize({ gameRoot: path.resolve(process.argv[3]), assetRoot: '',
  width: 32, height: 24, windowTitle: 'pmjs render-to-canvas test' });

native.beginFrame();
native.render.quad(0, 0, 32, 24, 0, 1, 0, 1);
native.renderFrame();

const beforeSnapshot = native.render.stats();
native.beginFrame();
const fullSize = native.canvas.create(32, 24);
native.render.setRenderTargetSize(32, 24);
native.render.quad(0, 0, 32, 24, 1, 0, 0, 1);
native.render.renderToCanvas(fullSize.handle);
const fullPixel = native.canvas.pixel(fullSize.handle, 16, 12);
assert.ok((fullPixel >>> 24) > 240 && ((fullPixel >>> 16) & 255) < 15,
  `equal-size offscreen readback was wrong: ${fullPixel.toString(16)}`);
native.renderFrame();
const preserved = native.canvas.captureScene();
const preservedPixel = native.canvas.pixel(preserved.handle, 16, 12);
assert.ok(((preservedPixel >>> 16) & 255) > 240 &&
  (preservedPixel >>> 24) < 15,
  `equal-size offscreen render replaced the screen: ${preservedPixel.toString(16)}`);
native.canvas.release(preserved.handle);
native.canvas.release(fullSize.handle);
assert.equal(native.render.stats().rendererTargetCreates - beforeSnapshot.rendererTargetCreates, 1,
  'a plain snapshot should allocate only its offscreen surface');
assert.equal(native.render.stats().rendererTargetDestroys, beforeSnapshot.rendererTargetDestroys);
const beforeResize = native.render.stats();

native.beginFrame();
const target = native.canvas.create(8, 6);
native.render.setRenderTargetSize(8, 6);
native.render.quad(0, 0, 8, 3, 1, 0, 0, 1);
native.render.quad(0, 3, 8, 3, 0, 0, 1, 1);
native.render.renderToCanvas(target.handle);

const top = native.canvas.pixel(target.handle, 4, 1);
const bottom = native.canvas.pixel(target.handle, 4, 4);
assert.ok((top >>> 24) > 240 && ((top >>> 8) & 255) < 15,
  `offscreen top was not red: ${top.toString(16)}`);
assert.ok(((bottom >>> 8) & 255) > 240 && (bottom >>> 24) < 15,
  `offscreen bottom was not blue: ${bottom.toString(16)}`);

// A smaller snapshot preserves both the screen pixels and its allocation.
native.renderFrame();
const retained = native.canvas.captureScene();
assert.equal(native.canvas.pixel(retained.handle, 16, 12), preservedPixel,
  'different-size snapshot discarded the retained screen');
native.canvas.release(retained.handle);
const afterResize = native.render.stats();
assert.equal(afterResize.rendererTargetCreates - beforeResize.rendererTargetCreates, 1);
assert.equal(afterResize.rendererTargetDestroys - beforeResize.rendererTargetDestroys, 1);

native.beginFrame();
native.render.setRenderTargetSize(8, 6);
native.render.quad(0, 0, 8, 6, 0, 0, 1, 0.5);
native.render.renderToCanvas(target.handle);
assert.deepEqual(Array.from(native.canvas.readPixels(target.handle, 4, 3, 1, 1)),
  [0, 0, 255, 128], 'reused snapshot must clear old pixels and preserve alpha');
const reused = native.render.stats();
assert.equal(reused.rendererTargetCreates, afterResize.rendererTargetCreates);
assert.equal(reused.rendererTargetDestroys, afterResize.rendererTargetDestroys);

native.beginFrame();
native.render.setScreenRenderSize(16, 12);
native.render.quad(0, 0, 16, 12, 0, 1, 0, 1);
native.renderFrame();
const screen = native.canvas.captureScene();
const main = native.canvas.pixel(screen.handle, 8, 6);
assert.ok(((main >>> 16) & 255) > 240 && (main >>> 24) < 15,
  `screen render after offscreen readback was wrong: ${main.toString(16)}`);
native.canvas.release(screen.handle);

// A full render replaces the content while earlier Canvas draws retain their source.
const oldVersion = native.canvas.create(8, 6);
native.canvas.drawImage(oldVersion.handle, target.handle,
  0, 0, 8, 6, 0, 0, 8, 6, 1);
native.beginFrame();
native.render.setRenderTargetSize(8, 6);
native.render.quad(0, 0, 8, 6, 0, 1, 0, 1);
native.render.renderToCanvas(target.handle);
assert.deepEqual(Array.from(native.canvas.readPixels(target.handle, 4, 3, 1, 1)),
  [0, 255, 0, 255]);
assert.deepEqual(Array.from(native.canvas.readPixels(oldVersion.handle, 4, 3, 1, 1)),
  [0, 0, 255, 128]);
native.canvas.release(oldVersion.handle);
native.canvas.release(target.handle);

// Obsolete commands need no replay when a render replaces the entire Canvas.
const obsolete = native.canvas.create(8, 6);
native.canvas.drawText(obsolete.handle, 'fixture.png', 'invalid font',
  0, 12, 12, 0xffffffff);
native.beginFrame();
native.render.setRenderTargetSize(8, 6);
native.render.quad(0, 0, 8, 6, 1, 0, 0, 1);
native.render.renderToCanvas(obsolete.handle);
assert.equal(native.canvas.pixel(obsolete.handle, 4, 3), 0xff0000ff);
assert.equal(native.canvas.memory().deferredCommandCount, 0);
native.canvas.release(obsolete.handle);

assert.equal(native.render.stats().rendererTargetCreates - reused.rendererTargetCreates, 1,
  'screen resize should replace only the scene target');
assert.equal(native.render.stats().rendererTargetDestroys - reused.rendererTargetDestroys, 1);
