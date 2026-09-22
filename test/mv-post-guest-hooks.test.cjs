'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { loadPmjsRuntime } = require('./helpers/runtime-context.cjs');

const root = path.resolve(__dirname, '..');

function slice(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, 'slice markers not found: ' + start);
  return source.slice(from, to);
}

test('Bitmap image hooks wrap the final guest implementation', () => {
  const released = [];
  function NativeImage() {}
  function Bitmap() {}
  Bitmap.prototype._requestImage = function() {
    this.requested = (this.requested || 0) + 1;
    this._image = { fresh: true };
  };
  Bitmap.prototype._clearImgInstance = function() {
    this.cleared = (this.cleared || 0) + 1;
  };
  const ctx = loadPmjsRuntime({
    Bitmap, NativeImage,
    nativeCompatibilityHit() {},
  });
  const source = fs.readFileSync(path.join(root, 'js/pmjs-mv/images.js'), 'utf8');
  vm.runInContext(slice(source, 'function pmjsBitmapRequestImageWrap',
    '\n// MV removes an outgoing map spriteset'), ctx,
  { filename: 'images-hooks.js' });
  // Guest plugin overrides after the shared module registers.
  Bitmap.prototype._requestImage = function() {
    this.guestRequested = true;
    this._image = { fresh: true };
  };
  ctx.PMJS.methods.install();

  const bitmap = new Bitmap();
  const previous = new NativeImage();
  bitmap._image = previous;
  previous.destroyed = false;
  Object.defineProperty(previous, 'src', {
    configurable: true,
    get() { return this._src; },
    set(value) { this._src = value; if (value === '') this.destroyed = true; },
  });
  bitmap._requestImage();
  assert.equal(bitmap.guestRequested, true);
  assert.equal(previous.destroyed, true);

  const other = new Bitmap();
  other._image = { plain: true };
  other._clearImgInstance();
  assert.equal(other.cleared, 1);
});

test('WindowLayer initialize keeps guest behavior with native setup', () => {
  function WindowLayer() {}
  WindowLayer.prototype.initialize = function(value) {
    this.guestInit = value;
    return 'guest result';
  };
  WindowLayer.voidFilter = { void: true };
  const ctx = loadPmjsRuntime({
    WindowLayer,
    NativeHost: { runtime: { loadScript() {} } },
  });
  const source = fs.readFileSync(path.join(root, 'js/pmjs-mv/engine.js'), 'utf8');
  vm.runInContext(slice(source, 'function pmjsWindowLayerInitializeWrap',
    "\nNativeHost.runtime.loadScript('js/rpg_managers.js');"), ctx,
  { filename: 'engine-windowlayer.js' });
  ctx.PMJS.methods.install();

  const layer = new WindowLayer();
  layer._tempCanvas = {};
  layer._renderSprite = {};
  assert.equal(layer.initialize('plugin argument'), 'guest result');
  assert.equal(layer.guestInit, 'plugin argument');
  assert.equal(layer._tempCanvas, null);
  assert.equal(layer._renderSprite, null);
  assert.deepEqual(JSON.parse(JSON.stringify(layer.filters)), [{ void: true }]);
});

test('trace _executeTint observes without replacing guest behavior', () => {
  function Sprite() {}
  Sprite.prototype._executeTint = function() { this.tinted = true; return 'guest'; };
  const events = [];
  const ctx = loadPmjsRuntime({
    Sprite,
    __pmjsTrace: {
      active: () => true,
      revision: () => ({ id: 1 }),
      id: () => 7,
      event: (kind, name) => events.push([kind, name]),
    },
  });
  const source = fs.readFileSync(path.join(root, 'js/pmjs-mv/renderer.js'), 'utf8');
  vm.runInContext(slice(source, '// Capture provenance at the point MV',
    '\nif (typeof PMJS !== \'undefined\' && PMJS.optimizations &&'), ctx,
  { filename: 'renderer-tint.js' });
  ctx.PMJS.methods.install();

  const sprite = new Sprite();
  sprite._canvas = {};
  sprite._bitmap = { baseTexture: { source: {} } };
  assert.equal(sprite._executeTint(1, 2, 3, 4), 'guest');
  assert.equal(sprite.tinted, true);
  assert.deepEqual(events, [['tint', 'mv.cpu-tint-complete']]);
});
