'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const bitmapSource = fs.readFileSync(path.resolve(__dirname,
  '../js/pmjs-mv/bitmap.js'), 'utf8');
const snapStart = bitmapSource.indexOf('Bitmap.snap = function(stage) {');
const snapEnd = bitmapSource.indexOf('// Blur is delegated', snapStart);
const snapSource = bitmapSource.slice(snapStart, snapEnd);

test('Bitmap.snap returns independent captures and a fresh blank for null', () => {
  let nextHandle = 0;
  let capture = 0;
  function Bitmap(width, height) {
    this.width = width;
    this.height = height;
    const resource = { handle: ++nextHandle };
    this._canvas = {
      capture: 0,
      _ensureNativeCanvas: () => resource,
      _pmjsContentChanged() {}
    };
  }
  Bitmap.prototype._setDirty = function() {};
  const context = {
    Bitmap,
    Graphics: { width: 320, height: 240, _renderer: { roundPixels: false } },
    NativeHost: { render: {
      setRenderTargetSize() {},
      renderToCanvas(handle) { capture++; context.captures.set(handle, capture); }
    }, canvas: { blur() {} } },
    renderNativeStage() {},
    nativeIdentityTransform: {},
    pmjsBitmapCanvasChanged() {},
    captures: new Map()
  };
  vm.createContext(context);
  vm.runInContext(snapSource, context);
  const stage = { worldTransform: { identity() {} } };
  const first = context.Bitmap.snap(stage);
  const firstHandle = first._canvas._ensureNativeCanvas().handle;
  const second = context.Bitmap.snap(stage);
  const secondHandle = second._canvas._ensureNativeCanvas().handle;
  const blank = context.Bitmap.snap(null);
  assert.notEqual(first, second);
  assert.notEqual(blank, second);
  assert.notEqual(firstHandle, secondHandle);
  assert.equal(context.captures.get(firstHandle), 1);
  assert.equal(context.captures.get(secondHandle), 2);
  assert.equal(context.captures.has(blank._canvas._ensureNativeCanvas().handle), false);
});
