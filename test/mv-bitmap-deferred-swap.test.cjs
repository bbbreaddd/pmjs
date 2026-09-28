'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function setup() {
  function Bitmap(url, ready = false) {
    this._url = url;
    this.ready = ready;
    this.width = ready ? 576 : 0;
    this.height = ready ? 768 : 0;
    this.listeners = [];
  }
  Bitmap.prototype.isReady = function() { return this.ready; };
  Bitmap.prototype.addLoadListener = function(fn) {
    if (this.ready) fn(this); else this.listeners.push(fn);
  };
  Bitmap.prototype.finish = function() {
    this.ready = true;
    this.width = 576;
    this.height = 768;
    this.listeners.splice(0).forEach(fn => fn(this));
  };
  function Sprite() {
    this._bitmap = null;
    this._frame = { x: 0, y: 0, width: 0, height: 0,
      clone() { return { ...this }; } };
    this.texture = { frame: { width: 0, height: 0 } };
  }
  Sprite.prototype.setFrame = function(x, y, width, height) {
    Object.assign(this._frame, { x, y, width, height });
    this._refresh();
  };
  Sprite.prototype._refresh = function() {
    this.texture.frame = { ...this._frame,
      width: Math.min(this._frame.width, this._bitmap?.width || 0),
      height: Math.min(this._frame.height, this._bitmap?.height || 0) };
  };
  Sprite.prototype._onBitmapLoad = function(bitmap) {
    if (bitmap === this._bitmap && this._refreshFrame) {
      this._refreshFrame = false;
      this._frame.width = bitmap.width;
      this._frame.height = bitmap.height;
    }
    this._refresh();
  };
  Object.defineProperty(Sprite.prototype, 'bitmap', {
    configurable: true,
    get() { return this._bitmap; },
    set(value) {
      if (this._bitmap !== value) {
        this._bitmap = value;
        if (value) {
          this._refreshFrame = true;
          value.addLoadListener(this._onBitmapLoad.bind(this));
        } else {
          this._refreshFrame = false;
          this.texture.frame = { width: 0, height: 0 };
        }
      }
    }
  });
  const context = vm.createContext({ Bitmap, Sprite, PMJS: { optimizations: { register() {}, isEnabled() { return false; } } },
    NativeHost: { runtime: { loadScript() {} } }, nativeBootPhase() {},
    Graphics: function() {}, Input: function() {} });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/pmjs-mv/bitmap.js'), 'utf8'), context);
  const old = new Bitmap('sheet.png', true);
  const sprite = new Sprite();
  sprite.bitmap = old;
  sprite.setFrame(0, 0, 48, 96);
  return { Bitmap, sprite, old };
}

test('same-sheet reload keeps pixels visible and swaps with the live animation frame', () => {
  const { Bitmap, sprite, old } = setup();
  const incoming = new Bitmap('sheet.png');
  sprite.bitmap = incoming;
  sprite.setFrame(192, 96, 48, 96);
  assert.equal(sprite.bitmap, old);
  assert.equal(sprite.texture.frame.width, 48);
  incoming.finish();
  assert.equal(sprite.bitmap, incoming);
  assert.deepEqual([sprite.texture.frame.x, sprite.texture.frame.y,
    sprite.texture.frame.width, sprite.texture.frame.height], [192, 96, 48, 96]);
});

test('superseding assignments and clears prevent stale reloads from taking over', () => {
  for (const replacement of ['other.png', 'sheet.png', null]) {
    const { Bitmap, sprite } = setup();
    const pending = new Bitmap('sheet.png');
    sprite.bitmap = pending;
    const next = replacement && new Bitmap(replacement, true);
    sprite.bitmap = next;
    pending.finish();
    assert.equal(sprite.bitmap, next);
    if (!next) assert.equal(sprite.texture.frame.width, 0);
  }
});

test('new files and first loads retain stock readiness behavior', () => {
  const { Bitmap, sprite } = setup();
  for (const clear of [false, true]) {
    if (clear) sprite.bitmap = null;
    const next = new Bitmap('other.png');
    sprite.bitmap = next;
    sprite.setFrame(0, 0, 48, 96);
    assert.equal(sprite.bitmap, next);
    assert.equal(sprite.texture.frame.width, 0);
    next.finish();
    assert.equal(sprite.texture.frame.width, 576);
  }
});

test('canvas-modified and unready predecessors are not held as identical pixels', () => {
  for (const mode of ['canvas', 'unready']) {
    const { Bitmap, sprite, old } = setup();
    if (mode === 'canvas') old.__canvas = {}; else old.ready = false;
    const next = new Bitmap('sheet.png');
    sprite.bitmap = next;
    assert.equal(sprite.bitmap, next);
  }
});
