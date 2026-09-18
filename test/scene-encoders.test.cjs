'use strict';

// Scene-encoder regression tests: frozen oracle packet for plain
// Containers/Sprites, structural canary (absent features add no work), and
// one "active and correct" case per effect-lane feature. New compatibility
// features extend this file with the same pair.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const WRITER_SOURCES = ['js/pmjs-pixi4/scene-primitives.js',
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
  // Referenced by preparation but never instantiated by these fixtures.
  class Tilemap extends Container {}
  class Window extends Container {}
  class WindowLayer extends Container {}
  class BlurFilter {
    constructor(blur, quality) {
      this.blur = blur; this.quality = quality || 1; this.enabled = true;
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
      filters: { BlurFilter }, DisplayObject: Container,
      Texture: { EMPTY: null } },
    ScreenSprite, Tilemap, Window, WindowLayer, CanvasElement,
    nativeCompatibilityHit(kind, detail) {
      compatHits.push([kind, String(detail)]);
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
  return { sandbox, submitted, compatHits, counts, makeTexture, sprite };
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
  const ok = harness.sandbox.submitNativeScene(stage);
  assert.equal(ok, true);
  assert.equal(harness.submitted.length, 1);
  assert.deepEqual(harness.compatHits, []);
  return harness.submitted[0];
}

// Exact oracle for the plain fixture: root, inner, two sprites, deep
// container, one sprite. Handles are allocated in build order.
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
  // Cross-realm structural read of the classifier.
  const table = JSON.parse(JSON.stringify(kinds));
  assert.deepEqual(table, { container: 0, sprite: 1, picture: 1, weather: 1,
    screen: 2, tiling: 3, graphics: 4, mesh: 5, rectLayer: 6, unknown: 0,
    encoders: 'function,function,function',
    kinds: { CONTAINER: 0, SPRITE: 1, SCREEN_SPRITE: 2, TILING_SPRITE: 3,
      GRAPHICS: 4, MESH: 5, RECT_TILE_LAYER: 6, GENERIC: 7 } });
});

test('unknown representations take the container reference lane', () => {
  const harness = makeHarness();
  const { sandbox, sprite } = harness;
  const root = new sandbox.PIXI.Container();
  const custom = sprite();
  custom.pluginName = 'customChaos';
  custom.addChild(sprite());
  root.addChild(custom);
  const packet = submitOnly(harness, root);
  // Container semantics with the same effect rule as containers: no effects
  // means no planning. GENERIC stays reserved, never produced.
  assert.deepEqual(packet.metadata.filter((_, index) => index % 7 === 0),
    [0, 0, 1]);
  assert.deepEqual(harness.counts,
    { filterPlans: 0, rectMasks: 0, alphaMasks: 0 });
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
  // The masked leaf carries the scissor flag.
  assert.equal(packet.metadata[1 * 7 + 5] & 1, 1);
});

test('encoders observe state instead of advancing semantics', () => {
  function readModule(relative) {
    return fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
  }
  const encoders = readModule('js/pmjs-pixi4/scene-encoders.js');
  const prepare = readModule('js/pmjs-mv/render-prepare.js') + '\n' +
    readModule('js/pmjs-pixi4/scene-prepare.js');
  const classify = readModule('js/pmjs-pixi4/scene-classify.js');
  // Preparation-only calls must never appear in encoders.
  ['updateChowRender', '_paintAllTiles', '_sortChildren', 'updateText(',
    '.validate(', '_updateCursor', '_updateArrows', '_updatePauseSign',
    '_updateContents', 'nativeSceneFilter(', 'nativeRectangleMask(',
    'nativeAlphaMask('].forEach(forbidden => {
    assert.ok(encoders.indexOf(forbidden) < 0,
      'scene-encoders.js must not advance semantics: ' + forbidden);
  });
  // Preparation never encodes packets.
  ['nativeSceneRecord', 'nativeSceneFilterMarker', 'scene.submit',
    'filterPlan', 'nativeSceneEmission'].forEach(forbidden => {
    assert.ok(prepare.indexOf(forbidden) < 0,
      'scene-prepare.js must not encode packets: ' + forbidden);
  });
  // Classification is pure observation: no preparation, no encoding.
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
  // The blur marker carries the mutated strength (blur/passes).
  assert.notDeepEqual(first.values, second.values);
  assert.equal(first.values[41 + 7], 2);
  assert.equal(second.values[41 + 7], 4);
});

test('unsupported filters fall back instead of emitting partial scenes', () => {
  const harness = makeHarness();
  const { sandbox, sprite } = harness;
  const root = new sandbox.PIXI.Container();
  const filtered = sprite();
  filtered._filters = [{ enabled: true }];
  root.addChild(filtered);
  harness.submitted.length = 0;
  harness.compatHits.length = 0;
  assert.equal(sandbox.submitNativeScene(root), false);
  assert.equal(harness.submitted.length, 0);
  assert.deepEqual(harness.compatHits,
    [['render.filter', 'Sprite:Object'],
      ['render.sceneFallback', 'Sprite:filter']]);
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

test('custom render hooks run in reference order', () => {
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
  const packet = submitOnly(harness, root);
  // The update hook runs once per node; the type hook selects the encoder.
  assert.equal(hookCalls, 2);
  assert.equal(hookUpdated, 1);
  assert.deepEqual(packet.metadata.filter((_, index) => index % 7 === 0),
    [0, 8]);
});

test('custom type hook observes post-transform-update state', () => {
  const harness = makeHarness();
  const { sandbox, sprite } = harness;
  const root = new sandbox.PIXI.Container();
  const node = sprite();
  node.x = 7;
  node.y = 3;
  // Poison the cached local transform: the type hook must see the refreshed
  // values written by updateLocalTransform(), not the stale cache.
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
  // Reference resolution reads pluginName once and _pmjsType once for a
  // plain node; classification must not observe either property again.
  assert.deepEqual(result.plainResult,
    { pluginReads: 1, typeReads: 1, plainKind: 0 });
  // An explicit label short-circuits before _pmjsType, and the classifier
  // never re-reads the label to decide container vs generic.
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
  // Active filters disable the scissor shortcut (Pixi pops its mask before
  // the filter chain), so the mask resolves as alpha work instead.
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
  // Window preparation expects MV window methods.
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

  // Child 1: tone applied before attachment
  const childBefore = sprite();
  childBefore._colorTone = [68, -34, 0, 255];
  childBefore._blendColor = [255, 0, 0, 128];
  container.addChild(childBefore);

  // Child 2: added to container, then tone applied
  const childAfter = sprite();
  container.addChild(childAfter);
  childAfter._colorTone = [-100, 50, 0, 64];
  childAfter._blendColor = [0, 255, 0, 64];

  root.addChild(container);
  const packet = submitOnly(harness, root);

  // Node 0: root, Node 1: container, Node 2: childBefore, Node 3: childAfter
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
  // The invisible layer still emits; the visible parent groups it.
  assert.deepEqual(packet.metadata.filter((_, index) => index % 7 === 0),
    [0, 0, 4]);
});

function trySubmitMaskStage(harness, stage) {
  harness.submitted.length = 0;
  harness.compatHits.length = 0;
  const ok = harness.sandbox.submitNativeScene(stage);
  return { ok, packet: harness.submitted[0] || null,
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
