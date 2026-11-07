'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const { runModule } = require('./helpers/runtime-context.cjs');

function fixture(settings = {}) {
  class CanvasElement {
    constructor() { this.pixels = [10, 20, 30, 255]; }
    _releaseNativeCanvas() { throw new Error('GC must preserve canvas contents'); }
  }
  const removed = [];
  const manager = {
    _managedTextures: [],
    destroyTexture(texture) {
      removed.push(texture);
      this._managedTextures.splice(this._managedTextures.indexOf(texture), 1);
    }
  };
  const context = vm.createContext({ CanvasElement, PIXI: { settings, GC_MODES: { AUTO: 0, MANUAL: 1 } } });
  runModule(context, 'js/pmjs-pixi4/renderer-managers.js');
  const gc = new context.NativeTextureGarbageCollector({ textureManager: manager });
  function add(source = new CanvasElement()) {
    const texture = { source, touched: gc.count, destroy() { throw new Error('GC must not destroy game textures'); } };
    manager._managedTextures.push(texture);
    return texture;
  }
  function advance(ticks) { for (let i = 0; i < ticks; i++) gc.update(); }
  return { CanvasElement, gc, manager, removed, add, advance };
}

test('idle canvases expire sooner while image textures retain their existing idle policy', () => {
  const h = fixture({ GC_MAX_IDLE: 3600, GC_MAX_CHECK_COUNT: 600 });
  const canvas = h.add(), image = h.add({ complete: true });
  h.advance(120);
  assert.deepEqual(h.removed, []);
  h.advance(60);
  assert.deepEqual(h.removed, [canvas]);
  assert.deepEqual(h.manager._managedTextures, [image]);
  assert.deepEqual(canvas.source.pixels, [10, 20, 30, 255]);
  h.advance(3420);
  assert.deepEqual(h.removed, [canvas]);
  h.advance(60);
  assert.deepEqual(h.removed, [canvas, image]);
});

test('recently used canvases stay tracked while idle render textures lose cache ownership', () => {
  const h = fixture();
  const canvas = h.add(), target = h.add(); target._glRenderTargets = {};
  for (let i = 0; i < 20; i++) { canvas.touched = h.gc.count; h.advance(60); }
  assert.deepEqual(h.removed, [target]);
  assert.deepEqual(h.manager._managedTextures, [canvas]);
  h.advance(180);
  assert.deepEqual(h.removed, [target, canvas]);
  assert.deepEqual(h.manager._managedTextures, []);
  assert.deepEqual(target.source.pixels, [10, 20, 30, 255]);
});

test('manual mode suppresses automatic checks but explicit cleanup still expires only idle resources', () => {
  const h = fixture({ GC_MODE: 1 });
  const canvas = h.add(), image = h.add({});
  h.advance(180);
  assert.deepEqual(h.removed, []);
  h.gc.run();
  assert.deepEqual(h.removed, [canvas]);
  assert.deepEqual(h.manager._managedTextures, [image]);
});

test('cleanup honors more aggressive configured idle and check intervals', () => {
  const h = fixture({ GC_MAX_IDLE: 10, GC_MAX_CHECK_COUNT: 3 });
  const canvas = h.add(), image = h.add({});
  h.advance(9);
  assert.deepEqual(h.removed, []);
  h.advance(3);
  assert.deepEqual(h.removed, [canvas, image]);
});

test('a sweep visits all expired canvases while removal mutates the manager array', () => {
  const h = fixture();
  const canvases = Array.from({ length: 150 }, () => h.add());
  h.gc.count = 121;
  h.gc.run();
  assert.deepEqual(h.removed, canvases);
  assert.equal(h.manager._managedTextures.length, 0);
});
