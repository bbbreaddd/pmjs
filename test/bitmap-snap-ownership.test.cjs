'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { loadPmjsRuntime } = require('./helpers/runtime-context.cjs');

const rendererSource = fs.readFileSync(path.resolve(__dirname,
  '../js/pmjs-pixi4/renderer-facade.js'), 'utf8');

function loadBitmap(context) {
  return loadPmjsRuntime({
    ...context,
    Graphics: Object.assign(function Graphics() {}, context.Graphics),
    Sprite: function Sprite() {},
    Input: function Input() {},
    nativeBootPhase() {},
    NativeHost: { ...context.NativeHost, runtime: { env: () => '', loadScript() {} } },
  }, [
    'js/pmjs-core/config.js',
    'js/pmjs-core/optimizations.js',
    'js/pmjs-core/methods.js',
    'js/pmjs-rpgmaker/lifecycle.js',
    'js/pmjs-mv/bitmap.js',
  ]);
}

test('Bitmap.snap returns independent captures and a fresh blank for null', () => {
  let nextHandle = 0;
  let capture = 0;
  function Bitmap(width, height) {
    this.width = width;
    this.height = height;
    const resource = { handle: ++nextHandle };
    this._canvas = {
      width, height,
      capture: 0,
      _ensureNativeCanvas: () => resource,
      _pmjsContentChanged() {}
    };
  }
  Bitmap.prototype._setDirty = function() {};
  const context = loadBitmap({
    PMJS: {},
    PIXI: { WebGLRenderer: function() {} },
    Bitmap,
    Graphics: { width: 320, height: 240, _renderer: { roundPixels: false } },
    NativeHost: { render: {
      setRenderTargetSize() {},
      renderToCanvas(handle) { capture++; context.captures.set(handle, capture); }
    }, canvas: { blur() {} } },
    renderNativeStage() {},
    nativeIdentityTransform: {},
    captures: new Map()
  });
  vm.runInContext(rendererSource, context);
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

test('Pixi capture renders current authored state before readback and preserves its namespace', () => {
  const calls = [];
  const stage = { color: 'old' };
  const identity = {};
  const canvas = { width: 128, height: 96, _ensureNativeCanvas() {
    calls.push('canvas');
    return { handle: 77 };
  } };
  const pixi4 = { existingCapability() {} };
  const context = {
    PMJS: { pixi4 },
    PIXI: { WebGLRenderer: function() {} },
    nativeIdentityTransform: identity,
    NativeHost: { render: {
      setRenderTargetSize(width, height) { calls.push(['size', width, height]); },
      renderToCanvas(handle) { calls.push(['readback', handle]); },
    } },
    renderNativeStage(received, transform, alpha, roundPixels) {
      assert.equal(received, stage);
      assert.equal(transform, identity);
      calls.push(['render', received.color, alpha, roundPixels]);
    },
  };
  vm.runInNewContext(rendererSource, context);
  stage.color = 'updated-before-presentation';
  context.PMJS.pixi4.renderStageToCanvas(stage, canvas, true);
  assert.equal(context.PMJS.pixi4, pixi4);
  assert.deepEqual(calls, [
    ['size', 128, 96], ['render', 'updated-before-presentation', 1, true],
    'canvas', ['readback', 77],
  ]);
});

test('Bitmap snap delegates capture while preserving MV transform, blur, and dirty ordering', () => {
  const calls = [];
  const stage = { worldTransform: { identity() { calls.push('reset'); } } };
  function Bitmap(width, height) {
    this._canvas = { width, height, _ensureNativeCanvas() { return { handle: 88 }; },
      _pmjsContentChanged() { calls.push('changed'); } };
    calls.push('bitmap');
  }
  Bitmap.useBlur = true;
  Bitmap.prototype._setDirty = function() { calls.push('dirty'); };
  const context = loadBitmap({
    Bitmap,
    Graphics: { width: 64, height: 48, _renderer: { roundPixels: true } },
    PMJS: { web: { canvas: { blur(canvas) {
      assert.equal(canvas._ensureNativeCanvas().handle, 88);
      calls.push('blur');
      canvas._pmjsContentChanged();
    } } }, pixi4: { renderStageToCanvas(received, canvas, roundPixels) {
      assert.equal(received, stage);
      assert.equal(canvas.width, 64);
      assert.equal(canvas.height, 48);
      assert.equal(roundPixels, true);
      calls.push('capture');
    } } },
  });
  context.Bitmap.snap(stage);
  assert.deepEqual(calls, ['bitmap', 'capture', 'changed', 'reset', 'blur', 'changed', 'dirty']);
});
