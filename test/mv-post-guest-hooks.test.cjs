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
  ctx.PMJS.compat = { hit() {} };
  const source = fs.readFileSync(path.join(root, 'js/pmjs-mv/images.js'), 'utf8');
  vm.runInContext(slice(source, 'function pmjsBitmapRequestImageWrap',
    '\nPMJS.methods.wrap({'), ctx,
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
  const file = new Bitmap();
  file._image = previous;
  previous.destroyed = false;
  ctx.PMJS.mv.bitmap.requestImageFile.call(file, 'plain.png');
  assert.equal(file.requested, 1, 'file request retains the captured stock implementation');
  assert.equal(file.guestRequested, undefined);
  assert.equal(previous.destroyed, true, 'stock file request releases its replaced native image');
});

test('MV prepared cache hits preserve custom guest decryptors and completion', () => {
  let cached = true;
  let ctx;
  const decrypted = [];
  function NativeImage() { ctx.EventTarget.call(this); }
  function Bitmap() {}
  Bitmap.prototype._requestImage = function(url) {
    this._image = new NativeImage();
    this._url = url;
    this._loadingState = 'decrypting';
    ctx.Decrypter.decryptImg(url, this);
  };
  Bitmap.prototype._onLoad = function(event) {
    this._image.removeEventListener('load', this._loadListener);
    this._image.removeEventListener('error', this._errorListener);
    this.completed = (this.completed || 0) + 1;
    this.event = event;
  };
  const decrypter = { decryptImg() { throw new Error('stock decryptor used'); } };
  ctx = loadPmjsRuntime({ Bitmap, NativeImage, Decrypter: decrypter,
    NativeHost: { assets: { hasDecrypted(path) {
      assert.equal(path, 'img/pictures/a b.png');
      return cached;
    } } }
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'js/pmjs-web/events.js'), 'utf8'), ctx);
  NativeImage.prototype = Object.create(ctx.EventTarget.prototype);
  NativeImage.prototype.constructor = NativeImage;
  const source = fs.readFileSync(path.join(root, 'js/pmjs-mv/images.js'), 'utf8');
  vm.runInContext(slice(source, 'function pmjsBitmapRequestImageWrap',
    '\nPMJS.methods.wrap({'), ctx);
  decrypter.decryptImg = function(url, bitmap) {
    assert.equal(this, decrypter);
    decrypted.push([url, bitmap]);
    bitmap._image.src = 'blob:guest';
    bitmap._image.addEventListener('load', bitmap._loadListener = Bitmap.prototype._onLoad.bind(bitmap));
  };
  ctx.PMJS.methods.install();

  const url = 'file:///game/img/pictures/a%20b.png?version=1';
  const loaded = new Bitmap();
  loaded._requestImage(url);
  assert.equal(loaded._image.src, 'blob:guest');
  assert.equal(loaded._url, url);
  const event = { type: 'load' };
  loaded._image.dispatchEvent(event);
  assert.equal(loaded.completed, 1);
  assert.equal(loaded.event, event);
  assert.deepEqual(decrypted, [[url, loaded]]);
  assert.equal(loaded._image._listeners.load.length, 0);


  cached = false;
  const missing = new Bitmap();
  missing._requestImage(url);
  assert.deepEqual(decrypted[1], [url, missing]);
  assert.equal(missing._image.src, 'blob:guest');
});

for (const strict of [false, true]) {
  test('MV request completion preserves image cleanup in ' +
      (strict ? 'strict' : 'production') + ' compatibility mode', () => {
    const listeners = new Set(['load', 'error']);
    function NativeImage() { this.src = 'requested.png'; }
    NativeImage.prototype.removeEventListener = function(name) {
      listeners.delete(name);
    };
    function Bitmap() {}
    Bitmap._reuseImages = [];
    // MV's request-only completion contract returns the image to the pool.
    Bitmap.prototype._onLoad = function() {
      this._loadingState = 'requestCompleted';
      if (!this._decodeAfterRequest) this._clearImgInstance();
    };
    Bitmap.prototype._clearImgInstance = function() {
      this._image.removeEventListener('load', this._loadListener);
      this._image.removeEventListener('error', this._errorListener);
      Bitmap._reuseImages.push(this._image);
      this._image = null;
    };
    const ctx = loadPmjsRuntime({
      Bitmap, NativeImage,
      console: { log() {}, warn() {} },
      NativeHost: { runtime: {
        env: name => strict && name === 'PMJS_STRICT_COMPAT' ? '1' : '',
      } },
    });
    vm.runInContext(fs.readFileSync(path.join(root,
      'js/pmjs-core/compatibility.js'), 'utf8'), ctx);
    const source = fs.readFileSync(path.join(root, 'js/pmjs-mv/images.js'), 'utf8');
    vm.runInContext(slice(source, 'function pmjsBitmapRequestImageWrap',
      '\nPMJS.methods.wrap({'), ctx);
    ctx.PMJS.methods.install();

    const bitmap = new Bitmap();
    const image = bitmap._image = new NativeImage();
    bitmap._onLoad();
    assert.equal(bitmap._loadingState, 'requestCompleted');
    assert.equal(image.src, '');
    assert.equal(bitmap._image, null);
    assert.deepEqual(Bitmap._reuseImages, [image]);
    assert.equal(listeners.size, 0);
    assert.equal(ctx.PMJS.compat.count(), 0);
    if (strict) {
      assert.throws(() => ctx.PMJS.compat.hit('unsupported.test'),
        /unsupported native capability/);
    } else {
      ctx.PMJS.compat.hit('unsupported.test');
    }
    assert.equal(ctx.PMJS.compat.count(), 1);
  });
}

test('engine leaves guest WindowLayer initialize and filters untouched', () => {
  function WindowLayer() {}
  WindowLayer.prototype.initialize = function(value) {
    this.guestInit = value;
    this.filters = [{ guest: true }];
    return 'guest result';
  };
  WindowLayer.voidFilter = { void: true };
  const ctx = loadPmjsRuntime({
    WindowLayer,
    NativeHost: { runtime: { loadScript() {} } },
  });
  const source = fs.readFileSync(path.join(root, 'js/pmjs-mv/engine.js'), 'utf8');
  const guestInitialize = WindowLayer.prototype.initialize;
  vm.runInContext(source, ctx, { filename: 'engine.js' });
  ctx.PMJS.methods.install();

  const layer = new WindowLayer();
  layer._tempCanvas = {};
  layer._renderSprite = {};
  assert.equal(layer.initialize('plugin argument'), 'guest result');
  assert.equal(layer.guestInit, 'plugin argument');
  assert.ok(layer._tempCanvas);
  assert.ok(layer._renderSprite);
  assert.equal(WindowLayer.prototype.initialize, guestInitialize);
  assert.deepEqual(JSON.parse(JSON.stringify(layer.filters)),
    [{ guest: true }]);
});

test('trace _executeTint observes without replacing guest behavior', () => {
  function Sprite() {}
  Sprite.prototype._executeTint = function() { this.tinted = true; return 'guest'; };
  const events = [];
  const ctx = loadPmjsRuntime({
    Sprite,
    Graphics: {},
    Utils: { isOptionValid() { return false; } },
    PIXI: {},
    __pmjsTrace: {
      active: () => true,
      revision: () => ({ id: 1 }),
      id: () => 7,
      event: (kind, name) => events.push([kind, name]),
    },
  });
  const source = fs.readFileSync(path.join(root, 'js/pmjs-mv/renderer.js'), 'utf8');
  vm.runInContext(source, ctx, { filename: 'js/pmjs-mv/renderer.js' });
  ctx.PMJS.methods.install();

  const sprite = new Sprite();
  sprite._canvas = {};
  sprite._bitmap = { baseTexture: { source: {} } };
  assert.equal(sprite._executeTint(1, 2, 3, 4), 'guest');
  assert.equal(sprite.tinted, true);
  assert.deepEqual(events, [['tint', 'mv.cpu-tint-complete']]);
});

test('recognized MV decryptor uses prepared images and falls back on cache errors', () => {
  const { decryptImg } = require('./helpers/mv-reviewed-methods.cjs');
  const requests = [];
  function Bitmap() {}
  function NativeImage() { context.EventTarget.call(this); }
  Bitmap.prototype._onLoad = function() { this.completed = (this.completed || 0)+1; };
  Bitmap.prototype._onError = function() { this.failed = true; };
  const decrypter = { extToEncryptExt: url => url, decryptArrayBuffer: value => value,
    createBlobUrl: () => 'blob:ordinary', _xhrOk: 400 };
  const context = loadPmjsRuntime({ Bitmap, NativeImage, Decrypter: decrypter,
    NativeHost: { assets: { hasDecrypted: () => true } },
    XMLHttpRequest: function() { this.open = () => {}; this.send = () => requests.push(this); }
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'js/pmjs-web/events.js'), 'utf8'), context);
  NativeImage.prototype = Object.create(context.EventTarget.prototype);
  decrypter.decryptImg = vm.runInContext('('+decryptImg.toString()+')', context);
  vm.runInContext(slice(fs.readFileSync(path.join(root, 'js/pmjs-mv/images.js'), 'utf8'),
    'function pmjsBitmapRequestImageWrap', '\nPMJS.methods.wrap({'), context);
  context.PMJS.methods.install();
  const bitmap = new Bitmap(); bitmap._image = new NativeImage();
  decrypter.decryptImg('img/a.png', bitmap);
  assert.equal(bitmap._image.src, 'img/a.png');
  bitmap._image.dispatchEvent({ type: 'load' });
  assert.equal(bitmap.completed, 1);
  assert.equal(requests.length, 0);
  const failed = new Bitmap(); failed._image = new NativeImage();
  decrypter.decryptImg('img/a.png', failed);
  failed._image.dispatchEvent({ type: 'error' });
  assert.equal(requests.length, 1);
  requests[0].status = 200; requests[0].response = new ArrayBuffer(0); requests[0].onload();
  assert.equal(failed._image.src, 'blob:ordinary');
  failed._image.dispatchEvent({ type: 'load' });
  assert.equal(failed.completed, 1);
});
