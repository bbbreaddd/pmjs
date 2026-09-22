'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const WRITER_SOURCES = ['js/pmjs-pixi4/render-preflight.js',
  'js/pmjs-pixi4/scene-primitives.js',
  'js/pmjs-pixi4/scene-filters.js', 'js/pmjs-pixi4/scene-packet.js',
  'js/pmjs-mv/render-prepare.js',
  'js/pmjs-pixi4/scene-prepare.js', 'js/pmjs-pixi4/scene-classify.js',
  'js/pmjs-pixi4/scene-encoders.js', 'js/pmjs-pixi4/scene-effects.js'];

function loadWriterSources() {
  return WRITER_SOURCES.map(relative =>
    fs.readFileSync(path.join(__dirname, '..', relative), 'utf8')).join('\n');
}

function makeHarness() {
  let nextHandle = 100;
  const compatHits = [];
  const compatObserved = [];
  const hitCounts = Object.create(null);
  const submitted = [];
  const counts = { filterPlans: 0, rectMasks: 0, alphaMasks: 0 };

  class Transform {
    constructor() {
      this.localTransform = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };
      const world = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };
      world.identity = function() {
        world.a = 1; world.b = 0; world.c = 0; world.d = 1;
        world.tx = 0; world.ty = 0;
      };
      this.worldTransform = world;
    }
    updateLocalTransform() {
      const owner = this.owner;
      this.localTransform = { a: 1, b: 0, c: 0, d: 1,
        tx: (owner && owner.x) || 0, ty: (owner && owner.y) || 0 };
    }
  }
  class Container {
    constructor() {
      this.children = []; this.visible = true; this.renderable = true;
      this.alpha = 1; this.x = 0; this.y = 0; this.parent = null;
      this.transform = new Transform(); this.transform.owner = this;
      this.tint = 0xffffff; this.blendMode = 0;
    }
    addChild(child) {
      child.parent = this; this.children.push(child); return child;
    }
  }
  class Sprite extends Container {
    constructor(texture) {
      super(); this.texture = texture || null;
      this.anchor = { x: 0, y: 0 };
    }
  }
  class Graphics extends Container {
    constructor() {
      super(); this.graphicsData = []; this.dirty = 0; this.boundsPadding = 0;
      this._localBounds = { x: 0, y: 0, width: 0, height: 0 };
    }
    getBounds() { return this._localBounds; }
    getLocalBounds() { return this._localBounds; }
  }
  class Rectangle {
    constructor(x, y, width, height) {
      this.type = 1; this.x = x; this.y = y;
      this.width = width; this.height = height;
    }
  }
  class TilingSprite extends Container {
    constructor(texture, width, height) {
      super(); this.texture = texture; this.width = width; this.height = height;
      this.anchor = { x: 0, y: 0 }; this.tileScale = { x: 1, y: 1 };
      this.tilePosition = { x: 0, y: 0 }; this.origin = null;
    }
  }
  class Mesh extends Container {
    constructor(texture) {
      super(); this.texture = texture;
      this.vertices = new Float32Array([0, 0, 10, 0, 0, 10]);
      this.uvs = new Float32Array([0, 0, 1, 0, 0, 1]);
      this.indices = new Uint16Array([0, 1, 2]);
      this.drawMode = 0; this.dirty = 0; this.indexDirty = 0; this.vertexDirty = 0;
    }
  }
  Mesh.DRAW_MODES = { TRIANGLE_MESH: 0 };
  class ParticleContainer extends Container {
    constructor() {
      super();
      this._maxSize = 10; this._batchSize = 16384;
      this._properties = [false, true, false, false, false];
      this._bufferUpdateIDs = [0]; this._updateID = 1;
    }
  }
  class ScreenSprite extends Container {
    constructor() {
      super(); this._red = 10; this._green = 20; this._blue = 30;
    }
  }

  class Tilemap extends Container {}
  class Window extends Container {}
  class WindowLayer extends Container {}
  class BlurFilter {
    constructor(blur, quality) {
      this.blur = blur; this.quality = quality || 1; this.enabled = true;
    }
  }
  class ColorMatrixFilter {
    constructor(matrix) {
      this.matrix = matrix || [
        1, 0, 0, 0, 0,
        0, 1, 0, 0, 0,
        0, 0, 1, 0, 0,
        0, 0, 0, 1, 0
      ];
      this.alpha = 1;
      this.enabled = true;
    }
  }

  function makeTexture(width, height) {
    const handle = nextHandle++;
    const source = { _nativeImage: { handle }, width, height };
    const baseTexture = { source, resolution: 1, scaleMode: 0, width, height };
    const frame = { x: 0, y: 0, width, height };
    return { baseTexture, _frame: frame, frame, orig: frame, trim: null,
      rotate: 0, _updateID: 1, width, height };
  }

  function canvas2d() {
    return { resetTransform() {}, clearRect() {}, translate() {},
      beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, rect() {},
      arc() {}, fill() {}, stroke() {}, drawImage() {}, fillRect() {},
      set fillStyle(v) {}, set globalAlpha(v) {}, set lineWidth(v) {},
      set strokeStyle(v) {} };
  }
  class CanvasElement {
    constructor() { this.width = 0; this.height = 0; this._h = nextHandle++; }
    getContext() { return canvas2d(); }
    _ensureNativeCanvas() { return { handle: this._h }; }
    _releaseNativeCanvas() {}
  }

  const sandbox = {
    console, Math, Number, String, Array, Object, Float32Array, Uint32Array,
    Uint8ClampedArray, Uint16Array, JSON, Error, WeakMap,
    PIXI: { Container, Sprite, Graphics, Rectangle,
      extras: { TilingSprite }, mesh: { Mesh },
      particles: { ParticleContainer }, tilemap: {},
      SCALE_MODES: { LINEAR: 0, NEAREST: 1 },
      filters: { BlurFilter, ColorMatrixFilter }, DisplayObject: Container,
      Texture: { EMPTY: null } },
    ScreenSprite, Tilemap, Window, WindowLayer, CanvasElement,
    PMJS: { compat: { dump: () => ({ ...hitCounts }),
      count: prefix => Object.entries(hitCounts).reduce((total, [kind, count]) =>
        total + (!prefix || kind.startsWith(prefix) ? count : 0), 0),
      hit: (...args) => sandbox.nativeCompatibilityHit(...args),
      observed: (...args) => sandbox.nativeCompatibilityObserved(...args) },
      optimizations: { isEnabled: () => true } },
    nativeCompatibilityHits: hitCounts,
    nativeCompatibilityHit(kind, detail) {
      compatHits.push([kind, String(detail)]);
      hitCounts[kind] = (hitCounts[kind] || 0) + 1;
    },
    nativeCompatibilityObserved(kind, detail) {
      compatObserved.push([kind, String(detail)]);
    },
    NativeHost: {
      scene: { schema: { version: 1, metadataStride: 7, valueStride: 41,
          transactionalSubmit: true },
        packetVersion: 1,
        submit(version, metadata, values, count) {
          submitted.push({ version, count,
            metadata: Array.from(metadata.slice(0, count * 7)),
            values: Array.from(values.slice(0, count * 41)) });
        } },
      render: { createMesh() { return nextHandle++; }, releaseMesh() {},
        createTileLayer() { return nextHandle++; }, releaseTileLayer() {} },
      canvas: {},
      runtime: { env() { return undefined; } }
    }
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(loadWriterSources(), sandbox,
    { filename: 'scene-writer.js' });
  const filterPlanner = sandbox.nativeSceneFilter;
  sandbox.nativeSceneFilter = function(node, filters) {
    counts.filterPlans++;
    return filterPlanner(node, filters);
  };
  const rectMask = sandbox.nativeRectangleMask;
  sandbox.nativeRectangleMask = function(mask) {
    counts.rectMasks++;
    return rectMask(mask);
  };
  const alphaMask = sandbox.nativeAlphaMask;
  sandbox.nativeAlphaMask = function(mask) {
    counts.alphaMasks++;
    return alphaMask(mask);
  };
  function sprite(width, height) {
    return new sandbox.PIXI.Sprite(makeTexture(width || 32, height || 32));
  }
  return { sandbox, submitted, compatHits, compatObserved, counts, makeTexture, sprite };
}

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
  sandbox.renderNativeStage(root);
  assert.equal(sandbox.renderNativeStage._framesTotal, 1);
  assert.equal(sandbox.renderNativeStage._framesDegraded || 0, 0);
  const filtered = sprite();
  filtered._filters = [{ enabled: true }];
  root.addChild(filtered);
  sandbox.renderNativeStage(root);
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

test('custom render hooks do not affect native encoding', () => {
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
  assert.deepEqual(harness.compatHits, []);
  assert.deepEqual(harness.submitted[0].metadata.filter((_, index) => index % 7 === 0),
    [0, 1, 1]);
  root.children.length = 0;
  harness.submitted.length = 0;
  const instance = sprite();
  instance.renderWebGL = function() {};
  root.addChild(instance);
  assert.equal(sandbox.submitNativeScene(root), true);
  assert.deepEqual(harness.compatHits, []);
  assert.deepEqual(harness.submitted[0].metadata.filter((_, index) => index % 7 === 0),
    [0, 1]);
});

test('late prototype patches do not affect native encoding', () => {
  const harness = makeHarness();
  const { sandbox, sprite } = harness;
  const root = new sandbox.PIXI.Container();
  const stock = sprite();
  root.addChild(stock);
  submitOnly(harness, root);
  sandbox.PIXI.Sprite.prototype._renderWebGL = function() {};
  assert.equal(sandbox.submitNativeScene(root), true);
  assert.deepEqual(harness.compatHits, []);
  assert.deepEqual(harness.submitted[harness.submitted.length - 1].metadata
    .filter((_, index) => index % 7 === 0), [0, 1]);
});

test('plain sprite segments ignore render hooks', () => {
  const harness = makeHarness();
  const { sandbox, sprite } = harness;
  const root = new sandbox.PIXI.Container();
  for (let index = 0; index < 5; index++) root.addChild(sprite());
  root.children[3]._renderWebGL = function() {};
  sandbox.nativePlainSpriteSegmentsEnabled = true;
  assert.equal(sandbox.submitNativeScene(root), true);
  assert.deepEqual(harness.compatHits, []);
  assert.deepEqual(harness.submitted[0].metadata.filter((_, index) => index % 7 === 0),
    [0, 1, 1, 1, 1, 1]);
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
  source.__pmjsContentRevision = 4;
  source.__pmjsMaskProof = { kind: 'constant-mask-rect', x: 0, y: 0,
    width: 100, height: 92, weight: 1, revision: 4 };
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
    source.__pmjsContentRevision = 2;
    source.__pmjsMaskProof = { kind: 'constant-mask-rect', x: 0, y: 0,
      width: 100, height: 92, weight: 1, revision: 2 };
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
  source.__pmjsContentRevision = 3;
  source.__pmjsMaskProof = { kind: 'constant-mask-rect', x: 0, y: 0,
    width: 100, height: 92, weight: 1, revision: 3 };
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
  source.__pmjsContentRevision = 1;
  source.__pmjsMaskProof = { kind: 'constant-mask-rect', x: 0, y: 0,
    width: 100, height: 92, weight: 1, revision: 1 };
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
    _paintAllTiles() { this.fullRepaints = (this.fullRepaints || 0) + 1; }
  });

  sandbox.prepare(node);

  assert.equal(node.fullRepaints, 1);
  assert.equal(node._lastAnimationFrame, 2);
  assert.equal(node._frameUpdated, true);
  assert.equal(sandbox.nativeTileRebuilds, 1);
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
  sandbox.renderNativeStage(root);
  assert.equal(harness.submitted.length, 1);
  assert.equal(sandbox.renderNativeStage._ready, true);
  const filtered = sprite();
  filtered._filters = [{ enabled: true }];
  root.addChild(filtered);
  const parent = root.parent;
  sandbox.renderNativeStage(root);
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
  sandbox.renderNativeStage(root);
  sandbox.renderNativeStage(root);
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
  sandbox.renderNativeStage(root);
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
