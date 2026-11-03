'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const native = require(path.resolve(process.argv[2]));
native.initialize({ gameRoot: path.resolve(process.argv[3]), assetRoot: '',
  width: 816, height: 624, windowTitle: 'presentation scaling' });

function frame() {
  native.beginFrame();
  native.render.quad(0, 0, 816, 624, 0, 0, 1, 1);
  native.render.quad(0, 0, 816, 4, 1, 0, 0, 1);
  native.renderFrame();
}
function pixel(x, y) {
  const shot = native.canvas.captureDrawable();
  try { return Array.from(native.canvas.readPixels(shot.handle, x, y, 1, 1)); }
  finally { native.canvas.release(shot.handle); }
}
const menu = { title: 'Settings', question: 'Exit Settings?', yes: 'Yes', no: 'No',
  rows: [{ label: 'Scaling', value: 'Integer' }], footer: ['', ''], fonts: [] };

native.render.setPresentScaleMode('integer');
const integer = native.render.presentation();
assert.deepEqual([integer.drawableWidth, integer.drawableHeight], [640, 480]);
assert.deepEqual([integer.viewportWidth, integer.viewportHeight, integer.viewportX, integer.viewportY],
  [408, 312, 116, 84]);
frame();
assert.deepEqual(pixel(0, 0), [0, 0, 0, 255]);
assert.deepEqual(pixel(320, 240), [0, 0, 255, 255]);
const settings = native.runtime.settingsOverlay(menu);
assert.deepEqual([settings.width, settings.height], [640, 480]);
native.runtime.settingsPresent(true);
frame();
assert.deepEqual(pixel(0, 0), [9, 14, 23, 255], 'settings cover the display outside the integer viewport');
native.runtime.settingsPresent(false);

native.render.setPresentScaleMode('crop');
const crop = native.render.presentation();
assert.deepEqual([crop.viewportWidth, crop.viewportHeight, crop.viewportX, crop.viewportY], [640, 489, 0, -4]);
frame();
assert.deepEqual(pixel(320, 0), [0, 0, 255, 255], 'center crop removes the narrow top strip');
assert.deepEqual(pixel(320, 479), [0, 0, 255, 255]);

native.runtime.settingsOverlay({ ...menu, rows: [{ label: 'Scaling', value: 'Crop to fill' }] });
native.runtime.settingsPresent(true);
frame();
assert.deepEqual(pixel(0, 0), [9, 14, 23, 255], 'settings cover the full display despite cropping');
native.runtime.settingsPresent(false);
frame();
assert.deepEqual(pixel(320, 0), [0, 0, 255, 255]);

native.render.setScreenRenderSize(1280, 720);
const wideCrop = native.render.presentation();
assert.deepEqual([wideCrop.viewportWidth, wideCrop.viewportHeight, wideCrop.viewportX, wideCrop.viewportY],
  [853, 480, -106, 0]);
native.beginFrame();
native.render.quad(0, 0, 1280, 720, 0, 0, 1, 1);
native.render.quad(0, 0, 4, 720, 1, 0, 0, 1);
native.renderFrame();
assert.deepEqual(pixel(0, 240), [0, 0, 255, 255], 'center crop removes the narrow left strip');
const wideMenu = native.runtime.settingsOverlay(menu);
assert.deepEqual([wideMenu.width, wideMenu.height], [640, 480], 'settings use display geometry, not the game aspect ratio');
native.runtime.settingsPresent(false);
native.render.setScreenRenderSize(1281, 721);
native.render.setPresentScaleMode('integer');
const oddInteger = native.render.presentation();
assert.deepEqual([oddInteger.viewportWidth, oddInteger.viewportHeight], [427, 240]);
native.runtime.quit();
