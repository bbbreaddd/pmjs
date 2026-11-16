'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { makeHarness } = require('./helpers/scene-encoder-harness.cjs');
const { runModule } = require('./helpers/runtime-context.cjs');

function createRenderers(count = 1, configure) {
  const { sandbox: context } = makeHarness();
  context.PIXI.RENDERER_TYPE = { WEBGL: 1 };
  context.PIXI.Texture.EMPTY = { baseTexture: {} };
  context.PIXI.Matrix = class {
    identity() {
      this.a = this.d = 1;
      this.b = this.c = this.tx = this.ty = 0;
      return this;
    }
  };
  context.PIXI.WebGLRenderer = class {};
  context.NativeHost.render.setScreenRenderSize = () => {};
  context.NativeHost.render.setClearColor = () => {};
  context.NativeHost.render.setRenderTargetSize = () => {};
  for (const name of ['renderer-managers', 'renderer-facade']) {
    runModule(context, 'js/pmjs-pixi4/' + name + '.js');
  }
  if (configure) configure(context);
  return Array.from({ length: count }, () => context.createNativePixiRenderer({
    width: 32, height: 24, view: { style: {} },
  }));
}

function createBaseTexture() {
  return Object.assign(new EventEmitter(), {
    width: 8, height: 8, resolution: 1,
    source: { _nativeImage: { handle: 42 } },
  });
}

test('repeated texture binds register once without scanning managed textures', () => {
  const [renderer] = createRenderers();
  const manager = renderer.textureManager;
  const textures = manager.managedTextures;
  const first = createBaseTexture(), second = createBaseTexture();
  const indexOf = textures.indexOf;
  textures.indexOf = () => { throw new Error('registration scanned managed textures'); };
  for (let index = 0; index < 2000; index++) renderer.bindTexture(first);
  renderer.bindTexture(second);
  renderer.bindTexture(first);
  textures.indexOf = indexOf;
  assert.equal(manager.managedTextures, textures);
  assert.deepEqual(Array.from(textures), [first, second]);
  assert.equal(first.listenerCount('dispose'), 1);
  assert.equal(second.listenerCount('dispose'), 1);
  renderer.destroy();
});

test('texture disposal removes bindings and preserves order when re-tracked', () => {
  const [renderer] = createRenderers();
  const manager = renderer.textureManager;
  const textures = manager.managedTextures;
  const first = createBaseTexture(), middle = createBaseTexture(), last = createBaseTexture();
  for (const base of [first, middle, last]) renderer.bindTexture(base);
  const oldBacking = middle._glTextures[renderer.CONTEXT_UID];
  const staleDispose = middle.listeners('dispose')[0];
  middle.emit('dispose');
  assert.equal(oldBacking.texture, null);
  assert.equal(middle._glTextures[renderer.CONTEXT_UID], undefined);
  assert.equal(renderer.boundTextures.includes(middle), false);
  assert.equal(middle.listenerCount('dispose'), 0);
  assert.deepEqual(Array.from(textures), [first, last]);

  renderer.bindTexture(middle);
  const newBacking = middle._glTextures[renderer.CONTEXT_UID];
  staleDispose();
  assert.equal(middle._glTextures[renderer.CONTEXT_UID], newBacking);
  assert.deepEqual(Array.from(textures), [first, last, middle]);
  assert.equal(middle.listenerCount('dispose'), 1);
  manager.destroyTexture({ baseTexture: middle });
  manager.destroyTexture(middle);
  renderer.bindTexture(middle);
  assert.deepEqual(Array.from(textures), [first, last, middle]);
  assert.equal(middle.listenerCount('dispose'), 1);
  renderer.destroy();
});

test('reusing a bound texture refreshes its age and backing before automatic collection', () => {
  const [renderer] = createRenderers();
  const base = createBaseTexture();
  const location = renderer.bindTexture(base);
  const backing = base._glTextures[renderer.CONTEXT_UID];
  renderer.textureGC.maxIdle = 1;
  renderer.textureGC.checkCountMax = 0;
  for (let frame = 0; frame < 8; frame++) {
    renderer.textureGC.update();
    base.source = { _nativeImage: { handle: 43 + frame } };
    assert.equal(renderer.bindTexture(base), location);
    assert.equal(base.touched, renderer.textureGC.count);
    assert.equal(backing.touched, renderer.textureGC.count);
    assert.equal(backing.texture.handle, 43 + frame);
    assert.equal(base._glTextures[renderer.CONTEXT_UID], backing);
  }
  renderer.destroy();
});

test('idle render textures preserve shared canvas contents and can be rebound after cache eviction', () => {
  const [renderer] = createRenderers();
  const base = createBaseTexture();
  const pixels = Uint8Array.from([20, 40, 60, 255]);
  const source = { _nativeCanvas: { handle: 43 }, pixels };
  const target = { destroy() { assert.fail('cache eviction must not destroy the render target'); } };
  base.source = base.__pmjsRenderCanvas = source;
  base._glRenderTargets = { [renderer.CONTEXT_UID]: target };
  const sibling = { baseTexture: base };
  renderer.bindTexture(base);
  const backing = base._glTextures[renderer.CONTEXT_UID];
  renderer.textureGC.maxIdle = 1;
  renderer.textureGC.count += 2;
  renderer.textureGC.run();
  assert.equal(renderer.textureManager.managedTextures.includes(base), false);
  assert.equal(renderer.textureManager._managedTextureSet.has(base), false);
  assert.equal(backing.texture, null);
  assert.equal(base._glRenderTargets[renderer.CONTEXT_UID], target);
  assert.equal(sibling.baseTexture.__pmjsRenderCanvas, source);
  assert.deepEqual(source.pixels, Uint8Array.from([20, 40, 60, 255]));
  renderer.bindTexture(sibling.baseTexture);
  assert.equal(base._glTextures[renderer.CONTEXT_UID].texture.handle, 43);
  assert.equal(renderer.textureManager.managedTextures.includes(base), true);
  renderer.destroy();
});

test('direct filter target and GL application APIs reject unsupported calls', () => {
  const [renderer] = createRenderers();
  for (const name of ['getRenderTarget', 'getPotRenderTarget', 'returnRenderTarget',
    'freePotRenderTarget', 'applyFilter', 'syncUniforms']) {
    assert.throws(() => renderer.filterManager[name](), /unsupported native capability/);
  }
  renderer.destroy();
});

test('a failed nested screen render restores the enclosing target transform', () => {
  let context;
  const [renderer] = createRenderers(1, selected => { context = selected; });
  const outerTransform = { a: 1, b: 0, c: 0, d: 1, tx: 7, ty: 3 };
  renderer.rootRenderTarget.transform = outerTransform;
  context.nativeSceneEncodingDepth = 1;
  context.nativeSceneRenderer = renderer;
  context.prepareNativeBitmapCaches = () => {};
  context.renderNativeStage = (...args) => {
    args[7]();
    throw new Error('nested drawing failed');
  };
  assert.throws(() => renderer.render({}, null, true, { ...outerTransform, tx: -2 }),
    /nested drawing failed/);
  assert.equal(renderer._activeRenderTarget, renderer.rootRenderTarget);
  assert.equal(renderer.rootRenderTarget.transform, outerTransform);
  renderer.destroy();
});

test('bulk removal clears registration and allows reuse of every retained texture', () => {
  const [renderer] = createRenderers();
  const manager = renderer.textureManager;
  const textures = manager.managedTextures;
  const bases = Array.from({ length: 64 }, createBaseTexture);
  for (const base of bases) renderer.bindTexture(base);
  manager.removeAll();
  assert.equal(manager.managedTextures, textures);
  assert.equal(textures.length, 0);
  assert.ok(renderer.boundTextures.every(base => base === null));
  for (const base of bases) {
    assert.equal(base.listenerCount('dispose'), 0);
    assert.equal(base._glTextures[renderer.CONTEXT_UID], undefined);
    renderer.bindTexture(base);
    manager.trackTexture(base);
  }
  assert.deepEqual(Array.from(textures), bases);
  renderer.destroy();
});

test('context restoration removes old registration and accepts retained textures again', () => {
  const [renderer] = createRenderers();
  const base = createBaseTexture();
  const textures = renderer.textureManager.managedTextures;
  renderer.bindTexture(base);
  const staleDispose = base.listeners('dispose')[0];
  renderer.handleContextRestored();
  assert.equal(textures.length, 0);
  assert.equal(base.listenerCount('dispose'), 0);
  renderer.bindTexture(base);
  const backing = base._glTextures[renderer.CONTEXT_UID];
  staleDispose();
  assert.equal(base._glTextures[renderer.CONTEXT_UID], backing);
  assert.deepEqual(Array.from(textures), [base]);
  renderer.destroy();
});

test('destroyed managers ignore stale events without affecting another context owner', () => {
  const [first, second] = createRenderers(2);
  const base = createBaseTexture();
  first.bindTexture(base);
  second.bindTexture(base);
  const manager = first.textureManager;
  const textures = manager.managedTextures;
  const staleDispose = base.listeners('dispose')[0];
  const secondBacking = base._glTextures[second.CONTEXT_UID];
  first.destroy();
  assert.equal(textures.length, 0);
  assert.equal(base.listenerCount('dispose'), 1);
  assert.equal(base._glTextures[first.CONTEXT_UID], undefined);
  staleDispose();
  manager.trackTexture(base);
  manager.updateTexture(base);
  manager.destroyTexture(base);
  manager.removeAll();
  manager.destroy();
  assert.equal(manager.managedTextures, textures);
  assert.equal(textures.length, 0);
  assert.equal(base._glTextures[second.CONTEXT_UID], secondBacking);
  assert.deepEqual(Array.from(second.textureManager.managedTextures), [base]);
  base.emit('dispose');
  assert.equal(second.textureManager.managedTextures.length, 0);
  assert.equal(base.listenerCount('dispose'), 0);
  second.bindTexture(base);
  assert.deepEqual(Array.from(second.textureManager.managedTextures), [base]);
  second.destroy();
});

test('preparation visits overlapping roots once and deduplicates shared sources in encounter order', () => {
  const [renderer] = createRenderers();
  const subscriptions = [], visits = [];
  function source(name) {
    return { complete: false, addEventListener(event) { subscriptions.push(name + ':' + event); }, removeEventListener() {} };
  }
  const first = source('first'), second = source('second');
  const child = { baseTexture: { source: second }, children: [] };
  const root = { baseTexture: { source: first }, children: [child, child],
    updateText(force) { visits.push(force); } };
  child.children.push(root);
  renderer.plugins.prepare.add(root).add(root).upload();
  assert.deepEqual(visits, [true]);
  assert.deepEqual(subscriptions, ['first:load', 'first:error', 'second:load', 'second:error']);
  renderer.destroy();
});
