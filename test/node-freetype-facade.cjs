'use strict';
process.env.PMJS_TEXT_BACKEND = 'freetype';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const native = require(path.resolve(process.argv[2]));
native.initialize({ gameRoot: path.resolve(process.argv[3]), assetRoot: '', width: 160, height: 80, windowTitle: 'FreeType facade quantization' });
const ctx = vm.createContext({ console, pmjsGameConfig: {},
  nativeWindowState: { focused: true, visible: true }, NativeHost: { canvas: native.canvas,
    runtime: { env: () => '', loadScript() {} } },
  PMJS: { config: { fonts: { GameFont: 'text-shaping.ttf' } }, optimizations: {
    register() {}, isEnabled() { return true; }, refuse() { throw new Error('Unexpected refusal'); }
  } }, nativeBootPhase() {}, Sprite: function() {}, Graphics: function() {}, Input: function() {},
});
const load = file => vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), ctx, { filename: file });
load('js/pmjs-web/events.js'); load('js/pmjs-web/canvas.js'); load('js/pmjs-web/elements.js');
function snapshot(canvas) {
  return Buffer.from(native.canvas.readPixels(canvas._ensureNativeCanvas().handle, 0, 0, 160, 80));
}
function canvas() { const value = new ctx.CanvasElement(); value.width = 160; value.height = 80; return value; }
for (const realized of [false, true]) for (const baseline of ['alphabetic', 'top', 'middle']) {
  const value = canvas(), drawing = value.getContext('2d');
  if (realized) snapshot(value);
  drawing.font = '24.75px GameFont'; drawing.lineWidth = 2.75; drawing.strokeStyle = '#ffffff';
  drawing.textBaseline = baseline; drawing.textAlign = 'center';
  assert.equal(drawing.measureText('AV ffi').width, native.canvas.measureText('text-shaping.ttf', 'AV ffi', 25));
  drawing.strokeText('AV ffi', 83.75, 30.6);
  const expected = native.canvas.create(160, 80);
  const measured = native.canvas.measureText('text-shaping.ttf', 'AV ffi', 25);
  const y = 30.6 + (baseline === 'top' ? 25 : baseline === 'middle' ? 12.5 : 0);
  native.canvas.drawText(expected.handle, 'text-shaping.ttf', 'AV ffi', Math.round(83.75 - measured / 2), Math.round(y), 25, 0xffffffff, 3);
  assert.deepEqual(snapshot(value), Buffer.from(native.canvas.readPixels(expected.handle, 0, 0, 160, 80)),
    'Ordinary Canvas preserves legacy font/position/stroke quantization: ' + baseline);
  value._releaseNativeCanvas(); native.canvas.release(expected.handle);
}
// Exercise the production MV shortcut, including its independently authored baseline.
vm.runInContext(`function Bitmap() { this._canvas = new CanvasElement(); this._canvas.width = 160; this._canvas.height = 80;
  this._context = this._canvas.getContext('2d'); this.fontSize = 24.75; this.outlineWidth = 2.75;
  this.outlineColor = '#ffffff'; this.textColor = '#336699'; }
Bitmap.prototype.drawText = function() { throw new Error('Unexpected stock fallback'); };
Bitmap.prototype._drawTextOutline = function() {}; Bitmap.prototype._drawTextBody = function() {};
Bitmap.prototype._makeFontNameText = function() { return this.fontSize + 'px GameFont'; };
Bitmap.prototype._setDirty = function() {};`, ctx);
load('js/pmjs-mv/bitmap.js');
const bitmap = new ctx.Bitmap(); bitmap.drawText('AV ffi', 3.75, 8.6, 0, 28.25);
const expected = native.canvas.create(160, 80), y = Math.round(8.6 + 28.25 - (28.25 - 24.75 * 0.7) / 2);
native.canvas.drawText(expected.handle, 'text-shaping.ttf', 'AV ffi', 4, y, 25, 0xffffffff, 3);
native.canvas.drawText(expected.handle, 'text-shaping.ttf', 'AV ffi', 4, y, 25, 0x336699ff, 0);
assert.deepEqual(snapshot(bitmap._canvas), Buffer.from(native.canvas.readPixels(expected.handle, 0, 0, 160, 80)),
  'MV shortcut preserves its previous effective rounding');
bitmap._canvas._releaseNativeCanvas(); native.canvas.release(expected.handle);
