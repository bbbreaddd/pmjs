'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const native = require(path.resolve(process.argv[2]));

native.initialize({ gameRoot: path.resolve(process.argv[3]), assetRoot: '',
  width: 32, height: 24, windowTitle: 'pmjs render-to-canvas test' });

native.beginFrame();
native.render.quad(0, 0, 32, 24, 0, 1, 0, 1);
native.renderFrame();

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

native.beginFrame();
native.render.setScreenRenderSize(32, 24);
native.render.quad(0, 0, 32, 24, 0, 1, 0, 1);
native.renderFrame();
const screen = native.canvas.captureScene();
const main = native.canvas.pixel(screen.handle, 16, 12);
assert.ok(((main >>> 16) & 255) > 240 && (main >>> 24) < 15,
  `screen render after offscreen readback was wrong: ${main.toString(16)}`);
native.canvas.release(screen.handle);
native.canvas.release(target.handle);

