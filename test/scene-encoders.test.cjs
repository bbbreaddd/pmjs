'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const { makeHarness } = require('./helpers/scene-encoder-harness.cjs');
function setTriangleBitmap(sandbox, mesh, values, options = {}) {
  sandbox.PMJS.plugins.mpp.setTriangleBitmap(mesh, {
    points: [values.slice(0,2), values.slice(2,4), values.slice(4,6)], sourceBounds: values.slice(6,10),
    stroke: { color: values.slice(10,13), alpha: values[13], width: values[14], miterLimit: values[15] },
    strokeSamples: 0, clipCoverage: 'area', ...options
  });
}

test('blank tile retains its canvas owner for later layer compilations', () => {
  const { sandbox } = makeHarness();
  const handle = sandbox.nativeBlankTile();
  assert.ok(handle);
  assert.ok(sandbox.nativeBlankTileCanvas);
  assert.equal(sandbox.nativeBlankTileCanvas._ensureNativeCanvas().handle, handle);
  assert.equal(sandbox.nativeBlankTile(), handle);
});

function buildPlainFixture(harness) {
  const { sandbox, sprite } = harness;
  const root = new sandbox.PIXI.Container();
  const inner = new sandbox.PIXI.Container();
  root.addChild(inner);
  inner.addChild(sprite());
  inner.addChild(sprite());
  const deep = new sandbox.PIXI.Container();
  inner.addChild(deep);
  deep.addChild(sprite());
  return root;
}

function submitOnly(harness, stage) {
  harness.submitted.length = 0;
  harness.compatHits.length = 0;
  harness.counts.filterPlans = 0;
  harness.counts.rectMasks = 0;
  harness.counts.alphaMasks = 0;
  const result = harness.sandbox.submitNativeScene(stage);
  assert.equal(result, true);
  assert.equal(harness.submitted.length, 1);
  assert.deepEqual(harness.compatHits, []);
  return harness.submitted[0];
}

const EXPECTED_PLAIN_METADATA = [0, 4294967295, 0, 16777215, 0, 0, 0,
  0, 0, 0, 16777215, 0, 0, 0,
  1, 1, 100, 16777215, 0, 0, 0,
  1, 1, 101, 16777215, 0, 0, 0,
  0, 1, 0, 16777215, 0, 0, 0,
  1, 4, 102, 16777215, 0, 0, 0];
const EXPECTED_PLAIN_VALUES = [
  1, 0, 0, 1, 0, 0, 1,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0,
  1, 0, 0, 1, 0, 0, 1,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0,
  1, 0, 0, 1, 0, 0, 1,
  -0, -0, 0, 0, 32, 32, 32, 32,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  1, 0, 0, 1, 0, 0, 1,
  -0, -0, 0, 0, 32, 32, 32, 32,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  1, 0, 0, 1, 0, 0, 1,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0,
  1, 0, 0, 1, 0, 0, 1,
  -0, -0, 0, 0, 32, 32, 32, 32,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

test('plain containers and sprites emit the frozen oracle packet', () => {
  const harness = makeHarness();
  const packet = submitOnly(harness, buildPlainFixture(harness));
  assert.equal(packet.count, 6);
  assert.deepEqual(packet.metadata, EXPECTED_PLAIN_METADATA);
  assert.deepEqual(packet.values, EXPECTED_PLAIN_VALUES);
});

test('sprite textures accept the shared native raster source capability', () => {
  const harness = makeHarness();
  const { sandbox } = harness;
  const source = {
    width: 40,
    height: 30,
    _nativeCanvas: { handle: 666 },
    _pmjsNativeTextureSource() { return { handle: 777 }; }
  };
  const frame = { x: 0, y: 0, width: 40, height: 30 };
  const texture = { baseTexture: { source, resolution: 1, scaleMode: 0,
      width: 40, height: 30 },
    _frame: frame, frame, orig: frame, trim: null, rotate: 0, width: 40, height: 30 };
  const root = new sandbox.PIXI.Container();
  root.addChild(new sandbox.PIXI.Sprite(texture));

  const packet = submitOnly(harness, root);
  assert.equal(packet.count, 2);
  assert.equal(packet.metadata[7 + 2], 777);
});

test('plain fixture performs no filter, mask, or effect work', () => {
  const harness = makeHarness();
  const packet = submitOnly(harness, buildPlainFixture(harness));
  assert.deepEqual(harness.counts,
    { filterPlans: 0, rectMasks: 0, alphaMasks: 0 });
  assert.deepEqual(packet.metadata.filter((_, index) => index % 7 === 0),
    [0, 0, 1, 1, 0, 1]);
});

test('fixed representation table classifies every leaf without probing', () => {
  const harness = makeHarness();
  const { sandbox } = harness;
  const kinds = vm.runInContext(`({
    container: nativeSceneKind(new PIXI.Container()),
    sprite: nativeSceneKind(new PIXI.Sprite(null)),
    picture: nativeSceneKind(
      Object.assign(new PIXI.Sprite(null), { pluginName: 'picture' })),
    weather: nativeSceneKind(
      Object.assign(new PIXI.Sprite(null), { pluginName: 'weathersprite' })),
    screen: nativeSceneKind(new ScreenSprite()),
    tiling: nativeSceneKind(
      new PIXI.extras.TilingSprite(null, 4, 4)),
    graphics: nativeSceneKind(new PIXI.Graphics()),
    mesh: nativeSceneKind(new PIXI.mesh.Mesh(null)),
    rectLayer: nativeSceneKind({ pointsBuf: [], textures: [] }),
    unknown: nativeSceneKind(
      Object.assign(new PIXI.Sprite(null), { pluginName: 'customPipe' })),
    encoders: [typeof writeNativeSceneSprite, typeof writeNativeSceneMesh,
      typeof writeNativeSceneKind].join(','),
    kinds: PMJS_SCENE_KIND
  })`, sandbox);

  const table = JSON.parse(JSON.stringify(kinds));
  assert.deepEqual(table, { container: 0, sprite: 1, picture: 1, weather: 1,
    screen: 2, tiling: 3, graphics: 4, mesh: 5, rectLayer: 6, unknown: 0,
    encoders: 'function,function,function',
    kinds: { CONTAINER: 0, SPRITE: 1, SCREEN_SPRITE: 2, TILING_SPRITE: 3,
      GRAPHICS: 4, MESH: 5, RECT_TILE_LAYER: 6, GENERIC: 7 } });
});

test('unknown renderer labels render as containers and log the label', () => {
  const harness = makeHarness();
  const { sandbox, sprite } = harness;
  const root = new sandbox.PIXI.Container();
  const custom = sprite();
  custom.pluginName = 'customChaos';
  custom.addChild(sprite());
  root.addChild(custom);
  root.addChild(sprite());
  assert.equal(sandbox.submitNativeScene(root), true);
  assert.equal(harness.submitted.length, 1);
  assert.deepEqual(harness.compatHits,
    [['render.renderer-plugin', 'Sprite:renderer=customchaos:children=1']]);
  assert.deepEqual(harness.submitted[0].metadata.filter((_, index) => index % 7 === 0),
    [0, 0, 1, 1]);
});

test('childless custom renderer labels log a visual leaf', () => {
  const harness = makeHarness();
  const { sandbox, sprite } = harness;
  const root = new sandbox.PIXI.Container();
  const custom = sprite();
  custom.pluginName = 'customChaos';
  root.addChild(custom);
  assert.equal(sandbox.submitNativeScene(root), true);
  assert.deepEqual(harness.compatHits,
    [['render.renderer-plugin', 'Sprite:renderer=customchaos:visual-leaf']]);
  assert.deepEqual(harness.submitted[0].metadata.filter((_, index) => index % 7 === 0),
    [0, 0]);
});

test('rendered frames report exact versus degraded counts', () => {
  const harness = makeHarness();
  const { sandbox, sprite } = harness;
  const root = new sandbox.PIXI.Container();
  root.addChild(sprite());
  sandbox.renderNativeStage(root, undefined, undefined, undefined, false, null, sandbox.PMJS.pixi4.getStageRenderOptions(root));
  assert.equal(sandbox.renderNativeStage._framesTotal, 1);
  assert.equal(sandbox.renderNativeStage._framesDegraded || 0, 0);
  const filtered = sprite();
  filtered._filters = [{ enabled: true }];
  root.addChild(filtered);
  sandbox.renderNativeStage(root, undefined, undefined, undefined, false, null, sandbox.PMJS.pixi4.getStageRenderOptions(root));
  assert.equal(sandbox.renderNativeStage._framesTotal, 2);
  assert.equal(sandbox.renderNativeStage._framesDegraded, 1);
});

test('unrealized tile layers log instead of vanishing silently', () => {
  const harness = makeHarness();
  const { sandbox } = harness;
  const root = new sandbox.PIXI.Container();
  const layer = { pointsBuf: [], textures: [], parent: null,
    visible: true, renderable: true, alpha: 1 };
  root.addChild(layer);
  assert.equal(sandbox.submitNativeScene(root), true);
  assert.deepEqual(harness.compatHits,
    [['render.tilemap', 'Object:layer-unrealized']]);
});

test('reached custom render hooks report the native approximation', () => {
  const harness = makeHarness();
  const { sandbox, sprite } = harness;
  class WeirdSprite extends sandbox.PIXI.Sprite {
    _renderWebGL() {}
  }
  const root = new sandbox.PIXI.Container();
  const subclass = new WeirdSprite(harness.makeTexture(32, 32));
  root.addChild(subclass);
  root.addChild(sprite());
  assert.equal(sandbox.submitNativeScene(root), true);
  assert.deepEqual(harness.compatHits,
    [['render.render-method', 'WeirdSprite._renderWebGL']]);
  assert.deepEqual(harness.submitted[0].metadata.filter((_, index) => index % 7 === 0),
    [0, 1, 1]);
  root.children.length = 0;
  harness.submitted.length = 0;
  harness.compatHits.length = 0;
  const instance = sprite();
  instance.renderWebGL = function() {};
  root.addChild(instance);
  assert.equal(sandbox.submitNativeScene(root), true);
  assert.deepEqual(harness.compatHits,
    [['render.render-method', 'Sprite.renderWebGL']]);
  assert.deepEqual(harness.submitted[0].metadata.filter((_, index) => index % 7 === 0),
    [0, 1]);
});

test('late prototype render patches are reported on the next traversal', () => {
  const harness = makeHarness();
  const { sandbox, sprite } = harness;
  const root = new sandbox.PIXI.Container();
  const stock = sprite();
  root.addChild(stock);
  submitOnly(harness, root);
  sandbox.PIXI.Sprite.prototype._renderWebGL = function() {};
  assert.equal(sandbox.submitNativeScene(root), true);
  assert.deepEqual(harness.compatHits,
    [['render.render-method', 'Sprite._renderWebGL']]);
  assert.deepEqual(harness.submitted[harness.submitted.length - 1].metadata
    .filter((_, index) => index % 7 === 0), [0, 1]);
});

test('plain sprite segments cannot conceal overridden render hooks', () => {
  const harness = makeHarness();
  const { sandbox, sprite } = harness;
  const root = new sandbox.PIXI.Container();
  for (let index = 0; index < 5; index++) root.addChild(sprite());
  root.children[3]._renderWebGL = function() {};
  assert.equal(sandbox.submitNativeScene(root), true);
  assert.deepEqual(harness.compatHits,
    [['render.render-method', 'Sprite._renderWebGL']]);
  assert.deepEqual(harness.submitted[0].metadata.filter((_, index) => index % 7 === 0),
    [0, 1, 1, 1, 1, 1]);
});

test('unreached render hooks and Canvas-only overrides do not report unsupported drawing', () => {
  const harness = makeHarness();
  const { sandbox, sprite } = harness;
  const root = new sandbox.PIXI.Container();
  const hidden = root.addChild(sprite());
  hidden.visible = false;
  hidden.renderWebGL = function() {};
  const hiddenParent = root.addChild(new sandbox.PIXI.Container());
  hiddenParent.renderable = false;
  hiddenParent.addChild(sprite())._renderWebGL = function() {};
  const detached = sprite();
  detached._renderWebGL = function() {};
  root.addChild(sprite()).renderCanvas = function() {};
  submitOnly(harness, root);

  const particles = root.addChild(new sandbox.PIXI.particles.ParticleContainer());
  particles.addChild(sprite()).renderWebGL = function() {};
  submitOnly(harness, root);
});

test('strict render-hook rejection precedes submission and restores the stage parent', () => {
  const harness = makeHarness();
  const { sandbox, sprite } = harness;
  sandbox.NativeHost.runtime.env = name =>
    name === 'PMJS_STRICT_COMPAT' ? '1' : undefined;
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..',
    'js/pmjs-core/compatibility.js'), 'utf8'), sandbox);
  const parent = new sandbox.PIXI.Container();
  const root = parent.addChild(new sandbox.PIXI.Container());
  for (let index = 0; index < 6; index++) root.addChild(sprite());
  root.children[4]._renderWebGL = function() {
    throw new Error('unsupported hook must not be invoked');
  };
  assert.throws(() => sandbox.renderNativeStage(root),
    /unsupported native capability: render\.render-method: Sprite\._renderWebGL/);
  assert.equal(harness.submitted.length, 0);
  assert.equal(sandbox.renderNativeStage._ready, false);
  assert.equal(root.parent, parent);
  delete root.children[4]._renderWebGL;
  sandbox.renderNativeStage(root);
  assert.equal(harness.submitted.length, 1);
  assert.equal(sandbox.renderNativeStage._ready, true);
});

test('a reached render override marks each affected frame degraded', () => {
  const harness = makeHarness();
  const { sandbox, sprite } = harness;
  const root = new sandbox.PIXI.Container();
  const child = root.addChild(sprite());
  child.renderWebGL = function() {};
  sandbox.renderNativeStage(root);
  sandbox.renderNativeStage(root);
  assert.equal(sandbox.renderNativeStage._framesDegraded, 2);
  delete child.renderWebGL;
  sandbox.renderNativeStage(root);
  assert.equal(sandbox.renderNativeStage._framesTotal, 3);
  assert.equal(sandbox.renderNativeStage._framesDegraded, 2);
});

test('structural tile layers cannot bypass render-method reporting', () => {
  const harness = makeHarness();
  const { sandbox } = harness;
  const root = new sandbox.PIXI.Container();
  root.addChild({ pointsBuf: [], textures: [], renderWebGL() {} });
  sandbox.submitNativeScene(root);
  assert.deepEqual(harness.compatHits, [
    ['render.render-method', 'Object.renderWebGL'],
    ['render.tilemap', 'Object:layer-unrealized']
  ]);
});

test('skipUpdateTransform uses the rendered root world transform', () => {
  const harness = makeHarness();
  const { sandbox } = harness;
  const root = new sandbox.PIXI.Container();
  root.x = 12;
  root.transform.worldTransform.tx = 0;
  sandbox.renderNativeStage(root,
    { a: 1, b: 0, c: 0, d: 1, tx: 5, ty: 3 }, 1, false, true);
  assert.equal(harness.submitted[0].values[4], 5);
  assert.equal(harness.submitted[0].values[5], 3);
  assert.equal(root.parent, null);
  sandbox.renderNativeStage(root,
    { a: 1, b: 0, c: 0, d: 1, tx: 5, ty: 3 }, 1, false, false);
  assert.equal(harness.submitted[1].values[4], 17);
  assert.equal(harness.submitted[1].values[5], 3);
});

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

test('active blur filter takes the advanced lane and stays correct', () => {
  const harness = makeHarness();
  const { sandbox, sprite } = harness;
  const root = new sandbox.PIXI.Container();
  const filtered = sprite();
  filtered._filters = [new sandbox.PIXI.filters.BlurFilter(4, 2)];
  root.addChild(filtered);
  const packet = submitOnly(harness, root);
  assert.deepEqual(harness.counts,
    { filterPlans: 1, rectMasks: 0, alphaMasks: 0 });
  assert.deepEqual(packet.metadata.filter((_, index) => index % 7 === 0),
    [0, 6, 1, 7]);
});

test('active rectangle mask resolves to a scissor without alpha work', () => {
  const harness = makeHarness();
  const { sandbox, sprite } = harness;
  const root = new sandbox.PIXI.Container();
  const masked = sprite();
  const mask = new sandbox.PIXI.Graphics();
  mask.graphicsData = [{ fill: true, fillColor: 0xffffff, fillAlpha: 1,
    lineWidth: 0, holes: [],
    shape: new sandbox.PIXI.Rectangle(4, 4, 40, 30) }];
  mask._localBounds = { x: 4, y: 4, width: 40, height: 30 };
  masked.mask = mask;
  root.addChild(masked);
  const packet = submitOnly(harness, root);
  assert.deepEqual(harness.counts,
    { filterPlans: 1, rectMasks: 1, alphaMasks: 0 });

  assert.equal(packet.metadata[1 * 7 + 5] & 1, 1);
});

test('proven full-frame Sprite mask resolves to a scissor without alpha work', () => {
  const harness = makeHarness();
  const { sandbox, sprite } = harness;
  const root = new sandbox.PIXI.Container();
  const masked = sprite();
  const mask = sprite(100, 92);
  const source = mask.texture.baseTexture.source;
  source.__pmjsContentRevision = 0;
  sandbox.PMJS.web.canvas.trackMaskFill({ canvas: source,
    globalAlpha: 1, globalCompositeOperation: 'source-over',
    _transform: [1, 0, 0, 1, 0, 0], _clipPaths: [] },
  0, 0, 100, 92, 'white', () => { source.__pmjsContentRevision++; });
  mask.x = 7;
  mask.y = 25;
  masked.mask = mask;
  root.addChild(masked);
  const packet = submitOnly(harness, root);
  assert.deepEqual(harness.counts,
    { filterPlans: 1, rectMasks: 1, alphaMasks: 0 });
  assert.equal(packet.metadata[1 * 7 + 5] & 1, 1);
  assert.deepEqual(packet.values.slice(1 * 41 + 17, 1 * 41 + 21),
    [7, 25, 107, 117]);
});

test('uncertain Sprite masks retain the alpha-mask path', () => {
  const cases = [
    mask => { mask.texture.baseTexture.source.__pmjsContentRevision++; },
    mask => { mask.alpha = 0.5; },
    mask => { mask.texture.trim = { x: 0, y: 0, width: 100, height: 92 }; },
    mask => { mask.texture.rotate = 2; },
    mask => { mask.x = 0.5; }
  ];
  for (const change of cases) {
    const harness = makeHarness();
    const { sandbox, sprite } = harness;
    const root = new sandbox.PIXI.Container();
    const masked = sprite();
    const mask = sprite(100, 92);
    const source = mask.texture.baseTexture.source;
    source.__pmjsContentRevision = 0;
    sandbox.PMJS.web.canvas.trackMaskFill({ canvas: source,
      globalAlpha: 1, globalCompositeOperation: 'source-over',
      _transform: [1, 0, 0, 1, 0, 0], _clipPaths: [] },
    0, 0, 100, 92, 'white', () => { source.__pmjsContentRevision++; });
    change(mask);
    masked.mask = mask;
    root.addChild(masked);
    submitOnly(harness, root);
    assert.deepEqual(harness.counts,
      { filterPlans: 1, rectMasks: 1, alphaMasks: 1 });
  }
});

test('Sprite rectangle masks resolve anchor, negative scale, and another parent branch', () => {
  const harness = makeHarness();
  const { sandbox, sprite } = harness;
  const root = new sandbox.PIXI.Container();
  const faceLayer = new sandbox.PIXI.Container();
  const maskLayer = new sandbox.PIXI.Container();
  const masked = sprite();
  const mask = sprite(100, 92);
  const source = mask.texture.baseTexture.source;
  source.__pmjsContentRevision = 0;
  sandbox.PMJS.web.canvas.trackMaskFill({ canvas: source,
    globalAlpha: 1, globalCompositeOperation: 'source-over',
    _transform: [1, 0, 0, 1, 0, 0], _clipPaths: [] },
  0, 0, 100, 92, 'white', () => { source.__pmjsContentRevision++; });
  mask.anchor = { x: 0.5, y: 0.5 };
  mask.transform.localTransform = { a: -1, b: 0, c: 0, d: 1, tx: 107, ty: 71 };
  mask.transform.updateLocalTransform = function() {};
  maskLayer.transform.localTransform = { a: 1, b: 0, c: 0, d: 1, tx: 10, ty: 20 };
  maskLayer.transform.updateLocalTransform = function() {};
  maskLayer.addChild(mask);
  faceLayer.addChild(masked);
  root.addChild(maskLayer);
  root.addChild(faceLayer);
  masked.mask = mask;
  submitOnly(harness, root);
  assert.deepEqual(harness.counts,
    { filterPlans: 1, rectMasks: 1, alphaMasks: 0 });
});

test('disabled Sprite rectangle lowering retains the alpha-mask path', () => {
  const harness = makeHarness();
  const { sandbox, sprite } = harness;
  sandbox.PMJS.optimizations.isEnabled = id => id !== 'scene.solid-sprite-mask-clip';
  const root = new sandbox.PIXI.Container();
  const masked = sprite();
  const mask = sprite(100, 92);
  const source = mask.texture.baseTexture.source;
  source.__pmjsContentRevision = 0;
  sandbox.PMJS.web.canvas.trackMaskFill({ canvas: source,
    globalAlpha: 1, globalCompositeOperation: 'source-over',
    _transform: [1, 0, 0, 1, 0, 0], _clipPaths: [] },
  0, 0, 100, 92, 'white', () => { source.__pmjsContentRevision++; });
  masked.mask = mask;
  root.addChild(masked);
  submitOnly(harness, root);
  assert.deepEqual(harness.counts,
    { filterPlans: 1, rectMasks: 1, alphaMasks: 1 });
});

test('encoders observe state instead of advancing semantics', () => {
  function readModule(relative) {
    return fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
  }
  const encoders = readModule('js/pmjs-pixi4/scene-encoders.js');
  const prepare = readModule('js/pmjs-mv/render-prepare.js') + '\n' +
    readModule('js/pmjs-pixi4/scene-prepare.js');
  const classify = readModule('js/pmjs-pixi4/scene-classify.js');

  ['updateChowRender', '_paintAllTiles', '_sortChildren', 'updateText(',
    '.validate(', '_updateCursor', '_updateArrows', '_updatePauseSign',
    '_updateContents', 'nativeSceneFilter(', 'nativeRectangleMask(',
    'nativeAlphaMask('].forEach(forbidden => {
    assert.ok(encoders.indexOf(forbidden) < 0,
      'scene-encoders.js must not advance semantics: ' + forbidden);
  });

  ['nativeSceneRecord', 'nativeSceneFilterMarker', 'scene.submit',
    'filterPlan', 'nativeSceneEmission'].forEach(forbidden => {
    assert.ok(prepare.indexOf(forbidden) < 0,
      'scene-prepare.js must not encode packets: ' + forbidden);
  });

  ['nativeSceneRecord', 'prepareNativeSceneNode', 'nativeSceneFilter(',
    'ensureNative'].forEach(forbidden => {
    assert.ok(classify.indexOf(forbidden) < 0,
      'scene-classify.js must stay side-effect free: ' + forbidden);
  });
});

test('MV preparation patches indexed YED animation without rebuilding tiles', () => {
  const source = fs.readFileSync(path.join(__dirname, '..',
    'js/pmjs-mv/render-prepare.js'), 'utf8');
  class Tilemap {}
  const sandbox = { Tilemap, Window: function Window() {}, Math,
    nativeTileRebuilds: 0 };
  vm.createContext(sandbox);
  vm.runInContext(source + '\nthis.prepare = prepareNativeMvSceneNode;', sandbox);

  const pending = { 3: true };
  const node = Object.assign(new Tilemap(), {
    origin: { x: 0, y: 0 }, roundPixels: true,
    _margin: 0, _tileWidth: 48, _tileHeight: 48,
    _lastStartX: 0, _lastStartY: 0,
    _lastAnimationFrame: 1, animationFrame: 2,
    _needsRepaint: false,
    _pmjsIndexedAnimation: true,
    _needsAnimRepaint: true,
    _pmjsChangedAnimKeys: pending,
    _updateLayerPositions() {},
    _sortChildren() {},
    _paintAllTiles() { this.fullRepaints = (this.fullRepaints || 0) + 1; },
    _paintAnimTiles(keys) { this.patched = keys; }
  });

  sandbox.prepare(node);

  assert.equal(node.fullRepaints, undefined);
  assert.equal(node.patched, pending);
  assert.equal(node._pmjsChangedAnimKeys, null);
  assert.equal(node._needsAnimRepaint, false);
  assert.equal(node._lastAnimationFrame, 2);
  assert.equal(node._frameUpdated, true);
  assert.equal(sandbox.nativeTileRebuilds, 0);
});

test('MV preparation keeps animation-frame rebuilds for ordinary tilemaps', () => {
  const source = fs.readFileSync(path.join(__dirname, '..',
    'js/pmjs-mv/render-prepare.js'), 'utf8');
  class Tilemap {}
  const sandbox = { Tilemap, Window: function Window() {}, Math,
    nativeTileRebuilds: 0 };
  vm.createContext(sandbox);
  vm.runInContext(source + '\nthis.prepare = prepareNativeMvSceneNode;', sandbox);

  const node = Object.assign(new Tilemap(), {
    origin: { x: 0, y: 0 }, roundPixels: true,
    _margin: 0, _tileWidth: 48, _tileHeight: 48,
    _lastStartX: 0, _lastStartY: 0,
    _lastAnimationFrame: 1, animationFrame: 2,
    _needsRepaint: false,
    _updateLayerPositions() {},
    _sortChildren() {},
    _paintAllTiles() { this.fullRepaints = (this.fullRepaints || 0) + 1; }
  });

  sandbox.prepare(node);

  assert.equal(node.fullRepaints, 1);
  assert.equal(node._lastAnimationFrame, 2);
  assert.equal(node._frameUpdated, true);
  assert.equal(sandbox.nativeTileRebuilds, 1);
});

test('MV preparation sorts tilemap children after their ordering inputs move', () => {
  const source = fs.readFileSync(path.join(__dirname, '..',
    'js/pmjs-mv/render-prepare.js'), 'utf8');
  class Tilemap {}
  const sandbox = { Tilemap, Window: function Window() {}, Math,
    nativeTileRebuilds: 0 };
  vm.createContext(sandbox);
  vm.runInContext(source + '\nthis.prepare = prepareNativeMvSceneNode;', sandbox);
  const first = { name: 'A', z: 0, y: 30, spriteId: 1 };
  const second = { name: 'B', z: 0, y: 20, spriteId: 2 };
  const node = Object.assign(new Tilemap(), {
    children: [first, second], origin: { x: 0, y: 0 }, roundPixels: true,
    _margin: 0, _tileWidth: 48, _tileHeight: 48,
    _lastStartX: 0, _lastStartY: 0, _needsRepaint: false,
    _updateLayerPositions() {}, _paintAllTiles() {},
    _compareChildOrder(a, b) {
      return (a.z - b.z) || (a.y - b.y) || (a.spriteId - b.spriteId);
    },
    _sortChildren() { this.children.sort(this._compareChildOrder.bind(this)); }
  });
  sandbox.prepare(node);
  assert.deepEqual(node.children.map(child => child.name), ['B', 'A']);
});

test('filter parameter mutation re-renders without changing structure', () => {
  const harness = makeHarness();
  const { sandbox, sprite } = harness;
  const root = new sandbox.PIXI.Container();
  const filter = new sandbox.PIXI.filters.BlurFilter(4, 2);
  const filtered = sprite();
  filtered._filters = [filter];
  root.addChild(filtered);
  const first = submitOnly(harness, root);
  filter.blur = 8;
  const second = submitOnly(harness, root);
  assert.equal(first.count, second.count);
  assert.deepEqual(
    first.metadata.filter((_, index) => index % 7 === 0),
    second.metadata.filter((_, index) => index % 7 === 0));

  assert.notDeepEqual(first.values, second.values);
  assert.equal(first.values[41 + 7], 2);
  assert.equal(second.values[41 + 7], 4);
});

test('unsupported filters render unfiltered and log the filter', () => {
  const harness = makeHarness();
  const { sandbox, sprite } = harness;
  const root = new sandbox.PIXI.Container();
  const filtered = sprite();
  filtered._filters = [{ enabled: true }];
  root.addChild(filtered);
  root.addChild(sprite());
  harness.submitted.length = 0;
  harness.compatHits.length = 0;
  assert.equal(sandbox.submitNativeScene(root), true);
  assert.equal(harness.submitted.length, 1);
  assert.deepEqual(harness.compatHits,
    [['render.filter', 'Sprite:Object']]);
  assert.deepEqual(harness.submitted[0].metadata.filter((_, index) => index % 7 === 0),
    [0, 1, 1]);
});

test('unsupported filter resolution clears a previous node clip', () => {
  const harness = makeHarness();
  const { sandbox, sprite } = harness;
  sandbox.nativeEffectClip = { left: 1, top: 2, right: 3, bottom: 4 };
  const node = sprite();
  const plan = sandbox.resolveNativeAdvancedEffects(node, null,
    [{ enabled: true }], null, null, -1, null);
  assert.equal(plan.blur, 0);
  assert.equal(plan.groups.length, 0);
  assert.equal(sandbox.nativeEffectClip, null);
});

test('aborted visual encoders preserve a neutral transformed parent for children', () => {
  const harness = makeHarness();
  const { sandbox, makeTexture, sprite } = harness;
  const root = new sandbox.PIXI.Container();
  const texture = makeTexture(16, 16);
  texture.rotate = 1;
  const failed = new sandbox.PIXI.extras.TilingSprite(texture, 16, 16);
  failed.x = 30;
  failed.y = 12;
  failed.alpha = 0.4;
  failed.addChild(sprite(8, 8));
  root.addChild(failed);
  harness.submitted.length = 0;
  assert.equal(sandbox.submitNativeScene(root), true);
  const packet = harness.submitted[0];
  assert.deepEqual(harness.compatHits,
    [['render.texture-rotation', '1']]);
  assert.equal(packet.count, 3);
  assert.deepEqual(packet.metadata.filter((_, index) => index % 7 === 0),
    [0, 0, 1]);
  assert.equal(packet.metadata[2 * 7 + 1], 1,
    'child must remain parented to the degraded node');
  assert.equal(packet.values[41 + 4], 30);
  assert.equal(packet.values[41 + 5], 12);
  assert.ok(Math.abs(packet.values[41 + 6] - 0.4) < 0.000001);
});

test('a filter with a built-in constructor name cannot impersonate its shader', () => {
  const harness = makeHarness();
  const { sandbox, sprite } = harness;
  const root = new sandbox.PIXI.Container();
  const impostor = class BlurFilter {
    constructor() { this.enabled = true; this.blur = 3; this.quality = 1; }
  };
  const filtered = sprite();
  filtered._filters = [new impostor()];
  root.addChild(filtered);
  assert.equal(sandbox.submitNativeScene(root), true);
  assert.equal(harness.submitted.length, 1);
  assert.deepEqual(harness.compatHits,
    [['render.filter', 'Sprite:BlurFilter']]);
  assert.deepEqual(harness.submitted[0].metadata.filter((_, index) => index % 7 === 0),
    [0, 1]);
});

test('filtered scenes submit and keep readiness', () => {
  const harness = makeHarness();
  const { sandbox, sprite } = harness;
  const root = new sandbox.PIXI.Container();
  root.addChild(sprite());
  sandbox.renderNativeStage(root, undefined, undefined, undefined, false, null, sandbox.PMJS.pixi4.getStageRenderOptions(root));
  assert.equal(harness.submitted.length, 1);
  assert.equal(sandbox.renderNativeStage._ready, true);
  const filtered = sprite();
  filtered._filters = [{ enabled: true }];
  root.addChild(filtered);
  const parent = root.parent;
  sandbox.renderNativeStage(root, undefined, undefined, undefined, false, null, sandbox.PMJS.pixi4.getStageRenderOptions(root));
  assert.equal(harness.submitted.length, 2);
  assert.equal(sandbox.renderNativeStage._ready, true);
  assert.equal(root.parent, parent);
  assert.deepEqual(harness.compatHits.slice(-1),
    [['render.filter', 'Sprite:Object']]);
});

test('production counts filter hits without quitting', () => {
  const harness = makeHarness();
  const { sandbox, sprite } = harness;
  const root = new sandbox.PIXI.Container();
  root.addChild(sprite());
  sandbox.NativeHost.runtime.env = () => undefined;
  const filtered = sprite();
  filtered._filters = [{ enabled: true }];
  root.addChild(filtered);
  sandbox.renderNativeStage(root, undefined, undefined, undefined, false, null, sandbox.PMJS.pixi4.getStageRenderOptions(root));
  sandbox.renderNativeStage(root, undefined, undefined, undefined, false, null, sandbox.PMJS.pixi4.getStageRenderOptions(root));
  assert.equal(harness.submitted.length, 2);
  assert.equal(sandbox.renderNativeStage._ready, true);
  assert.deepEqual(harness.compatHits,
    [['render.filter', 'Sprite:Object'], ['render.filter', 'Sprite:Object']]);
});

test('strict and headless hits throw with the capability', () => {
  for (const [setting, value] of [
    ['PMJS_STRICT_COMPAT', '1'], ['PMJS_DIALOG_MODE', 'headless'],
    ['PMJS_DIALOG_MODE', 'strict']
  ]) {
    const harness = makeHarness();
    const { sandbox, sprite } = harness;
    const root = new sandbox.PIXI.Container();
    const filtered = sprite();
    filtered._filters = [{ enabled: true }];
    root.addChild(filtered);
    sandbox.NativeHost.runtime.env = name =>
      name === setting ? value : undefined;
    sandbox.PMJS.compat.hit = (kind, detail) => {
      harness.compatHits.push([kind, String(detail)]);
      throw new Error('unsupported native capability: ' + kind);
    };
    assert.throws(() => sandbox.renderNativeStage(root),
      /unsupported native capability: render\.filter/);
    assert.equal(harness.submitted.length, 0);
    assert.equal(sandbox.renderNativeStage._ready, false);
  }
});

test('PMJS_STRICT_COMPAT rejects an unsupported filter before submission', () => {
  const harness = makeHarness();
  const { sandbox, sprite } = harness;
  sandbox.NativeHost.runtime.env = name =>
    name === 'PMJS_STRICT_COMPAT' ? '1' : undefined;
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..',
    'js/pmjs-core/compatibility.js'), 'utf8'), sandbox);
  const root = new sandbox.PIXI.Container();
  const filtered = sprite();
  filtered._filters = [{ enabled: true }];
  root.addChild(filtered);
  assert.throws(() => sandbox.renderNativeStage(root),
    /unsupported native capability: render\.filter/);
  assert.equal(harness.submitted.length, 0);
  assert.equal(sandbox.renderNativeStage._ready, false);
});

test('native submit failure clears readiness and restores the stage parent', () => {
  const harness = makeHarness();
  const { sandbox, sprite } = harness;
  const root = new sandbox.PIXI.Container();
  root.addChild(sprite());
  sandbox.renderNativeStage(root, undefined, undefined, undefined, false, null, sandbox.PMJS.pixi4.getStageRenderOptions(root));
  const parent = root.parent;
  sandbox.NativeHost.scene.submit = () => { throw new Error('addon rejected packet'); };

  assert.throws(() => sandbox.renderNativeStage(root), /addon rejected packet/);
  assert.equal(sandbox.renderNativeStage._ready, false);
  assert.equal(root.parent, parent);
  assert.equal(harness.submitted.length, 1);
});

function directPacket(harness, node, clip, mask) {
  harness.sandbox.__node = node;
  harness.sandbox.__clip = clip || null;
  harness.sandbox.__mask = mask || null;
  const result = vm.runInContext(`(() => {
    nativeSceneCount = 0;
    nativeSceneFilterDepth = 0;
    writeNativeSceneNode(__node, 0xffffffff, __clip, __mask);
    return { count: nativeSceneCount,
      kinds: Array.from(nativeSceneMetadata.slice(0, nativeSceneCount * 7))
        .filter((_, index) => index % 7 === 0),
      metadata: Array.from(nativeSceneMetadata.slice(0, nativeSceneCount * 7)),
      values: Array.from(nativeSceneValues.slice(0, nativeSceneCount * 41)) };
  })()`, harness.sandbox);
  delete harness.sandbox.__node;
  delete harness.sandbox.__clip;
  delete harness.sandbox.__mask;
  return JSON.parse(JSON.stringify(result));
}

test('custom type hooks select the encoder while hooks run in order', () => {
  const harness = makeHarness();
  const { sandbox, sprite } = harness;
  let hookCalls = 0;
  sandbox.__pmjsBeforeRenderNode = function(node) {
    hookCalls++;
    if (node && typeof node.updateChowRender === 'function') {
      node.updateChowRender();
    }
  };
  sandbox.__pmjsNodeRenderType = function(node) {
    return (node && node._chowType) || '';
  };
  const root = new sandbox.PIXI.Container();
  const hooked = sprite();
  let hookUpdated = 0;
  hooked._chowType = 'mesh';
  hooked.vertices = new Float32Array([0, 0, 10, 0, 0, 10]);
  hooked.uvs = new Float32Array([0, 0, 1, 0, 0, 1]);
  hooked.indices = new Uint16Array([0, 1, 2]);
  hooked.updateChowRender = function() { hookUpdated++; };
  root.addChild(hooked);
  assert.equal(sandbox.submitNativeScene(root), true);
  assert.equal(hookCalls, 2);
  assert.equal(hookUpdated, 1);
  assert.deepEqual(harness.compatHits, []);
  assert.deepEqual(harness.submitted[0].metadata.filter((_, index) => index % 7 === 0),
    [0, 8]);
});

test('custom type hook observes post-transform-update state', () => {
  const harness = makeHarness();
  const { sandbox, sprite } = harness;
  const root = new sandbox.PIXI.Container();
  const node = sprite();
  node.x = 7;
  node.y = 3;

  node.transform.localTransform = { a: 1, b: 0, c: 0, d: 1,
    tx: 12345, ty: 6789 };
  let observed = null;
  sandbox.__pmjsNodeRenderType = function(current) {
    if (current === node) {
      observed = { tx: current.transform.localTransform.tx,
        ty: current.transform.localTransform.ty };
    }
    return '';
  };
  root.addChild(node);
  const packet = submitOnly(harness, root);
  assert.deepEqual(observed, { tx: 7, ty: 3 });
  assert.deepEqual(packet.metadata.filter((_, index) => index % 7 === 0),
    [0, 1]);
});

test('classifier adds no label reads beyond type resolution', () => {
  const harness = makeHarness();
  const { sandbox } = harness;
  const counts = vm.runInContext(`(() => {
    const plain = new PIXI.Container();
    let pluginValue;
    let typeValue;
    Object.defineProperty(plain, 'pluginName', { configurable: true,
      get() { return pluginValue; }, set(v) { pluginValue = v; } });
    Object.defineProperty(plain, '_pmjsType', { configurable: true,
      get() { return typeValue; }, set(v) { typeValue = v; } });
    let pluginReads = 0;
    let typeReads = 0;
    Object.defineProperty(plain, '__count', { value: 0 });
    const plainPlugin = Object.getOwnPropertyDescriptor(plain, 'pluginName');
    const plainType = Object.getOwnPropertyDescriptor(plain, '_pmjsType');
    Object.defineProperty(plain, 'pluginName', { configurable: true,
      get() { pluginReads++; return plainPlugin.get(); },
      set(v) { plainPlugin.set(v); } });
    Object.defineProperty(plain, '_pmjsType', { configurable: true,
      get() { typeReads++; return plainType.get(); },
      set(v) { plainType.set(v); } });
    const plainKind = nativeSceneKind(plain);
    const plainResult = { pluginReads, typeReads, plainKind };
    const custom = new PIXI.Sprite(null);
    let customPluginReads = 0;
    let customTypeReads = 0;
    Object.defineProperty(custom, 'pluginName', { configurable: true,
      get() { customPluginReads++; return 'customChaos'; } });
    Object.defineProperty(custom, '_pmjsType', { configurable: true,
      get() { customTypeReads++; return undefined; } });
    const customKind = nativeSceneKind(custom);
    return { plainResult, customPluginReads, customTypeReads, customKind };
  })()`, sandbox);
  const result = JSON.parse(JSON.stringify(counts));

  assert.deepEqual(result.plainResult,
    { pluginReads: 1, typeReads: 1, plainKind: 0 });

  assert.equal(result.customPluginReads, 1);
  assert.equal(result.customTypeReads, 0);
  assert.equal(result.customKind, 0);
});

test('tiling, screen, graphics, and mesh leaves emit their packet kinds', () => {
  const harness = makeHarness();
  const { sandbox, sprite, makeTexture } = harness;
  function leafKinds(node) {
    const root = new sandbox.PIXI.Container();
    root.addChild(node);
    return submitOnly(harness, root).metadata
      .filter((_, index) => index % 7 === 0);
  }
  const tiling = new sandbox.PIXI.extras.TilingSprite(
    makeTexture(48, 48), 200, 150);
  assert.deepEqual(leafKinds(tiling), [0, 2]);
  assert.deepEqual(leafKinds(new sandbox.ScreenSprite()), [0, 3]);
  const graphics = new sandbox.PIXI.Graphics();
  graphics.graphicsData = [{ fill: true, fillColor: 0xff0000, fillAlpha: 1,
    lineWidth: 0, holes: [],
    shape: { type: 1, x: 0, y: 0, width: 20, height: 12 } }];
  graphics._localBounds = { x: 0, y: 0, width: 20, height: 12 };
  assert.deepEqual(leafKinds(graphics), [0, 1]);
  assert.deepEqual(leafKinds(new sandbox.PIXI.mesh.Mesh(makeTexture(64, 64))),
    [0, 8]);
  assert.deepEqual(harness.counts,
    { filterPlans: 0, rectMasks: 0, alphaMasks: 0 });
  assert.equal(sprite() instanceof sandbox.PIXI.Sprite, true);
});

test('ordinary Pixi meshes upload live vertex changes without revision counters', () => {
  const harness = makeHarness();
  const { sandbox, makeTexture } = harness;
  const uploads = [], released = [];
  sandbox.NativeHost.render.createMesh = function(_image, vertices) {
    uploads.push(vertices);
    return 500 + uploads.length;
  };
  sandbox.NativeHost.render.releaseMesh = function(handle) { released.push(handle); };
  const root = new sandbox.PIXI.Container();
  const mesh = new sandbox.PIXI.mesh.Mesh(makeTexture(64, 64));
  root.addChild(mesh);
  submitOnly(harness, root);
  mesh.vertices[0] = 17;
  submitOnly(harness, root);
  mesh.vertices = new Float32Array([23, 0, 10, 0, 0, 10]);
  submitOnly(harness, root);
  assert.deepEqual(uploads.map(vertices => vertices[0]), [0, 17, 23]);
  assert.deepEqual(released, [501, 502]);
  assert.equal(mesh.dirty, 0);
  assert.equal(mesh.indexDirty, 0);

});

test('PMJS mesh post-tint overlay changes scene state on ordinary meshes', () => {
  const harness = makeHarness();
  const { sandbox, makeTexture } = harness;
  const root = new sandbox.PIXI.Container();
  const mesh = new sandbox.PIXI.mesh.Mesh(makeTexture(64, 64));
  mesh._blendColor = [255, 64, 0, 128];
  root.addChild(mesh);
  assert.equal(submitOnly(harness, root).metadata[7 + 5] & 512, 0);
  sandbox.PMJS.pixi4.setMeshPostTintOverlay(mesh, [255, 64, 0, 128]);
  const packet = submitOnly(harness, root);
  assert.equal(packet.metadata[7 + 5] & 512, 512);
  assert.equal(packet.metadata[7 + 5] & 16, 0);
  const overlay = packet.values.slice(41 + 37, 41 + 41);
  assert.equal(overlay[0], 1);
  assert.ok(Math.abs(overlay[1] - 64 / 255) < 0.000001);
  assert.equal(overlay[2], 0);
  assert.ok(Math.abs(overlay[3] - 128 / 255) < 0.000001);
  sandbox.PMJS.pixi4.setMeshPostTintOverlay(mesh, [255, 64, 0, 64]);
  const next = submitOnly(harness, root);
  assert.ok(Math.abs(next.values[41 + 40] - 64 / 255) < 0.000001);
});

test('Pixi mesh draw modes keep strip and independent triangles distinct', () => {
  const harness = makeHarness();
  const { sandbox, makeTexture } = harness;
  const modes = [];
  sandbox.NativeHost.render.createMesh = function(_image, _vertices, _uvs,
      _indices, drawMode) {
    modes.push(drawMode);
    return 500 + modes.length;
  };
  const root = new sandbox.PIXI.Container();
  const strip = new sandbox.PIXI.mesh.Mesh(makeTexture(64, 64));
  strip.drawMode = sandbox.PIXI.mesh.Mesh.DRAW_MODES.TRIANGLE_MESH;
  const triangles = new sandbox.PIXI.mesh.Mesh(makeTexture(64, 64));
  triangles.drawMode = sandbox.PIXI.mesh.Mesh.DRAW_MODES.TRIANGLES;
  root.addChild(strip);
  root.addChild(triangles);
  submitOnly(harness, root);
  assert.deepEqual(modes, [0, 1]);
});

test('trim, rotation, and scale modes encode sprite variants', () => {
  const harness = makeHarness();
  const { sandbox, sprite, makeTexture } = harness;
  function leafPacket(node) {
    const root = new sandbox.PIXI.Container();
    root.addChild(node);
    return submitOnly(harness, root);
  }
  const trimmed = sprite();
  trimmed.texture.trim = { x: 2, y: 3, width: 20, height: 12 };
  trimmed.texture.orig = { width: 32, height: 32 };
  const trimValues = leafPacket(trimmed).values;
  assert.deepEqual(
    [trimValues[41 + 7], trimValues[41 + 8], trimValues[41 + 13],
      trimValues[41 + 14]],
    [2, 3, 20, 12]);
  const rotated = sprite();
  rotated.texture.rotate = 2;
  assert.equal(leafPacket(rotated).metadata[1 * 7 + 5] & 32, 32);
  const nearest = sprite();
  nearest.texture.baseTexture.scaleMode = 1;
  assert.equal(leafPacket(nearest).metadata[1 * 7 + 5] & 8, 8);
  assert.equal(makeTexture(1, 1).width, 1);
});

test('tone and blend colors ride the sprite record', () => {
  const harness = makeHarness();
  const { sandbox, sprite } = harness;
  const root = new sandbox.PIXI.Container();
  const toned = sprite();
  toned._colorTone = [68, -34, 0, 255];
  toned._blendColor = [255, 0, 0, 128];
  root.addChild(toned);
  const packet = submitOnly(harness, root);
  assert.equal(packet.metadata[1 * 7 + 5] & 16, 16);
  assert.deepEqual(
    [41 + 33, 41 + 34, 41 + 35, 41 + 36, 41 + 37, 41 + 40].map(offset =>
      packet.values[offset]),
    [68, -34, 0, 255, 255, 128].map(value => Math.fround(value / 255)));
});

test('alpha masks travel as filter markers', () => {
  const harness = makeHarness();
  const { sandbox, sprite } = harness;
  const root = new sandbox.PIXI.Container();
  const masked = sprite();
  masked.mask = sprite();
  root.addChild(masked);
  const packet = submitOnly(harness, root);
  assert.deepEqual(harness.counts,
    { filterPlans: 1, rectMasks: 1, alphaMasks: 1 });
  assert.deepEqual(packet.metadata.filter((_, index) => index % 7 === 0),
    [0, 6, 1, 7]);
});

test('nested filter and mask stack both markers', () => {
  const harness = makeHarness();
  const { sandbox, sprite } = harness;
  const root = new sandbox.PIXI.Container();
  const nested = sprite();
  nested._filters = [new sandbox.PIXI.filters.BlurFilter(4, 1)];
  const mask = new sandbox.PIXI.Graphics();
  mask.graphicsData = [{ fill: true, fillColor: 0xffffff, fillAlpha: 1,
    lineWidth: 0, holes: [],
    shape: new sandbox.PIXI.Rectangle(0, 0, 40, 30) }];
  mask._localBounds = { x: 0, y: 0, width: 40, height: 30 };
  nested.mask = mask;
  root.addChild(nested);
  const packet = submitOnly(harness, root);

  assert.deepEqual(harness.counts,
    { filterPlans: 1, rectMasks: 0, alphaMasks: 1 });
  assert.deepEqual(packet.metadata.filter((_, index) => index % 7 === 0),
    [0, 6, 6, 1, 7, 7]);
});

test('forced clip and mask thread through traversal', () => {
  const harness = makeHarness();
  const { sprite } = harness;
  const clipped = directPacket(harness, sprite(),
    { left: 1, top: 2, right: 3, bottom: 4 }, null);
  assert.deepEqual(clipped.kinds, [1]);
  assert.equal(clipped.metadata[0 * 7 + 5] & 1, 1);
  assert.deepEqual(
    [clipped.values[17], clipped.values[18], clipped.values[19],
      clipped.values[20]],
    [1, 2, 3, 4]);
  const masked = directPacket(harness, sprite(), null,
    { handle: 555, transform: [1, 0, 0, 1, 5, 6], frame: [0, 0, 4, 4],
      alpha: 0.5, usesRed: true, rotation: 0, size: [4, 4] });
  assert.deepEqual(masked.kinds, [6, 1, 7]);
  assert.equal(masked.metadata[0 * 7 + 2], 555);
});

test('window children render unclipped like stock WindowLayer', () => {
  const harness = makeHarness();
  const { sandbox, sprite } = harness;
  const layer = new sandbox.WindowLayer();
  const dialog = new sandbox.Window();
  dialog._isWindow = true;
  dialog.visible = true;
  dialog._openness = 255;

  dialog._updateCursor = () => {};
  dialog._updateArrows = () => {};
  dialog._updatePauseSign = () => {};
  dialog._updateContents = () => {};
  dialog.width = 400;
  dialog.height = 150;
  dialog.x = 100;
  dialog.y = 400;
  const bust = sprite();
  bust.x = -60;
  bust.y = -220;
  dialog.addChild(bust);
  layer.addChild(dialog);
  const packet = submitOnly(harness, layer);
  const flags = packet.metadata.filter((_, index) => index % 7 === 5);
  assert.ok(flags.length >= 2);
  for (const flag of flags) {
    assert.equal(flag & 1, 0);
  }
});

test('particle children upload sprite fields without dispatch', () => {  const harness = makeHarness();
  const { sandbox, sprite } = harness;
  const root = new sandbox.PIXI.Container();
  const container = new sandbox.PIXI.particles.ParticleContainer();
  container.addChild(sprite());
  root.addChild(container);
  const packet = submitOnly(harness, root);
  assert.deepEqual(packet.metadata.filter((_, index) => index % 7 === 0),
    [0, 0, 1]);
  assert.deepEqual(harness.counts,
    { filterPlans: 0, rectMasks: 0, alphaMasks: 0 });
});

test('particle children carry tone and blend colors regardless of attachment timing', () => {
  const harness = makeHarness();
  const { sandbox, sprite } = harness;
  const root = new sandbox.PIXI.Container();
  const container = new sandbox.PIXI.particles.ParticleContainer();

  const childBefore = sprite();
  childBefore._colorTone = [68, -34, 0, 255];
  childBefore._blendColor = [255, 0, 0, 128];
  container.addChild(childBefore);

  const childAfter = sprite();
  container.addChild(childAfter);
  childAfter._colorTone = [-100, 50, 0, 64];
  childAfter._blendColor = [0, 255, 0, 64];

  root.addChild(container);
  const packet = submitOnly(harness, root);

  assert.deepEqual(packet.metadata.filter((_, index) => index % 7 === 0),
    [0, 0, 1, 1]);
  assert.equal(packet.metadata[2 * 7 + 5] & 16, 16);
  assert.equal(packet.metadata[3 * 7 + 5] & 16, 16);
  assert.deepEqual(
    [2 * 41 + 33, 2 * 41 + 34, 2 * 41 + 35, 2 * 41 + 36, 2 * 41 + 37, 2 * 41 + 40].map(offset =>
      packet.values[offset]),
    [68, -34, 0, 255, 255, 128].map(value => Math.fround(value / 255)));
  assert.deepEqual(
    [3 * 41 + 33, 3 * 41 + 34, 3 * 41 + 35, 3 * 41 + 36, 3 * 41 + 37, 3 * 41 + 40].map(offset =>
      packet.values[offset]),
    [-100, 50, 0, 64, 0, 64].map(value => Math.fround(value / 255)));
});

test('rect tile layers bypass rejection with retained records', () => {
  const harness = makeHarness();
  const { sandbox, makeTexture } = harness;
  const parent = new sandbox.PIXI.Container();
  parent.animationFrame = 1;
  parent._tileWidth = 48;
  parent._tileHeight = 48;
  const layer = { pointsBuf: new Array(18).fill(0), textures: [makeTexture(32, 32)],
    parent, visible: false, renderable: false, alpha: 0 };
  const root = new sandbox.PIXI.Container();
  root.addChild(parent);
  parent.addChild(layer);
  const packet = submitOnly(harness, root);

  assert.deepEqual(packet.metadata.filter((_, index) => index % 7 === 0),
    [0, 0, 4]);
});

function trySubmitMaskStage(harness, stage) {
  harness.submitted.length = 0;
  harness.compatHits.length = 0;
  const result = harness.sandbox.submitNativeScene(stage);
  return { ok: result === true, packet: harness.submitted[0] || null,
    hits: harness.compatHits.slice() };
}

function alphaMaskGroups(packet) {
  const groups = [];
  for (let index = 0; index < packet.metadata.length; index += 7) {
    if (packet.metadata[index] === 6 && packet.metadata[index + 4] === 3) {
      groups.push(index / 7);
    }
  }
  return groups;
}

function maskSprite(harness, width, height) {
  const { sandbox, makeTexture } = harness;
  const mask = new sandbox.PIXI.Sprite(makeTexture(width || 64, height || 64));
  mask.visible = true;
  return mask;
}

test('nested alpha masks stack without fallback', () => {
  const harness = makeHarness();
  const { sandbox, sprite } = harness;
  const stage = new sandbox.PIXI.Container();
  const maskA = maskSprite(harness);
  const maskB = maskSprite(harness);
  stage.addChild(maskA);
  stage.addChild(maskB);
  const outer = sprite();
  outer.mask = maskA;
  stage.addChild(outer);
  const inner = sprite();
  inner.mask = maskB;
  outer.addChild(inner);
  const result = trySubmitMaskStage(harness, stage);
  assert.equal(result.ok, true);
  assert.deepEqual(result.hits, []);
  assert.equal(alphaMaskGroups(result.packet).length, 2);
});

test('rotated mask node stays on the alpha path', () => {
  const harness = makeHarness();
  const { sandbox, sprite } = harness;
  const stage = new sandbox.PIXI.Container();
  const mask = maskSprite(harness);
  mask.x = 10;
  mask.y = 20;
  mask.transform.updateLocalTransform = function() {
    this.localTransform = { a: 0, b: 1, c: -1, d: 0, tx: 10, ty: 20 };
  };
  stage.addChild(mask);
  const masked = sprite();
  masked.mask = mask;
  stage.addChild(masked);
  const result = trySubmitMaskStage(harness, stage);
  assert.equal(result.ok, true);
  assert.deepEqual(result.hits, []);
  assert.equal(alphaMaskGroups(result.packet).length, 1);
});

test('mask and blur share one node without fallback', () => {
  const harness = makeHarness();
  const { sandbox, sprite } = harness;
  const stage = new sandbox.PIXI.Container();
  const mask = maskSprite(harness);
  stage.addChild(mask);
  const masked = sprite();
  masked.mask = mask;
  masked._filters = [new sandbox.PIXI.filters.BlurFilter(4, 1)];
  stage.addChild(masked);
  const result = trySubmitMaskStage(harness, stage);
  assert.equal(result.ok, true);
  assert.deepEqual(result.hits, []);
  assert.equal(alphaMaskGroups(result.packet).length, 1);
});

test('one mask shared by sibling sprites emits per node', () => {
  const harness = makeHarness();
  const { sandbox, sprite } = harness;
  const stage = new sandbox.PIXI.Container();
  const mask = maskSprite(harness);
  stage.addChild(mask);
  const first = sprite();
  first.mask = mask;
  stage.addChild(first);
  const second = sprite();
  second.mask = mask;
  stage.addChild(second);
  const result = trySubmitMaskStage(harness, stage);
  assert.equal(result.ok, true);
  assert.deepEqual(result.hits, []);
  assert.equal(alphaMaskGroups(result.packet).length, 2);
});

test('mask without pixels hides the node, not the frame', () => {
  const harness = makeHarness();
  const { sandbox, sprite } = harness;
  const stage = new sandbox.PIXI.Container();
  const empty = new sandbox.PIXI.Sprite(null);
  empty.visible = true;
  stage.addChild(empty);
  const masked = sprite();
  masked.mask = empty;
  stage.addChild(masked);
  const result = trySubmitMaskStage(harness, stage);
  assert.equal(result.ok, true);
  assert.equal(result.hits.length, 1);
  assert.equal(result.hits[0][0], 'render.mask');
  assert.equal(alphaMaskGroups(result.packet).length, 0);
});

test('rotated window children render unclipped', () => {
  const harness = makeHarness();
  const { sandbox, sprite } = harness;
  const layer = new sandbox.WindowLayer();
  const dialog = new sandbox.Window();
  dialog._isWindow = true;
  dialog.visible = true;
  dialog._openness = 255;
  dialog._updateCursor = () => {};
  dialog._updateArrows = () => {};
  dialog._updatePauseSign = () => {};
  dialog._updateContents = () => {};
  dialog.width = 400;
  dialog.height = 150;
  dialog.x = 100;
  dialog.y = 400;
  dialog.transform.updateLocalTransform = function() {
    this.localTransform = { a: 0, b: 1, c: -1, d: 0, tx: 100, ty: 400 };
  };
  const bust = sprite();
  bust.x = -60;
  bust.y = -220;
  dialog.addChild(bust);
  layer.addChild(dialog);
  const packet = submitOnly(harness, layer);
  const flags = packet.metadata.filter((_, index) => index % 7 === 5);
  assert.ok(flags.length >= 2);
  for (const flag of flags) {
    assert.equal(flag & 1, 0);
  }
  assert.equal(alphaMaskGroups(packet).length, 0);
});

test('rectangular mask with colorMatrix filter preserves scissor and avoids alphaMask', () => {
  const harness = makeHarness();
  const { sandbox, sprite } = harness;
  const stage = new sandbox.PIXI.Container();
  const masked = sprite();
  const mask = new sandbox.PIXI.Graphics();
  mask.graphicsData = [{ fill: true, fillColor: 0xffffff, fillAlpha: 1,
    lineWidth: 0, holes: [],
    shape: new sandbox.PIXI.Rectangle(0, 0, 100, 50) }];
  mask._localBounds = { x: 0, y: 0, width: 100, height: 50 };
  masked.mask = mask;

  const matrix = [
    0.5, 0, 0, 0, 0,
    0, 0.5, 0, 0, 0,
    0, 0, 0.5, 0, 0,
    0, 0, 0, 1, 0
  ];
  masked._filters = [new sandbox.PIXI.filters.ColorMatrixFilter(matrix)];
  stage.addChild(masked);
  const packet = submitOnly(harness, stage);

  assert.deepEqual(harness.counts,
    { filterPlans: 1, rectMasks: 1, alphaMasks: 0 });

  assert.deepEqual(packet.metadata.filter((_, index) => index % 7 === 0),
    [0, 6, 1, 7]);

  assert.equal(packet.metadata[1 * 7 + 4], 25);

  assert.equal(packet.metadata[2 * 7 + 5] & 1, 1);

  assert.equal(alphaMaskGroups(packet).length, 0);
});

test('rectangular mask with colorMatrix acquiring alpha (m19 !== 0) stays on alphaMask path', () => {
  const harness = makeHarness();
  const { sandbox, sprite } = harness;
  const stage = new sandbox.PIXI.Container();
  const masked = sprite();
  const mask = new sandbox.PIXI.Graphics();
  mask.graphicsData = [{ fill: true, fillColor: 0xffffff, fillAlpha: 1,
    lineWidth: 0, holes: [],
    shape: new sandbox.PIXI.Rectangle(0, 0, 100, 50) }];
  mask._localBounds = { x: 0, y: 0, width: 100, height: 50 };
  masked.mask = mask;

  const matrix = [
    1, 0, 0, 0, 0,
    0, 1, 0, 0, 0,
    0, 0, 1, 0, 0,
    0, 0, 0, 1, 0.5
  ];
  masked._filters = [new sandbox.PIXI.filters.ColorMatrixFilter(matrix)];
  stage.addChild(masked);
  const packet = submitOnly(harness, stage);

  assert.deepEqual(harness.counts,
    { filterPlans: 1, rectMasks: 0, alphaMasks: 1 });

  assert.deepEqual(packet.metadata.filter((_, index) => index % 7 === 0),
    [0, 6, 6, 1, 7, 7]);
  assert.equal(alphaMaskGroups(packet).length, 1);
});

test('disjoint clip intersection normalizes to a zero-area clip without rejection', () => {
  const harness = makeHarness();
  const { sprite } = harness;
  const stage = sprite();
  const leftClip = { left: 0, top: 0, right: 50, bottom: 50 };
  const rightClip = { left: 100, top: 100, right: 150, bottom: 150 };
  const intersected = harness.sandbox.nativeIntersectClip(leftClip, rightClip);
  assert.equal(intersected.left, 100);
  assert.equal(intersected.top, 100);
  assert.equal(intersected.right, 100);
  assert.equal(intersected.bottom, 100);

  const packet = directPacket(harness, stage, intersected, null);
  assert.equal(packet.metadata[0 * 7 + 5] & 1, 1);
  assert.deepEqual(
    [packet.values[17], packet.values[18], packet.values[19], packet.values[20]],
    [100, 100, 100, 100]);
});

test('registry disable selects ordinary sprite encoding with the same packet', () => {
  const harness = makeHarness();
  const { sandbox, sprite } = harness;
  const root = new sandbox.PIXI.Container();
  for (let i = 0; i < 6; i++) {
    const child = sprite(16 + i, 24 + i);
    child.x = i * 7;
    child.y = i * 3;
    child.alpha = 0.5 + i * 0.05;
    child.tint = 0xabcdef;
    root.addChild(child);
  }
  const optimized = submitOnly(harness, root);
  assert.equal(sandbox.nativeSceneSegmentStats.runs, 1);
  assert.equal(sandbox.nativeSceneSegmentStats.sprites, 6);
  sandbox.PMJS.optimizations.isEnabled = id => id !== 'scene.plain-sprite-segment';
  const ordinary = submitOnly(harness, root);
  assert.equal(sandbox.nativeSceneSegmentStats.runs, 1);
  assert.deepEqual(ordinary, optimized);
});

test('sprite segments preserve Text preparation and later text changes', () => {
  const harness = makeHarness();
  const { sandbox, sprite, makeTexture } = harness;
  class Text extends sandbox.PIXI.Sprite {
    constructor() {
      super(makeTexture(8, 8));
      this.resolution = 1;
      this.dirty = true;
      this.nextTexture = makeTexture(40, 16);
      this.prepared = [];
    }
    updateText(respectDirty) {
      this.prepared.push([this.resolution, this.dirty, respectDirty]);
      if (this.dirty) this.texture = this.nextTexture;
      this.dirty = false;
    }
  }
  sandbox.PIXI.Text = Text;
  const root = new sandbox.PIXI.Container();
  const label = new Text();
  root.addChild(label);
  for (let i = 0; i < 4; i++) root.addChild(sprite());
  sandbox.nativeSceneFilterResolution = 2;
  let packet = submitOnly(harness, root);
  assert.deepEqual(label.prepared, [[2, true, true]]);
  assert.equal(packet.metadata[7 + 2], label.nextTexture.baseTexture.source._nativeImage.handle);
  assert.equal(packet.values[41 + 13], 40);
  assert.equal(sandbox.nativeSceneSegmentStats.sprites, 4);

  label.nextTexture = makeTexture(72, 16);
  label.dirty = true;
  packet = submitOnly(harness, root);
  assert.equal(label.prepared.length, 2);
  assert.equal(packet.values[41 + 13], 72);
  sandbox.PMJS.optimizations.isEnabled = id => id !== 'scene.plain-sprite-segment';
  assert.deepEqual(submitOnly(harness, root), packet);
});

test('sprite segments honor bitmap cache activation and removal', () => {
  const harness = makeHarness();
  const { sandbox, sprite } = harness;
  const root = new sandbox.PIXI.Container();
  const cached = root.addChild(sprite(16, 16));
  for (let i = 0; i < 4; i++) root.addChild(sprite());
  submitOnly(harness, root);
  const snapshot = sprite(64, 48);
  cached._cacheAsBitmap = true;
  cached._cacheData = { sprite: snapshot };
  const packet = submitOnly(harness, root);
  const handles = packet.metadata.filter((_, index) => index % 7 === 2);
  assert.ok(handles.includes(snapshot.texture.baseTexture.source._nativeImage.handle));
  assert.ok(!handles.includes(cached.texture.baseTexture.source._nativeImage.handle));
  sandbox.PMJS.optimizations.isEnabled = id => id !== 'scene.plain-sprite-segment';
  assert.deepEqual(submitOnly(harness, root), packet);
  cached._cacheAsBitmap = false;
  const ordinary = submitOnly(harness, root);
  sandbox.PMJS.optimizations.isEnabled = () => true;
  assert.deepEqual(submitOnly(harness, root), ordinary);
});

test('sprite segments preserve later before-render hooks and their order', () => {
  const harness = makeHarness();
  const { sandbox, sprite } = harness;
  const root = new sandbox.PIXI.Container();
  for (let i = 0; i < 5; i++) root.addChild(sprite());
  submitOnly(harness, root);
  const visited = [];
  sandbox.__pmjsBeforeRenderNode = node => {
    visited.push(node);
    node.x = visited.length * 3;
  };
  const packet = submitOnly(harness, root);
  assert.deepEqual(visited.map(node => [root, ...root.children].indexOf(node)),
    [0, 1, 2, 3, 4, 5]);
  for (let i = 0; i < 6; i++) assert.equal(packet.values[i * 41 + 4], (i + 1) * 3);
  visited.length = 0;
  sandbox.PMJS.optimizations.isEnabled = id => id !== 'scene.plain-sprite-segment';
  assert.deepEqual(submitOnly(harness, root), packet);
  assert.deepEqual(visited.map(node => [root, ...root.children].indexOf(node)),
    [0, 1, 2, 3, 4, 5]);
});

test('scene submission asks the video owner for diagnostics only on failure', () => {
  const harness = makeHarness();
  const { sandbox, sprite } = harness;
  const root = new sandbox.PIXI.Container();
  root.addChild(sprite());
  const snapshot = [{ media: 7, image: 8, readyState: 4, paused: false }];
  let requests = 0;
  sandbox.PMJS.web = { video: { diagnostics() { requests++; return snapshot; } } };
  const errors = [];
  sandbox.console = { log() {}, error(message) { errors.push(message); } };
  sandbox.renderNativeStage(root, undefined, undefined, undefined, false, null, sandbox.PMJS.pixi4.getStageRenderOptions(root));
  assert.equal(requests, 0);
  const error = new Error('native submission failed');
  sandbox.NativeHost.scene.submit = () => { throw error; };
  assert.throws(() => sandbox.renderNativeStage(root), thrown => thrown === error);
  assert.equal(requests, 1);
  assert.ok(errors[0].endsWith('videos=' + JSON.stringify(snapshot)));
});


test('retained triangle material leaves scene fields available and can be cleared', () => {
  const harness = makeHarness();
  const { sandbox, makeTexture } = harness;
  const root = new sandbox.PIXI.Container();
  const mesh = new sandbox.PIXI.mesh.Mesh(makeTexture(64, 64));
  const paint = [0, 0, 12, 0, 0, 12, -2, -2, 14, 14, 1, 1, 1, 0.5, 4, 10];
  setTriangleBitmap(sandbox, mesh, paint);
  sandbox.PMJS.pixi4.retainMeshGeometry(mesh);
  root.addChild(mesh);
  const first = submitOnly(harness, root);
  assert.equal(first.metadata[12] & 1024, 0);
  assert.equal(mesh._pmjsMppTriangleBitmap.length, 30);
  const resource = first.metadata[9];
  sandbox.PMJS.pixi4.setMeshPostTintOverlay(mesh, [255, 0, 0, 128]);
  const flashed = submitOnly(harness, root);
  assert.equal(flashed.metadata[9], resource);
  assert.equal(flashed.metadata[12] & (1024 | 512), 512);
  sandbox.PMJS.plugins.mpp.setTriangleBitmap(mesh, null);
  assert.equal(mesh._pmjsMppTriangleBitmap, undefined);
  const cleared = submitOnly(harness, root);
  assert.notEqual(cleared.metadata[9], resource);
  assert.throws(() => setTriangleBitmap(sandbox, mesh, [NaN]), /finite points/);
});


test('MV bitmap flash retains its material and rejects ambiguous generic overlays', () => {
  const harness = makeHarness();
  const { sandbox, makeTexture } = harness;
  const root = new sandbox.PIXI.Container();
  const mesh = new sandbox.PIXI.mesh.Mesh(makeTexture(64, 64));
  sandbox.PMJS.pixi4.retainMeshGeometry(mesh);
  root.addChild(mesh);
  sandbox.PMJS.mv.setBitmapMeshBlend(mesh, [0, 0, 0, 0], [2, 3, 15, 20]);
  const first = submitOnly(harness, root);
  sandbox.PMJS.mv.setBitmapMeshBlend(mesh, [255, 0, 0, 128]);
  const flashed = submitOnly(harness, root);
  assert.equal(flashed.metadata[9], first.metadata[9]);
  assert.equal(flashed.metadata[12] & (512 | 16384), 16384);
  assert.throws(() => sandbox.PMJS.pixi4.setMeshPostTintOverlay(mesh, [255, 0, 0, 128]), /MV blend operation/);
  sandbox.PMJS.mv.setBitmapMeshBlend(mesh, null);
  const cleared = submitOnly(harness, root);
  assert.equal(cleared.metadata[12] & 512, 0);
  assert.equal(cleared.metadata[9], first.metadata[9]);
});

test('Pixi owns exactly one specialized mesh material claim', () => {
  const { sandbox, makeTexture } = makeHarness();
  const mesh = new sandbox.PIXI.mesh.Mesh(makeTexture(64, 64));
  const paint = [0, 0, 12, 0, 0, 12, -2, -2, 14, 14, 1, 1, 1, 0.5, 4, 10];
  setTriangleBitmap(sandbox, mesh, paint);
  assert.equal(sandbox.PMJS.pixi4.meshNativeMaterialOwner(mesh), 'mpp-triangle-bitmap');
  assert.throws(() => sandbox.PMJS.mv.setBitmapMeshBlend(mesh, [255, 0, 0, 128],
    [2, 3, 15, 20]), /owned by mpp-triangle-bitmap/);
  assert.equal(sandbox.PMJS.mv.hasBitmapMesh(mesh), false, 'rejected MV claim leaves no MV state');
  sandbox.PMJS.plugins.mpp.setTriangleBitmap(mesh, null);
  assert.equal(sandbox.PMJS.pixi4.meshNativeMaterialOwner(mesh), null);
  sandbox.PMJS.mv.setBitmapMeshBlend(mesh, [255, 0, 0, 128], [2, 3, 15, 20]);
  assert.equal(sandbox.PMJS.pixi4.meshNativeMaterialOwner(mesh), 'mv-bitmap');
  assert.throws(() => setTriangleBitmap(sandbox, mesh, paint), /owned by mv-bitmap/);
  assert.throws(() => sandbox.PMJS.plugins.mpp.setTriangleBitmap(mesh, null), /owned by mv-bitmap/);
  assert.equal(mesh._pmjsMppTriangleBitmap, undefined, 'rejected MPP claim leaves no MPP state');
  assert.throws(() => sandbox.PMJS.pixi4.setMeshNativeMaterial(mesh, 'unknown', {}), /Unknown mesh material owner/);
});

test('background fill is explicit per scene submission and never persists into offscreen encoding', () => {
  const harness = makeHarness();
  const root = new harness.sandbox.PIXI.Container();
  harness.sandbox.submitNativeScene(root, 0);
  assert.equal(harness.submitted[0].metadata[0], 3, 'black screen clear is an opaque fill');
  harness.sandbox.submitNativeScene(root);
  assert.equal(harness.submitted[1].metadata[0], 0, 'offscreen submission starts with content');
  harness.sandbox.submitNativeScene(root, 0x102030);
  assert.equal(harness.submitted[2].metadata[0], 3, 'following screen can explicitly clear');
  assert.equal(harness.submitted[2].metadata[3], 0x102030);
});


test('triangle stroke coverage is retained material state with validated sample count', () => {
  const { sandbox, makeTexture } = makeHarness();
  const mesh = new sandbox.PIXI.mesh.Mesh(makeTexture(64, 64));
  const paint = [0, 0, 12, 0, 0, 12, -2, -2, 14, 14, 1, 1, 1, 0.5, 4, 10];
  setTriangleBitmap(sandbox, mesh, paint);
  const bevels = mesh._pmjsMppTriangleBitmap[29];
  setTriangleBitmap(sandbox, mesh, paint, { strokeSamples: 4 });
  assert.equal(mesh._pmjsMppTriangleBitmap[29], bevels | 8);
  assert.equal(mesh._pmjsMppTriangleBitmap.length, 30);
  setTriangleBitmap(sandbox, mesh, paint, { strokeSamples: 0 });
  assert.equal(mesh._pmjsMppTriangleBitmap[29], bevels);
  setTriangleBitmap(sandbox, mesh, paint,
    { strokeSamples: 4, clipCoverage: 'canvas-crop' });
  assert.equal(mesh._pmjsMppTriangleBitmap[29], bevels | 24);
  for (const clipCoverage of ['unknown', null, '']) {
    assert.throws(() => setTriangleBitmap(sandbox, mesh, paint, { clipCoverage }),
      /Triangle clip coverage/);
  }
  for (const strokeSamples of [2, NaN, null]) {
    assert.throws(() => setTriangleBitmap(sandbox, mesh, paint, { strokeSamples }),
      /Triangle stroke samples/);
  }
});

test('Sprite world hooks and packed color are consumed before Float32 scene serialization', () => {
  const harness = makeHarness(), { sandbox, sprite } = harness;
  Object.defineProperty(sandbox.PIXI.Container.prototype, 'worldTransform', {
    get() { return this.transform.worldTransform; } });
  sandbox.PIXI.Sprite.prototype.updateTransform = function() {
    this.transformCalls = (this.transformCalls || 0) + 1;
    this.worldTransform.tx = Math.floor(this.x); this.worldTransform.ty = Math.floor(this.y);
    this.worldAlpha = this.parent.worldAlpha * this.alpha;
  };
  const root = new sandbox.PIXI.Container(); root.worldAlpha = 1;
  sandbox.PMJS.pixi4.setStageRenderOptions(root, {worldState:'pixi'});
  root.updateTransform = function() { this.children.forEach(child => child.updateTransform()); };
  for (let index = 0; index < 5; index++) {
    const child = sprite(); child.x = 90.75; child.y = -28.55;
    child.alpha = 0.19999999999999996; child.texture.baseTexture.__pmjsPremultiplied = true;
    root.addChild(child);
  }
  sandbox.renderNativeStage(root, undefined, undefined, undefined, false, null, sandbox.PMJS.pixi4.getStageRenderOptions(root));
  const packet = harness.submitted.at(-1);
  for (let index = 1; index <= 5; index++) {
    assert.equal(packet.values[index * 41 + 4], 90);
    assert.equal(packet.values[index * 41 + 5], -29);
    assert.equal(packet.metadata[index * 7 + 3], 0x32333333);
    assert.equal(packet.metadata[index * 7 + 5] & 3072, 3072);
  }
  assert.equal(root.children[0].x, 90.75);
  for (const child of root.children) assert.equal(child.transformCalls, 1);
  sandbox.renderNativeStage(root, undefined, undefined, undefined, true);
  for (const child of root.children) assert.equal(child.transformCalls, 1);
  const skipped = harness.submitted.at(-1);
  for (let index = 1; index <= 5; index++) {
    assert.equal(skipped.values[index * 41 + 4], 90);
    assert.equal(skipped.values[index * 41 + 5], -29);
    assert.equal(skipped.metadata[index * 7 + 3], 0x32333333);
  }
});


test('Sprite vertex packets preserve Pixi Float32 corners and logical GPU bitmap views', () => {
  const harness = makeHarness(), { sandbox, sprite } = harness;
  Object.defineProperty(sandbox.PIXI.Container.prototype, 'worldTransform', {
    get() { return this.transform.worldTransform; } });
  sandbox.PIXI.Sprite.prototype.updateTransform = function() { this.worldAlpha = this.alpha; };
  const vertices = new Float32Array([3.125, 4.375, 19.75, 5.5, 18.25, 23.625, 1.625, 22.5]);
  sandbox.PIXI.Sprite.prototype.calculateVertices = function() { this.vertexData = vertices; };
  const root = new sandbox.PIXI.Container();
  sandbox.PMJS.pixi4.setStageRenderOptions(root, {worldState:'pixi'});
  root.updateTransform = function() { this.children.forEach(child => child.updateTransform()); };
  for (let index = 0; index < 5; index++) {
    const child = sprite(); child.texture.baseTexture.__pmjsPremultiplied = true;
    child.texture.__pmjsStandaloneBitmapRegion = true;
    root.addChild(child);
  }
  sandbox.renderNativeStage(root, undefined, undefined, undefined, false, null, sandbox.PMJS.pixi4.getStageRenderOptions(root));
  const packet = harness.submitted.at(-1);
  for (let index = 1; index <= 5; index++) {
    const offset = index * 41;
    assert.deepEqual(Array.from(packet.values.slice(offset, offset + 6)), Array.from(vertices.slice(0, 6)));
    assert.deepEqual(Array.from(packet.values.slice(offset + 15, offset + 17)), Array.from(vertices.slice(6)));
    assert.equal(packet.metadata[index * 7 + 5] & 12288, 12288);
  }
});


test('stock transform scenes retain the native transform path', () => {
  const harness = makeHarness(), { sandbox, sprite } = harness;
  const root = new sandbox.PIXI.Container(); root.addChild(sprite());
  let transforms = 0;
  root.updateTransform = () => { transforms++; };
  sandbox.renderNativeStage(root, undefined, undefined, undefined, false, null, sandbox.PMJS.pixi4.getStageRenderOptions(root));
  assert.equal(transforms, 0);
  assert.equal(harness.submitted.at(-1).metadata[12] & 4096, 0);
});

test('bitmap bake and clear share quantized triangle coefficient construction', () => {
  const harness = makeHarness(), { sandbox } = harness;
  const coordinates = [0.123456789, 0.987654321, 21.23456789, 2.3456789, 4.567891, 19.87654321];
  const material = sandbox.nativeTrianglePaintParameters(coordinates.concat([-1,-1,30,30,1,1,1,.5,4,10]), 4, 'canvas-crop');
  assert.deepEqual(Array.from(material.slice(16,22)),
    Array.from(sandbox.nativeTriangleClipNormals(Float32Array.from(coordinates))));
});


test('skipped Sprite world vertices receive the explicit render root transform once', () => {
  const harness = makeHarness(), { sandbox, sprite } = harness;
  const child = sprite(); child.worldAlpha = 0.5;
  const vertices = new Float32Array([3.125,4.375,19.75,5.5,18.25,23.625,1.625,22.5]);
  child.calculateVertices = function() { this.vertexData = vertices; };
  let updates = 0;
  const root = new sandbox.PIXI.Container(); root.addChild(child);
  root.updateTransform = () => { updates++; };
  const transform = {a:2,b:0.25,c:-0.5,d:3,tx:11,ty:-7};
  sandbox.renderNativeStage(root, transform, 2, false, true);
  const packet = harness.submitted.at(-1);
  for (let corner = 0; corner < 4; corner++) {
    const x=vertices[corner*2], y=vertices[corner*2+1], offset=41+(corner<3?corner*2:15);
    assert.equal(packet.values[offset], Math.fround(2*x-.5*y+11));
    assert.equal(packet.values[offset+1], Math.fround(.25*x+3*y-7));
  }
  assert.equal(updates,0);
  assert.deepEqual(Array.from(vertices), [3.125,4.375,19.75,5.5,18.25,23.625,1.625,22.5]);
  assert.equal(packet.metadata[12]&4096,4096);
});


test('a global guest Sprite transform hook does not force unrelated scenes onto Pixi traversal', () => {
  const harness = makeHarness(), { sandbox, sprite } = harness;
  sandbox.Sprite = function() {};
  sandbox.Sprite.prototype.updateTransform = function() {};
  sandbox.PIXI.Sprite.prototype.updateTransform = function() {};
  const scene = new sandbox.PIXI.Container(); scene.addChild(sprite());
  let calls=0; scene.updateTransform=()=>{calls++;};
  sandbox.renderNativeStage(scene, undefined, undefined, undefined, false, null, sandbox.PMJS.pixi4.getStageRenderOptions(scene));
  assert.equal(calls,0);
  sandbox.PMJS.pixi4.setStageRenderOptions(scene, {worldState:'pixi'});
  sandbox.renderNativeStage(scene, undefined, undefined, undefined, false, null, sandbox.PMJS.pixi4.getStageRenderOptions(scene));
  assert.equal(calls,1);
});
