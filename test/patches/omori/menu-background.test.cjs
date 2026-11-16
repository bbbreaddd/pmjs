'use strict';

const { runOptimizationAdapter } = require('../../helpers/runtime-context.cjs');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

function harness({ enabled = true, guestCache = false, emitter = true } = {}) {
  const phases = new Map();
  const events = [];
  const textureCache = {};
  function transform(node) {
    Object.assign(node, { alpha: 1, position: { x: 0, y: 0 }, scale: { x: 1, y: 1 },
      pivot: { x: 0, y: 0 }, skew: { x: 0, y: 0 }, rotation: 0, children: [] });
  }
  function BlurFilter() {
    Object.assign(this, { blurX: 1, blurY: 1, quality: 4, padding: 0,
      resolution: 1, blendMode: 0, enabled: true, autoFit: true,
      blurXFilter: {}, blurYFilter: { quality: 4 } });
  }
  function bitmap() {
    const canvas = { width: 640, height: 480, __pmjsContentRevision: 0 };
    return { width: 640, height: 480, __canvas: canvas, isReady: () => true,
      baseTexture: { source: canvas, _updateID: 0, scaleMode: 0, wrapMode: 0, resolution: 1 } };
  }
  function Sprite(source) {
    transform(this);
    Object.assign(this, { bitmap: source, anchor: { x: 0, y: 0 }, blendMode: 0,
      tint: 0xffffff, pluginName: 'sprite', _colorTone: [0, 0, 0, 0], _blendColor: [0, 0, 0, 0],
      texture: { baseTexture: source.baseTexture, frame: { x: 0, y: 0, width: 640, height: 480 },
        orig: { width: 640, height: 480 }, _updateID: 0 },
      blur: new BlurFilter(), cacheAsBitmap: false });
    this.filters = [this.blur];
    delete this.cacheAsBitmap;
  }
  function cachedRenderWebGL() {}
  Object.defineProperty(Sprite.prototype, 'cacheAsBitmap', {
    get() { return !!this._cacheAsBitmap; },
    set(value) {
      if (value === this._cacheAsBitmap) return;
      this._cacheAsBitmap = value;
      if (value) {
        this._cacheData = { sprite: null, originalRenderWebGL: this.renderWebGL };
        this.renderWebGL = cachedRenderWebGL;
      } else {
        this.renderWebGL = this._cacheData?.originalRenderWebGL;
        if (this._cacheData?.sprite) {
          events.push('release');
          this._cacheData.sprite = null;
        }
      }
    }
  });
  function Scene_Menu() { transform(this); }
  function Scene_OmoMenuBase() { transform(this); }
  const source = bitmap();
  for (const Scene of [Scene_Menu, Scene_OmoMenuBase]) {
    Scene.prototype.createBackground = function() {
      events.push('guest create');
      const sprite = this._backgroundSprite = new Sprite(source);
      sprite.cacheAsBitmap = guestCache;
      sprite.parent = this;
      this.children.push(sprite);
      return 'created';
    };
    Scene.prototype.terminate = function() {
      events.push('guest terminate');
      for (const child of this.children) child.parent = null;
      this.children.length = 0;
      if (this.error) throw this.error;
      return 'terminated';
    };
  }
  const renderer = { width: 640, height: 480, resolution: 1,
    emit: emitter ? function() { if (this.listener) this.listener(); } : undefined,
    render(stage, target) {
      for (const child of stage.children || []) {
        if (child.cacheAsBitmap && !child._cacheData.sprite) {
          if (this.failure) {
            child._cacheData.textureCacheId = 'unfinished';
            textureCache.unfinished = { destroy() { delete textureCache.unfinished; events.push('release unfinished'); } };
            throw this.failure;
          }
          events.push('build');
          child._cacheData.sprite = { source: child.bitmap, revision: child.bitmap.__canvas.__pmjsContentRevision };
        }
      }
      this.stage = stage;
      this.renderingToScreen = !target;
      if (this.emit) this.emit('prerender');
      events.push('render');
      return 'rendered';
    }, generateTextureGpu() { events.push('gpu capture'); return 'texture'; } };
  const context = { Sprite, Scene_Menu, Scene_OmoMenuBase, Graphics: { width: 640, height: 480, _renderer: renderer },
    PIXI: { filters: { BlurFilter }, BLEND_MODES: { NORMAL: 0 }, utils: { TextureCache: textureCache } },
    pmjsPixiRenderPreflight: { unsupportedMethod(sprite) { return sprite.customRender ? '_renderWebGL' : null; } },
    PMJS: { plugins: { registerOptimization(name, definition) { assert.equal(name, 'GTP_OmoriFixes'); assert.equal(definition.id, 'port.omori.menu-background-cache'); } },
      optimizations: { isEnabled: () => enabled }, phases: { on(name, id, callback) { phases.set(name, callback); } },
      pixi4: { renderStageToCanvas() { events.push('canvas capture'); return 'canvas'; } } } };
  runOptimizationAdapter(fs.readFileSync(require.resolve('../../../patches/omori/menu-background.js'), 'utf8'), context);
  phases.get('afterGuestPlugins')();
  return { ...context, renderer, source, bitmap, events };
}

for (const kind of ['Scene_Menu', 'Scene_OmoMenuBase']) {
  test(`${kind} retains the guest background and builds once until its source changes`, () => {
    const h = harness(), scene = new h[kind]();
    assert.equal(scene.createBackground(), 'created');
    const sprite = scene._backgroundSprite, filter = sprite.blur, texture = sprite.texture;
    h.renderer.render(scene);
    h.renderer.render(scene);
    assert.equal(h.events.filter(event => event === 'build').length, 1);
    h.source.__canvas.__pmjsContentRevision++;
    h.renderer.render(scene);
    assert.equal(sprite._cacheData.sprite.revision, 1);
    const replacement = h.bitmap();
    sprite.bitmap = replacement;
    sprite.texture.baseTexture = replacement.baseTexture;
    h.renderer.render(scene);
    assert.equal(sprite._cacheData.sprite.source, replacement);
    assert.equal(sprite.texture, texture);
    assert.equal(sprite.blur, filter);
    assert.equal(sprite.filters[0], filter);
    assert.equal(h.events.filter(event => event === 'build').length, 3);
    assert.equal(scene.terminate(), 'terminated');
    assert.equal(sprite.cacheAsBitmap, false);
    assert.equal(sprite.bitmap, replacement);
    scene.children.push(sprite);
    sprite.parent = scene;
    h.renderer.render(scene);
    assert.equal(sprite.cacheAsBitmap, false, 'retained sprite uses its original rendering');
  });
}

const changes = {
  opacity(h, scene, sprite) { sprite.alpha = 0.5; },
  parentOpacity(h, scene) { scene.alpha = 0.5; },
  geometry(h, scene, sprite) { sprite.scale.x = 2; },
  size(h) { h.renderer.width = 320; },
  frame(h, scene, sprite) { sprite.texture.frame.width = 100; },
  tint(h, scene, sprite) { sprite.tint = 0xff0000; },
  blurY(h, scene, sprite) { sprite.blur.blurY = 3; },
  quality(h, scene, sprite) { sprite.blur.blurYFilter.quality = 1; },
  padding(h, scene, sprite) { sprite.blur.padding = 6; },
  filterDisabled(h, scene, sprite) { sprite.blur.enabled = false; },
  filters(h, scene, sprite) { sprite.filters.push(new h.PIXI.filters.BlurFilter()); },
  mask(h, scene, sprite) { sprite.mask = {}; },
  children(h, scene, sprite) { sprite.children.push({}); }
};
for (const [name, change] of Object.entries(changes)) {
  test(`${name} leaves the cached domain and renders live`, () => {
    const h = harness(), scene = new h.Scene_Menu();
    scene.createBackground();
    h.renderer.render(scene);
    change(h, scene, scene._backgroundSprite);
    assert.equal(h.renderer.render(scene), 'rendered');
    assert.equal(scene._backgroundSprite.cacheAsBitmap, false);
    assert.equal(h.events.filter(event => event === 'build').length, 1);
  });
}

test('offscreen paths discard the adapter cache and a later screen frame rebuilds it', () => {
  const h = harness(), scene = new h.Scene_Menu();
  scene.createBackground();
  for (const capture of [() => h.renderer.render(scene, {}),
    () => h.renderer.generateTextureGpu(scene), () => h.PMJS.pixi4.renderStageToCanvas(scene, {})]) {
    h.renderer.render(scene);
    assert.ok(scene._backgroundSprite.cacheAsBitmap);
    capture();
    assert.equal(scene._backgroundSprite.cacheAsBitmap, false);
  }
});

test('guest caches, renderer overrides and disabled optimization remain guest-owned', () => {
  for (const options of [{ enabled: false }, { guestCache: true }, {}]) {
    const h = harness(options), scene = new h.Scene_Menu();
    scene.createBackground();
    if (!Object.keys(options).length) scene._backgroundSprite.customRender = true;
    h.renderer.render(scene);
    scene.terminate();
    assert.equal(h.events.includes('release'), false);
    assert.equal(scene._backgroundSprite.cacheAsBitmap, !!options.guestCache);
  }
});

test('replacing a realized cache hands ownership back to the guest', () => {
  const h = harness(), scene = new h.Scene_Menu();
  scene.createBackground();
  h.renderer.render(scene);
  const sprite = scene._backgroundSprite;
  sprite.cacheAsBitmap = false;
  sprite.cacheAsBitmap = true;
  h.renderer.render(scene);
  const guestSnapshot = sprite._cacheData.sprite;
  scene.terminate();
  assert.equal(sprite.cacheAsBitmap, true);
  assert.equal(sprite._cacheData.sprite, guestSnapshot);
});

test('a later render hook override discards the cache and stays observable', () => {
  const h = harness(), scene = new h.Scene_Menu();
  scene.createBackground();
  h.renderer.render(scene);
  const sprite = scene._backgroundSprite;
  sprite._renderWebGL = function() {};
  sprite.customRender = true;
  h.renderer.render(scene);
  assert.equal(sprite.cacheAsBitmap, false);
  assert.equal(h.events.filter(event => event === 'build').length, 1);
});

test('restoring original rendering preserves a guest replacement of the cache entry point', () => {
  for (const terminate of [false, true]) {
    const h = harness(), scene = new h.Scene_Menu();
    scene.createBackground();
    h.renderer.render(scene);
    const sprite = scene._backgroundSprite;
    const override = sprite.renderWebGL = function() {};
    sprite.customRender = true;
    if (terminate) scene.terminate();
    else h.renderer.render(scene);
    assert.equal(sprite.cacheAsBitmap, false);
    assert.equal(sprite.renderWebGL, override);
  }
});

test('termination exceptions still release only the adapter cache and preserve the error', () => {
  const h = harness(), scene = new h.Scene_Menu();
  scene.createBackground();
  h.renderer.render(scene);
  scene.error = new Error('guest failure');
  assert.throws(() => scene.terminate(), error => error === scene.error);
  assert.equal(scene._backgroundSprite.cacheAsBitmap, false);
  assert.equal(scene._backgroundSprite.bitmap, h.source);
});

test('a prerender listener can change the bitmap after cache preparation', () => {
  const h = harness(), scene = new h.Scene_Menu();
  scene.createBackground();
  h.renderer.render(scene);
  h.renderer.listener = () => h.source.__canvas.__pmjsContentRevision++;
  h.renderer.render(scene);
  assert.equal(scene._backgroundSprite.cacheAsBitmap, false);
  h.renderer.listener = null;
  h.renderer.render(scene);
  assert.equal(scene._backgroundSprite._cacheData.sprite.revision, 1);
});

test('a failed capture releases its unfinished target and preserves the renderer error', () => {
  const h = harness(), scene = new h.Scene_Menu();
  scene.createBackground();
  h.renderer.failure = new Error('capture failure');
  assert.throws(() => h.renderer.render(scene), error => error === h.renderer.failure);
  assert.equal(scene._backgroundSprite.cacheAsBitmap, false);
  assert.equal(scene._backgroundSprite.bitmap, h.source);
  assert.deepEqual(Object.keys(h.PIXI.utils.TextureCache), []);
  h.renderer.failure = null;
  h.renderer.render(scene);
  assert.ok(scene._backgroundSprite.cacheAsBitmap);
});

test('renderers without an event emitter cache normally', () => {
  const h = harness({ emitter: false }), scene = new h.Scene_Menu();
  scene.createBackground();
  h.renderer.render(scene);
  h.renderer.render(scene);
  assert.equal(h.events.filter(event => event === 'build').length, 1);
  assert.equal(h.renderer.emit, undefined);
  scene.terminate();
  assert.equal(scene._backgroundSprite.cacheAsBitmap, false);
});

test('a submenu with its own terminate method still releases the adapter cache', () => {
  const h = harness();
  class Submenu extends h.Scene_OmoMenuBase {
    terminate() { return 'submenu terminated'; }
  }
  const scene = new Submenu();
  scene.createBackground();
  h.renderer.render(scene);
  assert.equal(scene.terminate(), 'submenu terminated');
  assert.equal(scene._backgroundSprite.cacheAsBitmap, false);
});
