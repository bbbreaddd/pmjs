'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const runtimeRoot = path.resolve(__dirname, '..');
const optimizationsSource = fs.readFileSync(
  path.join(runtimeRoot, 'js/pmjs-core/optimizations.js'), 'utf8');
const scenePrimitivesSource = fs.readFileSync(
  path.join(runtimeRoot, 'js/pmjs-pixi4/scene-primitives.js'), 'utf8');

function stubCanvasContext(calls) {
  return {
    resetTransform() {}, clearRect() {}, translate() {},
    beginPath() {}, moveTo() {}, lineTo() {}, rect() {}, arc() {}, closePath() {},
    save() {}, restore() {}, setTransform() {},
    drawImage() {},
    getImageData() { return { data: new Uint8ClampedArray(64) }; },
    putImageData() { calls.putImageData++; },
    fill() { calls.fill++; },
    stroke() {},
  };
}

function loadScenePrimitives({ disableOptimizations = [], env = {}, pixi4 } = {}) {
  const calls = { createTileLayer: 0, tileLayerPoints: [],
    releaseTileLayer: 0, createMesh: 0,
    releaseMesh: 0, releasedLayers: [], releasedMeshes: [],
    putImageData: 0, fill: 0, getLocalBounds: 0 };
  const finalizers = [];
  class MockFinalizationRegistry {
    constructor(callback) { this.callback = callback; this.records = new Map(); finalizers.push(this); }
    register(_target, held, token) { this.records.set(token, held); }
    unregister(token) { return this.records.delete(token); }
  }
  let nextHandle = 1000;
  const context = {
    PMJS: { pixi4 },
    console: { log() {} },
    FinalizationRegistry: MockFinalizationRegistry,
    PMJS_GAME_CONFIG: { disableOptimizations },
    NativeHost: {
      runtime: { env(name) { return env[name]; } },
      scene: null,
      render: {
        createTileLayer(points) {
          calls.createTileLayer++;
          calls.tileLayerPoints.push(points);
          return ++nextHandle;
        },
        releaseTileLayer(handle) { calls.releaseTileLayer++; calls.releasedLayers.push(handle); },
        createMesh() { calls.createMesh++; return ++nextHandle; },
        releaseMesh(handle) { calls.releaseMesh++; calls.releasedMeshes.push(handle); },
      },
    },
    nativeCompatibilityHit() {},
    PIXI: {
      Container: function Container() {
        this.worldAlpha = 1;
        this.transform = { worldTransform: { identity() {} } };
      },
      mesh: { Mesh: { DRAW_MODES: { TRIANGLE_MESH: 0, TRIANGLES: 1 } } },
    },
    CanvasElement: function CanvasElement() {
      const canvas = this;
      canvas._context = stubCanvasContext(calls);
      canvas._native = null;
    },
    ImageData: function ImageData(data, width, height) {
      this.data = data; this.width = width; this.height = height;
    },
  };
  context.CanvasElement.prototype.getContext = function() { return this._context; };
  context.CanvasElement.prototype._releaseNativeCanvas = function() { this._native = null; };
  context.CanvasElement.prototype._ensureNativeCanvas = function() {
    if (!this._native) this._native = { handle: ++nextHandle };
    return this._native;
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/pmjs-core/config.js'), 'utf8'), context);
  vm.runInContext(optimizationsSource, context, { filename: 'optimizations.js' });
  vm.runInContext(scenePrimitivesSource, context, { filename: 'scene-primitives.js' });
  return { context, calls, finalizers };
}

function callIn(context, expression, name, value) {
  context[name] = value;
  try {
    return vm.runInContext(expression, context);
  } finally {
    delete context[name];
  }
}

test('Pixi capabilities extend the existing namespace without replacing other owners', () => {
  const existing = { prepareTexture() {} };
  const prepareTexture = existing.prepareTexture;
  const { context } = loadScenePrimitives({ pixi4: existing });
  assert.equal(context.PMJS.pixi4, existing);
  assert.equal(context.PMJS.pixi4.prepareTexture, prepareTexture);
  assert.equal(typeof context.PMJS.pixi4.retainMeshGeometry, 'function');
  assert.equal(typeof context.PMJS.pixi4.invalidateMeshGeometry, 'function');
  assert.equal(typeof context.PMJS.pixi4.setMeshPostTintOverlay, 'function');
});

function tileLayer() {
  return {
    pointsBuf: [0, 0, 0, 0, 0, 0, 0, 0, 0],
    textures: [{ baseTexture: { source: { _nativeImage: { handle: 7 } } },
      width: 16, height: 16 }],
    _pmjsNativeGeneration: 0,
  };
}

test('tilemap.persistent-layer-cache reuses the compiled layer when enabled', () => {
  const { context, calls } = loadScenePrimitives();
  const layer = tileLayer();
  const first = callIn(context, 'ensureNativeRectTileLayer(layer)', 'layer', layer);
  assert.equal(calls.createTileLayer, 1);
  const second = callIn(context, 'ensureNativeRectTileLayer(layer)', 'layer', layer);
  assert.equal(calls.createTileLayer, 1);
  assert.equal(calls.releaseTileLayer, 0);
  assert.equal(first, second);
});

test('tilemap cache sees direct pointsBuf mutation without a generation bump', () => {
  const { context, calls } = loadScenePrimitives();
  const layer = tileLayer();
  callIn(context, 'ensureNativeRectTileLayer(layer)', 'layer', layer);
  layer.pointsBuf[0] = 17;
  callIn(context, 'ensureNativeRectTileLayer(layer)', 'layer', layer);
  assert.equal(calls.createTileLayer, 2);
  assert.equal(calls.tileLayerPoints[1][0], 17);
});

test('persistent tile cache works with bulk transfer disabled', () => {
  const { context, calls } = loadScenePrimitives(
    { disableOptimizations: ['tilemap.bulk-layer-transfer'] });
  const layer = tileLayer();
  callIn(context, 'ensureNativeRectTileLayer(layer)', 'layer', layer);
  callIn(context, 'ensureNativeRectTileLayer(layer)', 'layer', layer);
  assert.equal(calls.createTileLayer, 1);
  layer.pointsBuf[0] = 17;
  callIn(context, 'ensureNativeRectTileLayer(layer)', 'layer', layer);
  assert.equal(calls.createTileLayer, 2);
});

test('tilemap.bulk-layer-transfer stages records in a reusable Float32Array', () => {
  const enabled = loadScenePrimitives();
  const layer = tileLayer();
  callIn(enabled.context, 'ensureNativeRectTileLayer(layer)', 'layer', layer);
  const first = enabled.calls.tileLayerPoints[0];
  assert.equal(Object.prototype.toString.call(first), '[object Float32Array]');
  layer._pmjsNativeGeneration++;
  layer.pointsBuf[0] = 4;
  callIn(enabled.context, 'ensureNativeRectTileLayer(layer)', 'layer', layer);
  assert.equal(enabled.calls.tileLayerPoints[1], first);
  assert.equal(enabled.calls.tileLayerPoints[1][0], 4);

  const disabled = loadScenePrimitives(
    { disableOptimizations: ['tilemap.bulk-layer-transfer'] });
  const ordinary = tileLayer();
  callIn(disabled.context, 'ensureNativeRectTileLayer(layer)', 'layer', ordinary);
  assert.equal(Array.isArray(disabled.calls.tileLayerPoints[0]), true);
});

test('tilemap.persistent-layer-cache recompiles every frame when disabled', () => {
  const { context, calls } = loadScenePrimitives(
    { disableOptimizations: ['tilemap.persistent-layer-cache'] });
  const layer = tileLayer();
  callIn(context, 'ensureNativeRectTileLayer(layer)', 'layer', layer);
  callIn(context, 'ensureNativeRectTileLayer(layer)', 'layer', layer);
  assert.equal(calls.createTileLayer, 2);
  assert.equal(calls.releaseTileLayer, 1);
});

test('tilemap generation bump with identical points skips recompile', () => {
  const { context, calls } = loadScenePrimitives();
  const layer = tileLayer();
  const first = callIn(context, 'ensureNativeRectTileLayer(layer)', 'layer', layer);
  assert.equal(calls.createTileLayer, 1);
  // Animated repaints clear and rewrite identical points every tick.
  layer._pmjsNativeGeneration++;
  const second = callIn(context, 'ensureNativeRectTileLayer(layer)', 'layer', layer);
  assert.equal(calls.createTileLayer, 1);
  assert.equal(calls.releaseTileLayer, 0);
  assert.equal(first, second);
  // A real point change still recompiles.
  layer._pmjsNativeGeneration++;
  layer.pointsBuf[0] = 4;
  const third = callIn(context, 'ensureNativeRectTileLayer(layer)', 'layer', layer);
  assert.equal(calls.createTileLayer, 2);
  assert.equal(calls.releaseTileLayer, 1);
  assert.notEqual(third, first);
  // A texture change still recompiles.
  layer._pmjsNativeGeneration++;
  layer.textures = [{ baseTexture: { source: { _nativeImage: { handle: 8 } } },
    width: 16, height: 16 }];
  callIn(context, 'ensureNativeRectTileLayer(layer)', 'layer', layer);
  assert.equal(calls.createTileLayer, 3);
  assert.equal(calls.releaseTileLayer, 2);

  const disabled = loadScenePrimitives(
    { disableOptimizations: ['tilemap.persistent-layer-cache'] });
  const other = tileLayer();
  callIn(disabled.context, 'ensureNativeRectTileLayer(other)', 'other', other);
  other._pmjsNativeGeneration++;
  callIn(disabled.context, 'ensureNativeRectTileLayer(other)', 'other', other);
  assert.equal(disabled.calls.createTileLayer, 2);
});

test('tilemap layer keeps eligibility checks when enabled', () => {
  const { context, calls } = loadScenePrimitives();
  const empty = { pointsBuf: [], textures: [] };
  const handle = callIn(context, 'ensureNativeRectTileLayer(empty)', 'empty', empty);
  assert.equal(handle, 0);
  assert.equal(calls.createTileLayer, 0);
});

function tilingTexture() {
  return {
    baseTexture: { source: { _nativeImage: { handle: 5 } },
      width: 64, height: 64, resolution: 1 },
    _frame: { x: 8, y: 8, width: 16, height: 16 },
    orig: { width: 32, height: 32 },
    trim: undefined,
    rotate: 0,
    _updateID: 3,
  };
}

test('scene.tiling-texture-cache rasterizes once when enabled, always when disabled', () => {
  const enabled = loadScenePrimitives();
  const texture = tilingTexture();
  callIn(enabled.context, 'ensureNativeTilingTexture(texture)', 'texture', texture);
  assert.equal(enabled.calls.putImageData, 1);
  callIn(enabled.context, 'ensureNativeTilingTexture(texture)', 'texture', texture);
  assert.equal(enabled.calls.putImageData, 1);

  const disabled = loadScenePrimitives(
    { disableOptimizations: ['scene.tiling-texture-cache'] });
  const other = tilingTexture();
  callIn(disabled.context, 'ensureNativeTilingTexture(other)', 'other', other);
  callIn(disabled.context, 'ensureNativeTilingTexture(other)', 'other', other);
  assert.equal(disabled.calls.putImageData, 2);
});

test('tiling texture cache invalidates when canvas pixels change', () => {
  const { context, calls } = loadScenePrimitives();
  const texture = tilingTexture();
  const source = texture.baseTexture.source;
  source.__pmjsContentRevision = 1;
  source._ensureNativeCanvas = function() { return source._nativeImage; };
  callIn(context, 'ensureNativeTilingTexture(texture)', 'texture', texture);
  callIn(context, 'ensureNativeTilingTexture(texture)', 'texture', texture);
  assert.equal(calls.putImageData, 1);
  source.__pmjsContentRevision++;
  callIn(context, 'ensureNativeTilingTexture(texture)', 'texture', texture);
  assert.equal(calls.putImageData, 2);
});

function vectorGraphics() {
  const graphics = {
    dirty: 1,
    boundsPadding: 0,
    boundsCalls: 0,
    graphicsData: [{ shape: { type: 1, x: 0, y: 0, width: 10, height: 10 },
      fill: true, fillColor: 0xff0000, fillAlpha: 1, lineWidth: 0, holes: [] }],
  };
  graphics.getLocalBounds = function() {
    graphics.boundsCalls++;
    return { x: 0, y: 0, width: 10, height: 10 };
  };
  return graphics;
}

test('scene.graphics-cache rasterizes once when enabled, always when disabled', () => {
  const enabled = loadScenePrimitives();
  const graphics = vectorGraphics();
  callIn(enabled.context, 'ensureNativeGraphics(graphics)', 'graphics', graphics);
  assert.equal(enabled.calls.fill, 1);
  assert.equal(graphics.boundsCalls, 1);
  callIn(enabled.context, 'ensureNativeGraphics(graphics)', 'graphics', graphics);
  assert.equal(enabled.calls.fill, 1);
  assert.equal(graphics.boundsCalls, 1);

  const disabled = loadScenePrimitives(
    { disableOptimizations: ['scene.graphics-cache'] });
  const other = vectorGraphics();
  // getLocalBounds is re-queried on the ordinary path every use.
  callIn(disabled.context, 'ensureNativeGraphics(other)', 'other', other);
  callIn(disabled.context, 'ensureNativeGraphics(other)', 'other', other);
  assert.equal(disabled.calls.fill, 2);
  assert.equal(other.boundsCalls, 2);
});

function gpuMesh() {
  return {
    texture: { baseTexture: { source: { _nativeImage: { handle: 9 } } },
      _updateID: 5 },
    vertices: [0, 0, 10, 0, 10, 10],
    uvs: [0, 0, 1, 0, 1, 1],
    indices: [0, 1, 2],
    dirty: 0, indexDirty: 0,
    drawMode: 0,
    uploadUvTransform: null,
  };
}

test('explicitly retained meshes reuse geometry until their producer invalidates it', () => {
  const { context, calls, finalizers } = loadScenePrimitives();
  const mesh = gpuMesh();
  context.PMJS.pixi4.retainMeshGeometry(mesh);
  const first = callIn(context, 'ensureNativeGpuMesh(mesh)', 'mesh', mesh);
  assert.equal(callIn(context, 'ensureNativeGpuMesh(mesh)', 'mesh', mesh), first);
  assert.equal(calls.createMesh, 1);
  context.PMJS.pixi4.retainMeshGeometry(mesh);
  assert.equal(callIn(context, 'ensureNativeGpuMesh(mesh)', 'mesh', mesh), first);
  mesh.vertices[0] = 17;
  context.PMJS.pixi4.invalidateMeshGeometry(mesh);
  const next = callIn(context, 'ensureNativeGpuMesh(mesh)', 'mesh', mesh);
  assert.notEqual(next, first);
  assert.deepEqual(calls.releasedMeshes, [first]);
  assert.equal(finalizers[0].records.size, 1);
  const ordinary = gpuMesh();
  const ordinaryHandle = callIn(context, 'ensureNativeGpuMesh(mesh)', 'mesh', ordinary);
  assert.notEqual(callIn(context, 'ensureNativeGpuMesh(mesh)', 'mesh', ordinary), ordinaryHandle);
});

test('retained meshes follow texture, UV transform, draw-mode, and released-resource changes', () => {
  const { context } = loadScenePrimitives();
  const mesh = gpuMesh();
  context.PMJS.pixi4.retainMeshGeometry(mesh);
  let handle = callIn(context, 'ensureNativeGpuMesh(mesh)', 'mesh', mesh);
  for (const change of [
    () => { mesh.texture.baseTexture.source._nativeImage.handle++; },
    () => { mesh.uploadUvTransform = true;
      mesh._uvTransform = { mapCoord: { a: 1, b: 0, c: 0, d: 1, tx: 0.25, ty: 0 } }; },
    () => { mesh._uvTransform.mapCoord.tx = 0.5; },
    () => { mesh.drawMode = 1; },
    () => { callIn(context, "pmjsReleaseNativeGeometry(mesh, 'mesh')", 'mesh', mesh); }
  ]) {
    change();
    const next = callIn(context, 'ensureNativeGpuMesh(mesh)', 'mesh', mesh);
    assert.notEqual(next, handle);
    assert.equal(callIn(context, 'ensureNativeGpuMesh(mesh)', 'mesh', mesh), next);
    handle = next;
  }
});

for (const via of ['config', 'env']) {
  test(`retained mesh geometry can be disabled through ${via}`, () => {
    const id = 'scene.retained-mesh-geometry';
    const { context, calls } = loadScenePrimitives(via === 'config'
      ? { disableOptimizations: [id] } : { env: { PMJS_DISABLE_OPT: id } });
    const mesh = gpuMesh();
    context.PMJS.pixi4.retainMeshGeometry(mesh);
    const first = callIn(context, 'ensureNativeGpuMesh(mesh)', 'mesh', mesh);
    const next = callIn(context, 'ensureNativeGpuMesh(mesh)', 'mesh', mesh);
    assert.notEqual(next, first);
    assert.equal(calls.createMesh, 2);
    assert.deepEqual(calls.releasedMeshes, [first]);
  });
}

test('failed retained mesh replacement remains retryable without releasing the current owner', () => {
  const { context, calls } = loadScenePrimitives();
  const mesh = gpuMesh();
  context.PMJS.pixi4.retainMeshGeometry(mesh);
  const first = callIn(context, 'ensureNativeGpuMesh(mesh)', 'mesh', mesh);
  context.PMJS.pixi4.invalidateMeshGeometry(mesh);
  const create = context.NativeHost.render.createMesh;
  context.NativeHost.render.createMesh = () => { throw new Error('upload failed'); };
  assert.throws(() => callIn(context, 'ensureNativeGpuMesh(mesh)', 'mesh', mesh), /upload failed/);
  assert.deepEqual(calls.releasedMeshes, []);
  context.NativeHost.render.createMesh = create;
  assert.notEqual(callIn(context, 'ensureNativeGpuMesh(mesh)', 'mesh', mesh), first);
  assert.deepEqual(calls.releasedMeshes, [first]);
});

test('compiled geometry has finalizer owners and explicit release unregisters them', () => {
  const { context, calls, finalizers } = loadScenePrimitives();
  const mesh = gpuMesh();
  const layer = tileLayer();
  const meshHandle = callIn(context, 'ensureNativeGpuMesh(mesh)', 'mesh', mesh);
  const layerHandle = callIn(context, 'ensureNativeRectTileLayer(layer)', 'layer', layer);
  const registry = finalizers[0];
  assert.deepEqual(Object.keys(mesh.__pmjsNativeMeshOwner).sort(), ['handle', 'kind']);
  assert.deepEqual(Object.keys(layer._pmjsNativeLayerOwner).sort(), ['handle', 'kind']);
  assert.equal(registry.records.size, 2);
  registry.callback(mesh.__pmjsNativeMeshOwner);
  assert.deepEqual(calls.releasedMeshes, [meshHandle]);
  callIn(context, "pmjsReleaseNativeGeometry(layer, 'tile')", 'layer', layer);
  assert.deepEqual(calls.releasedLayers, [layerHandle]);
  assert.equal(registry.records.size, 1);
});

test('failed geometry replacements preserve the previous valid cache entry', () => {
  const { context, calls } = loadScenePrimitives();
  const mesh = gpuMesh();
  const layer = tileLayer();
  const meshHandle = callIn(context, 'ensureNativeGpuMesh(mesh)', 'mesh', mesh);
  const layerHandle = callIn(context, 'ensureNativeRectTileLayer(layer)', 'layer', layer);
  mesh.dirty = 1;
  layer.pointsBuf[0] = 1;
  context.NativeHost.render.createMesh = () => { throw new Error('mesh allocation failed'); };
  context.NativeHost.render.createTileLayer = () => { throw new Error('tile allocation failed'); };
  assert.throws(() => callIn(context, 'ensureNativeGpuMesh(mesh)', 'mesh', mesh), /mesh allocation failed/);
  assert.throws(() => callIn(context, 'ensureNativeRectTileLayer(layer)', 'layer', layer), /tile allocation failed/);
  assert.equal(mesh.__pmjsNativeMesh, meshHandle);
  assert.equal(layer._pmjsNativeLayer, layerHandle);
  assert.deepEqual(calls.releasedMeshes, []);
  assert.deepEqual(calls.releasedLayers, []);
  mesh.dirty = 0;
  layer.pointsBuf[0] = 0;
  context.NativeHost.render.createMesh = () => 1234;
  assert.equal(callIn(context, 'ensureNativeGpuMesh(mesh)', 'mesh', mesh), 1234);
  assert.deepEqual(calls.releasedMeshes, [meshHandle]);
  assert.equal(callIn(context, 'ensureNativeRectTileLayer(layer)', 'layer', layer), layerHandle);
});

test('storage.read-burst-coalesce disables cleanly via optimization gate', () => {
  const storageSource = fs.readFileSync(
    path.join(runtimeRoot, 'js/pmjs-mv/storage.js'), 'utf8');

  function makeStorageContext(disabled = false) {
    let reads = 0;
    const context = {
      PMJS_GAME_CONFIG: disabled ? { disableOptimizations: ['storage.read-burst-coalesce'] } : {},
      NativeHost: {
        storage: {
          exists: () => true,
          readText: () => { reads++; return 'BASE64_DATA'; },
          writeText: () => {},
          remove: () => {},
          rename: () => {}
        }
      },
      StorageManager: {
        isLocalMode: () => true,
        localFilePath: () => '/save/global.rpgsave',
        loadFromLocalFile: function(id) {
          reads++;
          return '{"test":1}';
        },
        localFileExists: () => true
      },
      LZString: {
        decompressFromBase64: s => s
      },
      queueMicrotask: globalThis.queueMicrotask
    };
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/pmjs-core/config.js'), 'utf8'), context);
    vm.runInContext(optimizationsSource, context);
    vm.runInContext(storageSource, context);
    vm.runInContext('installNativeStorageManager()', context);
    return { context, getReads: () => reads };
  }

  // Enabled: reads coalesce in synchronous burst
  const enabled = makeStorageContext(false);
  enabled.context.StorageManager.loadFromLocalFile(0);
  enabled.context.StorageManager.loadFromLocalFile(0);
  assert.equal(enabled.getReads(), 1, 'enabled read-burst-coalesce should coalesce reads to 1');

  // Disabled: reads bypass burst cache every call
  const disabled = makeStorageContext(true);
  disabled.context.StorageManager.loadFromLocalFile(0);
  disabled.context.StorageManager.loadFromLocalFile(0);
  assert.equal(disabled.getReads(), 2, 'disabled read-burst-coalesce should read on every call');
});

test('scene resource release preserves authored objects and rebuilds geometry on reuse', () => {
  const { context, calls, finalizers } = loadScenePrimitives();
  const mesh = gpuMesh();
  const layer = tileLayer();
  const outside = gpuMesh();
  context.PMJS.pixi4.retainMeshGeometry(mesh);
  context.PMJS.pixi4.retainMeshGeometry(outside);
  const meshHandle = callIn(context, 'ensureNativeGpuMesh(mesh)', 'mesh', mesh);
  const layerHandle = callIn(context, 'ensureNativeRectTileLayer(layer)', 'layer', layer);
  const outsideHandle = callIn(context, 'ensureNativeGpuMesh(mesh)', 'mesh', outside);
  const vertices = mesh.vertices.slice();
  const points = layer.pointsBuf.slice();
  const texture = mesh.texture;
  const textures = layer.textures;
  const root = { children: [mesh, layer, mesh] };
  layer.children = [root];
  mesh.destroy = () => { throw new Error('authored objects must survive'); };
  texture.destroy = () => { throw new Error('shared textures must survive'); };

  assert.equal(context.PMJS.pixi4.releaseSceneResources(root), 2);
  assert.deepEqual(calls.releasedMeshes, [meshHandle]);
  assert.deepEqual(calls.releasedLayers, [layerHandle]);
  assert.equal(finalizers[0].records.size, 1);
  assert.equal(context.PMJS.pixi4.releaseSceneResources(root), 0);
  assert.equal(context.PMJS.pixi4.releaseSceneResources(null), 0);
  assert.deepEqual(mesh.vertices, vertices);
  assert.deepEqual(layer.pointsBuf, points);
  assert.equal(mesh.texture, texture);
  assert.equal(layer.textures, textures);
  assert.equal(root.children[0], mesh);
  assert.equal(callIn(context, 'ensureNativeGpuMesh(mesh)', 'mesh', outside), outsideHandle);

  const rebuiltMesh = callIn(context, 'ensureNativeGpuMesh(mesh)', 'mesh', mesh);
  const rebuiltLayer = callIn(context, 'ensureNativeRectTileLayer(layer)', 'layer', layer);
  assert.notEqual(rebuiltMesh, meshHandle);
  assert.notEqual(rebuiltLayer, layerHandle);
  assert.equal(callIn(context, 'ensureNativeGpuMesh(mesh)', 'mesh', mesh), rebuiltMesh);
  assert.equal(callIn(context, 'ensureNativeRectTileLayer(layer)', 'layer', layer), rebuiltLayer);
  assert.deepEqual(calls.tileLayerPoints[0], calls.tileLayerPoints[1]);
  assert.equal(finalizers[0].records.size, 3);
});
