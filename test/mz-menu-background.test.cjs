'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createMzContext, runModule } = require('./helpers/mz-context.cjs');

function harness(enabled = true) {
  const f = createMzContext(), c = f.context;
  const program = {};
  class BlurPass { apply() {} }
  class BlurFilter {
    constructor() {
      Object.assign(this, { blur: 8, blurX: 8, blurY: 8, quality: 4,
        padding: 16, resolution: 1, enabled: true, blendMode: 0 });
      this.blurXFilter = new BlurPass(); this.blurYFilter = new BlurPass();
      for (const pass of [this.blurXFilter, this.blurYFilter]) {
        Object.assign(pass, { program, quality: 4 });
      }
    }
    apply() {}
  }
  Object.assign(c.PIXI, { filters: { BlurFilter }, BLEND_MODES: { NORMAL: 0 },
    WRAP_MODES: { CLAMP: 33071, REPEAT: 10497 } });
  c.PMJS.config = {};
  runModule(c, 'js/pmjs-core/optimizations.js');
  c.Sprite = c.PIXI.Sprite;
  c.Scene_MenuBase = class extends c.PIXI.Container {};
  runModule(c, 'js/pmjs-pixi5/filters.js');
  runModule(c, 'js/pmjs-mz/menu-background.js');
  if (!enabled) c.PMJS.optimizations.isEnabled = () => false;
  f.created = []; f.released = [];
  c.NativeHost.render.renderToImage = (width, height, options) => {
    const image = { handle: 1000 + f.created.length, width, height };
    f.created.push({ image, options }); return image;
  };
  c.NativeHost.images.release = handle => f.released.push(handle);
  f.renderer = new c.PIXI.Renderer({ width: 64, height: 64 });
  const scene = f.scene = new c.Scene_MenuBase();
  const sprite = f.background = f.sprite(123, 0, 0, 64, 64);
  scene.addChild(sprite); scene._backgroundSprite = sprite;
  function geometry(node) {
    Object.assign(node, { x: 0, y: 0, rotation: 0, scale: { x: 1, y: 1 },
      pivot: { x: 0, y: 0 }, skew: { x: 0, y: 0 } });
  }
  geometry(scene); geometry(sprite); sprite.anchor = { x: 0, y: 0 };
  sprite.alpha = 192 / 255;
  sprite.bitmap = { width: 64, height: 64, isReady() { return true; } };
  sprite.filters = [new BlurFilter()];
  Object.assign(sprite.texture.baseTexture, { wrapMode: 33071, scaleMode: 0,
    _updateID: 1 });
  sprite.texture.baseTexture.resource.source.__pmjsContentRevision = 1;
  f.draw = (target, transform) => {
    f.renderer.render(scene, target, true, transform);
    return f.submissions.at(-1);
  };
  f.filters = packet => Array.from({ length: packet.count }, (_, i) => packet.metadata[i * 7])
    .filter(kind => kind === 6).length;
  return f;
}

test('MZ caches one premultiplied full-screen image while preserving authored objects', () => {
  const f = harness(), b = f.background;
  const bitmap = b.bitmap, texture = b.texture, filters = b.filters;
  const first = f.draw();
  assert.equal(f.created.length, 1);
  assert.equal(f.created[0].options.alphaMode, 'premultiplied');
  assert.equal(f.filters(first), 0);
  const second = f.draw();
  assert.equal(f.created.length, 1);
  assert.deepEqual(second.metadata, first.metadata);
  const index = Array.from({ length: second.count }, (_, i) => i)
    .find(i => second.metadata[i * 7 + 2] === f.created[0].image.handle);
  assert.equal(second.values[index * 41 + 6], 1, 'source opacity is already in cached texels');
  assert.equal(b.bitmap, bitmap); assert.equal(b.texture, texture); assert.equal(b.filters, filters);
  assert.equal(b.alpha, 192 / 255); assert.equal(b.cacheAsBitmap, undefined);
});

test('MZ cache rebuilds after pixels, opacity, filter and texture changes', () => {
  const f = harness(); f.draw();
  const b = f.background;
  for (const mutate of [
    () => b.texture.baseTexture.resource.source.__pmjsContentRevision++,
    () => { b.alpha = 0.5; },
    () => { b.filters[0].blur = b.filters[0].blurX = b.filters[0].blurY = 3; b.filters[0].padding = 6; },
    () => { b.texture._updateID = 5; },
    () => { b.bitmap = { ...b.bitmap }; },
  ]) {
    const before = f.created.length; mutate(); f.draw(); f.draw();
    assert.equal(f.created.length, before + 1);
    assert.equal(f.released.length, f.created.length - 1);
  }
});

test('MZ backgrounds with children, transforms, masks or custom sampling use ordinary rendering', () => {
  for (const mutate of [
    f => { f.background.x = 1; },
    f => { f.scene.alpha = 0.5; },
    f => { f.background.addChild(f.sprite(124, 1, 2, 4, 4)); },
    f => { f.background.filterArea = { x: 0, y: 0, width: 40, height: 40 }; },
    f => { f.background.texture.rotate = 2; },
    f => { f.background.texture.frame.width = f.background.texture.orig.width = 32; },
    f => { f.background.texture.baseTexture.wrapMode = 10497; },
  ]) {
    const f = harness(); f.draw(); mutate(f); const packet = f.draw();
    assert.equal(f.created.length, 1);
    assert.equal(f.released.length, 1);
    assert.equal(f.filters(packet), 1);
  }
});

test('MZ custom rendering errors remain visible and discard the cache', () => {
  const f = harness(); f.draw();
  f.background.render = function() {};
  assert.throws(() => f.draw(), /render.render-method/);
  assert.equal(f.released.length, 1);
});

test('hidden MZ snapshots cannot cache an empty render and reappear stale', () => {
  for (const property of ['visible', 'renderable']) {
    const f = harness();
    f.background[property] = false; f.draw(); assert.equal(f.created.length, 0);
    f.background[property] = true; f.draw(); assert.equal(f.created.length, 1);
    f.background[property] = false; f.draw(); assert.deepEqual(f.released, [1000]);
    f.background[property] = true; f.draw(); assert.equal(f.created.length, 2);
  }
});

test('MZ offscreen rendering bypasses preparation without consuming a warm cache', () => {
  const f = harness(); f.draw();
  f.draw(null, { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 });
  assert.equal(f.filters(f.submissions.at(-1)), 1);
  f.draw(); assert.equal(f.created.length, 1);
  assert.equal(f.filters(f.submissions.at(-1)), 0);
});

test('MZ scene return and renderer destruction release only derived resources', () => {
  const f = harness(); f.draw();
  const bitmap = f.background.bitmap;
  f.renderer.render(new f.context.PIXI.Container());
  assert.deepEqual(f.released, [1000]);
  f.draw(); assert.equal(f.created.length, 2);
  f.renderer.destroy(); assert.deepEqual(f.released, [1000, 1001]);
  assert.equal(f.background.bitmap, bitmap);
  assert.equal(bitmap.isReady(), true);
});

test('MZ snapshot allocation failure restores ordinary rendering and releases stale cache', () => {
  const f = harness();
  f.draw();
  f.background.texture.baseTexture.resource.source.__pmjsContentRevision++;
  const bitmap = f.background.bitmap, filters = f.background.filters;
  const capture = f.context.NativeHost.render.renderToImage;
  const failure = Object.assign(new Error('allocation failed'), { code: 'PMJS_RENDER_IMAGE_ALLOCATION' });
  f.context.NativeHost.render.renderToImage = () => { throw failure; };
  assert.equal(f.filters(f.draw()), 1);
  assert.equal(f.filters(f.draw()), 1);
  assert.deepEqual(f.released, [1000]);
  assert.deepEqual(f.sizes.at(-1), [64, 64]);
  assert.equal(f.background.bitmap, bitmap);
  assert.equal(f.background.filters, filters);
  f.context.NativeHost.render.renderToImage = capture;
  assert.equal(f.filters(f.draw()), 0);
  assert.equal(f.created.length, 2);
  f.renderer.destroy();
  assert.deepEqual(f.released, [1000, 1001]);
});

test('MZ unrelated snapshot errors remain visible after restoring screen size', () => {
  const f = harness(), failure = new Error('capture failure');
  f.context.NativeHost.render.renderToImage = () => { throw failure; };
  assert.throws(() => f.draw(), error => error === failure);
  assert.deepEqual(f.sizes.at(-1), [64, 64]);
  assert.deepEqual(f.created, []);
  assert.deepEqual(f.released, []);
});

test('disabled MZ preparation keeps the original blur and allocates no image', () => {
  const f = harness(false); assert.equal(f.filters(f.draw()), 1);
  assert.deepEqual(f.created, []); assert.deepEqual(f.released, []);
});
