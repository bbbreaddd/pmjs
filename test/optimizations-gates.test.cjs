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
const dataSource = fs.readFileSync(
  path.join(runtimeRoot, 'js/pmjs-mv/data.js'), 'utf8');

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

function loadScenePrimitives({ disableOptimizations = [], env = {} } = {}) {
  const calls = { createTileLayer: 0, tileLayerPoints: [],
    releaseTileLayer: 0, createMesh: 0,
    releaseMesh: 0, putImageData: 0, fill: 0, getLocalBounds: 0 };
  let nextHandle = 1000;
  const context = {
    console: { log() {} },
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
        releaseTileLayer() { calls.releaseTileLayer++; },
        createMesh() { calls.createMesh++; return ++nextHandle; },
        releaseMesh() { calls.releaseMesh++; },
      },
    },
    nativeCompatibilityHit() {},
    PIXI: {
      Container: function Container() {
        this.worldAlpha = 1;
        this.transform = { worldTransform: { identity() {} } };
      },
      mesh: { Mesh: { DRAW_MODES: { TRIANGLE_MESH: 0 } } },
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
  vm.runInContext(optimizationsSource, context, { filename: 'optimizations.js' });
  vm.runInContext(scenePrimitivesSource, context, { filename: 'scene-primitives.js' });
  return { context, calls };
}

function callIn(context, expression, name, value) {
  context[name] = value;
  try {
    return vm.runInContext(expression, context);
  } finally {
    delete context[name];
  }
}

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
    dirty: 0, indexDirty: 0, vertexDirty: 0,
    drawMode: 0,
    uploadUvTransform: null,
  };
}

test('scene.gpu-mesh-cache reuses the upload when enabled, re-uploads when disabled', () => {
  const enabled = loadScenePrimitives();
  const mesh = gpuMesh();
  const first = callIn(enabled.context, 'ensureNativeGpuMesh(mesh)', 'mesh', mesh);
  const second = callIn(enabled.context, 'ensureNativeGpuMesh(mesh)', 'mesh', mesh);
  assert.equal(enabled.calls.createMesh, 1);
  assert.equal(enabled.calls.releaseMesh, 0);
  assert.equal(first, second);

  const disabled = loadScenePrimitives(
    { disableOptimizations: ['scene.gpu-mesh-cache'] });
  const other = gpuMesh();
  callIn(disabled.context, 'ensureNativeGpuMesh(other)', 'other', other);
  callIn(disabled.context, 'ensureNativeGpuMesh(other)', 'other', other);
  assert.equal(disabled.calls.createMesh, 2);
  assert.equal(disabled.calls.releaseMesh, 1);
});
