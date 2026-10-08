'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const native = require(path.resolve(process.argv[2]));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pmjs-retained-tiles-'));
native.initialize({ gameRoot: root, width: 32, height: 32, windowTitle: 'retained tiles' });
const atlas = native.canvas.create(64, 16);
const pixels = new Uint8Array(64 * 16 * 4);
for (let y = 0; y < 16; y++) for (let x = 0; x < 64; x++) {
  const offset = (y * 64 + x) * 4;
  pixels.set([Math.floor(x / 16) * 60, x % 16 * 12, y * 12, 255], offset);
}
native.canvas.writePixels(atlas.handle, 0, 0, 64, 16, pixels);
let uploads = 0;
const uploadTimes = [];
class Container {
  constructor() { this.transform = { worldTransform: { identity() {} } }; }
}
const context = vm.createContext({ PIXI: { Container }, PMJS: {
  optimizations: { register() {}, isEnabled() { return true; } }
}, NativeHost: { render: {
  createTileLayer(points, handles) {
    const begin = performance.now();
    const handle = native.render.createTileLayer(points, handles);
    uploadTimes.push(performance.now() - begin); uploads++;
    return handle;
  }, releaseTileLayer: native.render.releaseTileLayer
}, scene: { schema: native.scene.schema, packetVersion: native.scene.packetVersion } } });
for (const file of ['pmjs-pixi4/scene-primitives.js', 'pmjs-plugins/yed/retained-tiles.js']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js', file), 'utf8'), context);
}
const rect = { pointsBuf: [], textures: [{ baseTexture: { source: { _nativeImage: atlas } } }],
  addRect(texture, sx, sy, dx, dy, width, height) {
    this.pointsBuf.push(sx, sy, dx, dy, width, height, 0, 0, texture);
  } };
const layer = { layerId: 0, children: [rect], position: {}, clear() {
  rect.pointsBuf.length = 0; rect._pmjsNativeGeneration = (rect._pmjsNativeGeneration || 0) + 1;
} };
const map = { tiledData: { orientation: 'orthogonal', layers: [{ type: 'tilelayer', visible: true, data: [1, 2, 1, 2] }],
  tilesets: [{ firstgid: 1, columns: 4, tilewidth: 16, tileheight: 16 }] },
  _layers: [layer], _priorityTiles: [], bitmaps: [atlas], _tileWidth: 16, _tileHeight: 16,
  _mapWidth: 2, _mapHeight: 2, _width: 16, _height: 16, origin: { x: 0, y: 0 },
  _animFrame: { 0: 0 }, _animDuration: { 0: 1 }, _getTextureId() { return 0; },
  _getAnimTileId(texture, local) { return local === 0 ? this._animFrame[0] : local; },
  _isPriorityTile() { return false; }, _updateAnimFrames() { this._animDuration[0] = 1; } };
const api = context.PMJS.yedRetainedTiles;
function render(handle, camera) {
  const values = new Float32Array(native.scene.schema.valueStride);
  values.set([1, 0, 0, 1, -camera, 0, 1]);
  native.beginFrame();
  native.scene.submit(native.scene.schema.version,
    new Uint32Array([4, 0xffffffff, handle, 0xffffff, 0, 8, 0]), values, 1);
  native.renderScene();
  return crypto.createHash('sha256').update(Buffer.from(native.canvas.captureSceneRawPremultiplied())).digest('hex');
}
const frameTimes = [];
try {
  for (const frame of [0, 1, 2]) {
    if (frame) api.updateAnimation(map);
    for (const camera of [0, 5, 5]) {
      map.origin.x = camera;
      const begin = performance.now();
      api.prepare(map, 0, 0);
      const handle = context.ensureNativeRectTileLayer(rect);
      const candidate = render(handle, camera);
      frameTimes.push(performance.now() - begin);
      const expected = [frame * 16,0,0,0,16,16,0,0,0, 16,0,16,0,16,16,0,0,0,
        frame * 16,0,0,16,16,16,0,0,0, 16,0,16,16,16,16,0,0,0];
      const reference = native.render.createTileLayer(new Float32Array(expected), [atlas.handle]);
      assert.equal(candidate, render(reference, camera), 'source patches and camera shifts preserve pixels');
      native.render.releaseTileLayer(reference);
      assert.equal(uploads, frame + 1, 'warm camera movement must reuse native geometry');
    }
  }
  frameTimes.length = 0;
  for (let frame = 0; frame < 240; frame++) {
    const camera = frame % 6;
    map.origin.x = camera;
    const begin = performance.now();
    api.prepare(map, 0, 0);
    render(context.ensureNativeRectTileLayer(rect), camera);
    frameTimes.push(performance.now() - begin);
  }
  assert.equal(uploads, 3);
  frameTimes.sort((a,b) => a-b);
  console.log(JSON.stringify({ pixelComparisons: 9, uploads, uploadMilliseconds: uploadTimes,
    warmFrames: frameTimes.length, preparationRenderAndReadbackP50Ms: frameTimes[Math.floor(frameTimes.length * 0.5)],
    preparationRenderAndReadbackP95Ms: frameTimes[Math.floor(frameTimes.length * 0.95)] }));
} finally {
  context.pmjsReleaseNativeGeometry(rect, 'tile');
  native.canvas.release(atlas.handle);
  fs.rmSync(root, { recursive: true, force: true });
}
