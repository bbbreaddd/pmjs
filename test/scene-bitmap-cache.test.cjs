'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { makeHarness } = require('./helpers/scene-encoder-harness.cjs');
const { runModule } = require('./helpers/runtime-context.cjs');

test('an uninitialized bitmap cache draws live children and logs', () => {
  const harness = makeHarness();
  const { sandbox, sprite } = harness;
  const root = new sandbox.PIXI.Container();
  const cached = new sandbox.PIXI.Container();
  cached._cacheAsBitmap = true;
  cached.addChild(sprite());
  root.addChild(cached);
  assert.equal(sandbox.submitNativeScene(root), true);
  assert.equal(harness.submitted.length, 1);
  assert.deepEqual(harness.compatHits,
    [['render.cacheAsBitmap',
      'Container: uninitialized cache, drawing live children']]);
  assert.deepEqual(harness.submitted[0].metadata.filter((_, index) => index % 7 === 0),
    [0, 0, 1]);
});

test('bitmap cache uses one Pixi snapshot until the cache is disabled', () => {
  const harness = makeHarness();
  const { sandbox, sprite } = harness;
  const root = new sandbox.PIXI.Container();
  const cached = new sandbox.PIXI.Container();
  const child = sprite();
  const snapshot = sprite();
  snapshot.alpha = 0.4;
  cached.x = 12;
  cached._cacheAsBitmap = true;
  cached._cacheData = { sprite: null };
  cached.addChild(child);
  root.addChild(cached);
  let builds = 0;
  cached._initCachedDisplayObject = renderer => {
    builds++;
    assert.equal(cached.__pmjsBuildingBitmapCache, true);
    assert.equal(renderer.render(cached), true);
    cached._cacheData.sprite = snapshot;
  };
  const renderer = { render(node) {
    const packet = sandbox.encodeNativeScene(node);
    assert.ok(packet.count >= 0);
    return true;
  } };
  sandbox.prepareNativeBitmapCaches(root, renderer);
  assert.equal(sandbox.submitNativeScene(root), true);
  const first = harness.submitted[0];
  child.x = 100;
  sandbox.prepareNativeBitmapCaches(root, renderer);
  assert.equal(sandbox.submitNativeScene(root), true);
  const second = harness.submitted[1];
  assert.equal(builds, 1);
  assert.deepEqual(first, second);
  assert.deepEqual(first.metadata.filter((_, index) => index % 7 === 0),
    [0, 0, 1]);
  assert.equal(first.values[41 + 4], 12);
  assert.equal(first.values[2 * 41 + 6], 1);
  cached.alpha = 0.6;
  assert.equal(sandbox.submitNativeScene(root), true);
  assert.ok(Math.abs(harness.submitted[2].values[41 + 6] - 0.6) < 0.000001);
  assert.equal(harness.submitted[2].values[2 * 41 + 6], 1);
  assert.deepEqual(harness.compatObserved,
    [['render.cacheAsBitmap', 'Container'],
      ['render.cacheAsBitmap', 'Container'],
      ['render.cacheAsBitmap', 'Container']]);
  assert.deepEqual(harness.compatHits, []);
});

test('picture-prefix snapshots draw the live tail afterward in painter order', () => {
  const { sandbox, sprite, submitted } = makeHarness();
  const root = new sandbox.PIXI.Container();
  const layer = root.addChild(new sandbox.PIXI.Container());
  const background = layer.addChild(sprite());
  const marker = layer.addChild(sprite());
  const snapshot = sprite();
  layer.x = 12; marker.x = 90; background.x = 42;
  layer._cacheAsBitmap = true;
  layer._cacheData = { sprite: snapshot };
  sandbox.PMJS.mv = { pictureLayerCache: {
    validate(node) { assert.equal(node, layer); },
    tail(node) { return node === layer ? [marker] : []; }
  } };
  assert.equal(sandbox.submitNativeScene(root), true);
  const packet = submitted[0];
  assert.deepEqual(packet.metadata.filter((_, index) => index % 7 === 0), [0, 0, 1, 1]);
  assert.equal(packet.values[41 + 4], 12);
  assert.equal(packet.values[3 * 41 + 4], 90);
  assert.equal(packet.metadata[3 * 7 + 1], 1, 'the marker uses the picture container transform');
});

test('nested bitmap caches build inside out and draw the parent snapshot', () => {
  const harness = makeHarness();
  const { sandbox, sprite } = harness;
  const root = new sandbox.PIXI.Container();
  const outer = new sandbox.PIXI.Container();
  const inner = new sandbox.PIXI.Container();
  inner.addChild(sprite());
  outer.addChild(inner);
  root.addChild(outer);
  const order = [];
  for (const [name, node] of [['inner', inner], ['outer', outer]]) {
    node._cacheAsBitmap = true;
    node._cacheData = { sprite: null };
    node._initCachedDisplayObject = renderer => {
      order.push(name);
      assert.equal(renderer.render(node), true);
      node._cacheData.sprite = sprite();
    };
  }
  const renderer = { render(node) {
    sandbox.encodeNativeScene(node);
    return true;
  } };
  sandbox.prepareNativeBitmapCaches(root, renderer);
  assert.deepEqual(order, ['inner', 'outer']);
  assert.equal(sandbox.submitNativeScene(root), true);
  assert.deepEqual(harness.submitted[0].metadata.filter(
    (_, index) => index % 7 === 0), [0, 0, 1]);
});

test('declared bitmap producer follows live cache, visibility and attachment state', () => {
  const { sandbox, sprite } = makeHarness();
  const root = new sandbox.PIXI.Container(), parent = root.addChild(new sandbox.PIXI.Container());
  const cached = parent.addChild(new sandbox.PIXI.Container()), other = root.addChild(new sandbox.PIXI.Container());
  let scans = 0, builds = 0, valid = true;
  Object.defineProperty(other, 'children', { get() { scans++; return []; } });
  cached._cacheData = { sprite: null };
  cached._initCachedDisplayObject = () => {
    assert.equal(cached.__pmjsBuildingBitmapCache, true);
    assert.equal(cached.worldAlpha, 0.125);
    builds++; cached._cacheData.sprite = sprite();
  };
  root.alpha = parent.alpha = cached.alpha = 0.5;
  const nodes = [cached];
  sandbox.PMJS.pixi4.setStageRenderOptions(root, { worldState: 'local',
    bitmapCacheProducers: { nodes, valid: stage => stage === root && valid } });
  nodes.length = 0;
  const policy = sandbox.PMJS.pixi4.getStageRenderOptions(root).bitmapCacheProducers;
  function prepare() { sandbox.prepareNativeBitmapCaches(root, {}, null, policy); }
  prepare(); assert.equal(scans, 1);
  cached._cacheAsBitmap = true; prepare(); prepare();
  assert.equal(builds, 1); assert.equal(scans, 1, 'admission scans only once');
  cached._cacheData.sprite = null;
  parent.visible = false; prepare(); assert.equal(builds, 1);
  parent.visible = true;
  parent.children.length = 0; prepare(); assert.equal(builds, 1, 'stale parent pointer is detached');
  parent.children.push(cached); prepare(); assert.equal(builds, 2);
  cached._cacheAsBitmap = false; cached._cacheData.sprite = null;
  prepare(); assert.equal(builds, 2);
  cached._cacheAsBitmap = true; prepare(); assert.equal(builds, 3, 'private flag changes are read live');
  valid = false; prepare();
  assert.equal(sandbox.PMJS.pixi4.getStageRenderState(root).bitmapCacheAdmission, 'invalid');
  valid = true; prepare(); assert.equal(scans, 3, 'validation recovery performs admission again');
  assert.equal(sandbox.PMJS.pixi4.getStageRenderState(root).bitmapCacheMode, 'declared');
});

test('invalidating a declaration discovers a producer added after admission', () => {
  const { sandbox, sprite } = makeHarness();
  const root = new sandbox.PIXI.Container(), declared = root.addChild(new sandbox.PIXI.Container());
  let valid = true;
  const built = [];
  function configure(node, name) {
    node._cacheAsBitmap = true; node._cacheData = { sprite: null };
    node._initCachedDisplayObject = () => { built.push(name); node._cacheData.sprite = sprite(); };
  }
  configure(declared, 'declared');
  sandbox.PMJS.pixi4.setStageRenderOptions(root, { worldState: 'local',
    bitmapCacheProducers: { nodes: [declared], valid: () => valid } });
  const policy = sandbox.PMJS.pixi4.getStageRenderOptions(root).bitmapCacheProducers;
  sandbox.prepareNativeBitmapCaches(root, {}, null, policy);
  configure(root.addChild(new sandbox.PIXI.Container()), 'new');
  valid = false;
  sandbox.prepareNativeBitmapCaches(root, {}, null, policy);
  assert.deepEqual(built, ['declared', 'new']);
  assert.equal(sandbox.PMJS.pixi4.getStageRenderState(root).bitmapCacheMode, 'full');
});

test('undeclared hidden bitmap producers retain ordinary census and multiple caches retain postorder', () => {
  const { sandbox, sprite } = makeHarness();
  const root = new sandbox.PIXI.Container(), outer = root.addChild(new sandbox.PIXI.Container());
  const inner = outer.addChild(new sandbox.PIXI.Container()), order = [];
  for (const [name, node] of [['outer', outer], ['inner', inner]]) {
    node._cacheAsBitmap = true; node._cacheData = { sprite: null };
    node._initCachedDisplayObject = () => { order.push(name); node._cacheData.sprite = sprite(); };
  }
  inner.visible = false;
  function prepare(nodes) {
    sandbox.PMJS.pixi4.setStageRenderOptions(root, { worldState: 'native',
      bitmapCacheProducers: { nodes, valid: () => true } });
    sandbox.prepareNativeBitmapCaches(root, {}, null,
      sandbox.PMJS.pixi4.getStageRenderOptions(root).bitmapCacheProducers);
    return sandbox.PMJS.pixi4.getStageRenderState(root);
  }
  assert.equal(prepare([outer]).bitmapCacheAdmission, 'rejected');
  assert.deepEqual(order, ['outer']);
  order.length = 0; outer._cacheData.sprite = null; inner.visible = true;
  const state = prepare([outer, inner]);
  assert.deepEqual(order, ['inner', 'outer']);
  assert.equal(state.bitmapCacheMode, 'full');
  assert.equal(state.bitmapCacheAdmission, 'accepted');
});

test('world-state policy changes preserve producer admission until the declaration changes', () => {
  const { sandbox } = makeHarness(), api = sandbox.PMJS.pixi4;
  const root = new sandbox.PIXI.Container(), producer = root.addChild(new sandbox.PIXI.Container());
  const other = root.addChild(new sandbox.PIXI.Container());
  let scans = 0;
  Object.defineProperty(other, 'children', { get() { scans++; return []; } });
  api.setStageRenderOptions(root, { worldState: 'pixi',
    bitmapCacheProducers: { nodes: [producer], valid: () => true } });
  const original = api.getStageRenderOptions(root).bitmapCacheProducers;
  function prepare() {
    sandbox.prepareNativeBitmapCaches(root, {}, null, api.getStageRenderOptions(root).bitmapCacheProducers);
  }
  prepare();
  for (let index = 0; index < 20; index++) {
    api.setStageRenderOptions(root, { ...api.getStageRenderOptions(root),
      worldState: index % 2 ? 'pixi' : 'local' });
    assert.equal(api.getStageRenderOptions(root).bitmapCacheProducers, original);
    prepare();
  }
  assert.equal(scans, 1, 'world-state transitions reuse the original admission');
  api.setStageRenderOptions(root, { worldState: 'local',
    bitmapCacheProducers: { nodes: [producer], valid: () => true } });
  assert.notEqual(api.getStageRenderOptions(root).bitmapCacheProducers, original);
  prepare(); assert.equal(scans, 2, 'replacement declarations require admission');
  api.setStageRenderOptions(root, null);
  api.setStageRenderOptions(root, { worldState: 'local', bitmapCacheProducers: original });
  prepare(); assert.equal(scans, 3, 'clearing the policy invalidates its admission');
});

test('producer declaration validates shape and preserves initializer error cleanup', () => {
  const { sandbox } = makeHarness(), api = sandbox.PMJS.pixi4;
  const root = new sandbox.PIXI.Container();
  for (const policy of [null, {}, { nodes: [], valid: false },
    { nodes: [null], valid() {} }, { nodes: [root, root], valid() {} }]) {
    assert.throws(() => api.setStageRenderOptions(root,
      { worldState: 'local', bitmapCacheProducers: policy }), /bitmapCacheProducers/);
  }
  root._cacheAsBitmap = true;
  root._initCachedDisplayObject = () => { throw new Error('cache build failed'); };
  api.setStageRenderOptions(root, { worldState: 'local',
    bitmapCacheProducers: { nodes: [root], valid: () => true } });
  assert.throws(() => sandbox.prepareNativeBitmapCaches(root, {}, null,
    api.getStageRenderOptions(root).bitmapCacheProducers), /cache build failed/);
  assert.equal(root.__pmjsBuildingBitmapCache, false);
  api.setStageRenderOptions(root, null);
  assert.equal(api.getStageRenderOptions(root), undefined);
});

test('renderer confines producer selection to configured screen renders and reports the selected route', () => {
  const { sandbox } = makeHarness();
  sandbox.PIXI.RENDERER_TYPE = { WEBGL: 1 };
  sandbox.PIXI.Texture.EMPTY = { baseTexture: {} };
  sandbox.PIXI.Matrix = class { identity() { return this; } };
  sandbox.PIXI.WebGLRenderer = class {};
  Object.assign(sandbox.NativeHost.render, { setScreenRenderSize() {}, setClearColor() {}, setClearBeforeRender() {}, setRenderTargetSize() {}, renderToCanvas() {} });
  sandbox.CanvasElement.prototype._pmjsContentChanged = function() {};
  for (const name of ['renderer-managers', 'renderer-facade']) {
    runModule(sandbox, 'js/pmjs-pixi4/' + name + '.js');
  }
  const renderer = sandbox.createNativePixiRenderer({ width: 32, height: 24, view: { style: {} } });
  const root = new sandbox.PIXI.Container(), inner = new sandbox.PIXI.Container();
  sandbox.PMJS.pixi4.setStageRenderOptions(root, { worldState: 'local',
    bitmapCacheProducers: { nodes: [], valid: () => true } });
  const submit = sandbox.submitNativeScene;
  sandbox.submitNativeScene = function(stage, color) {
    if (stage === root) renderer.render(inner);
    return submit(stage, color);
  };
  renderer.render(root);
  assert.equal(renderer._pmjsScreenStage, root);
  const screenRenderId = renderer._pmjsScreenRenderId;
  const state = sandbox.PMJS.pixi4.getStageRenderState(root);
  assert.equal(state.worldState, 'local'); assert.equal(state.renders, 1);
  assert.equal(state.bitmapCacheMode, 'declared'); assert.equal(state.bitmapCacheAdmission, 'accepted');
  assert.equal(sandbox.PMJS.pixi4.getStageRenderState(inner).bitmapCacheMode, 'full');
  sandbox.submitNativeScene = submit;
  renderer.render(root, { baseTexture: { width: 8, height: 8 } });
  assert.equal(renderer._pmjsScreenRenderId, screenRenderId, 'offscreen renders do not establish a presented frame');
  assert.equal(renderer._pmjsScreenStage, root);
  const after = sandbox.PMJS.pixi4.getStageRenderState(root);
  assert.equal(after.renders, 2);
  assert.equal(after.bitmapCacheMode, 'full'); assert.equal(after.bitmapCacheAdmission, 'offscreen');
  assert.equal(state.renders, 1, 'earlier diagnostic snapshots remain unchanged');
  assert.equal(state.bitmapCacheMode, 'declared');
});
