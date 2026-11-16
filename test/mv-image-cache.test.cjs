'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture() {
  let now = 100000, timer;
  class Bitmap {}
  class ImageCache {}
  ImageCache.limit = 80000000;
  const cache = { _items: {}, _mustBeHeld: item => !!item.reservationId || !item.bitmap.ready };
  const context = { Bitmap, ImageCache, ImageManager: { _imageCache: cache },
    Date: { now: () => now },
    setInterval(fn, delay) { assert.equal(delay, 1000); timer = fn; },
    NativeHost: { runtime: { env: () => '' } },
    PMJS: { config: { imageCacheMaxPixels: 16777216 }, images: { onLoadComplete() {} }, methods: { wrap() {} } } };
  const source = fs.readFileSync(path.resolve(__dirname, '../js/pmjs-mv/images.js'), 'utf8');
  vm.runInNewContext(source.slice(0, source.indexOf('\nPMJS.methods.wrap({')), context);
  return { context, cache, advance(ms) { now += ms; timer(); } };
}

test('idle eviction drops cache ownership while preserving held, pending and recently accessed bitmaps', () => {
  const { context, cache, advance } = fixture();
  const retained = { ready: true, _image: { src: 'retained.png' }, width: 64, height: 64 };
  cache._items.old = { touch: 100000, bitmap: retained };
  cache._items.pending = { touch: 100000, bitmap: { ready: false } };
  cache._items.reserved = { touch: 100000, bitmap: { ready: true }, reservationId: 'scene' };
  cache._items.recent = { touch: 150000, bitmap: { ready: true } };
  advance(60000);
  assert.ok(cache._items.old);
  advance(1000);
  assert.deepEqual(Object.keys(cache._items).sort(), ['pending', 'recent', 'reserved']);
  assert.equal(retained._image.src, 'retained.png');
  assert.equal(retained.width, 64);
  assert.equal(context.PMJS.mv.imageCache.expired, 1);
  delete cache._items.reserved.reservationId;
  cache._items.pending.bitmap.ready = true;
  advance(1000);
  assert.deepEqual(Object.keys(cache._items), ['recent']);
});

test('idle eviction honors replacement caches and their custom hold contract', () => {
  const { context, advance } = fixture();
  const bitmap = { ready: true }, replacement = { _items: { custom: { touch: 1, bitmap } }, _mustBeHeld: () => true };
  context.ImageManager._imageCache = replacement;
  advance(61000);
  assert.equal(replacement._items.custom.bitmap, bitmap);
  context.ImageManager._imageCache = null;
  assert.doesNotThrow(() => advance(1000));
});
