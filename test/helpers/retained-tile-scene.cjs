'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

function createRetainedTileScene(native) {
  const atlas = native.canvas.create(64, 16);
  const pixels = new Uint8Array(64 * 16 * 4);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 64; x++) {
    const offset = (y * 64 + x) * 4;
    pixels.set([Math.floor(x / 16) * 60, x % 16 * 12, y * 12, 255], offset);
  }
  native.canvas.writePixels(atlas.handle, 0, 0, 64, 16, pixels);
  let uploads = 0;
  class Container {
    constructor() { this.transform = { worldTransform: { identity() {} } }; }
  }
  const context = vm.createContext({ PIXI: { Container }, PMJS: {
    optimizations: { register() {}, isEnabled() { return true; } }
  }, NativeHost: { render: {
    createTileLayer(points, handles) {
      const handle = native.render.createTileLayer(points, handles);
      uploads++;
      return handle;
    }, releaseTileLayer: native.render.releaseTileLayer
  }, scene: { schema: native.scene.schema, packetVersion: native.scene.packetVersion } } });
  for (const file of ['pmjs-pixi4/scene-primitives.js', 'pmjs-plugins/yed/retained-tiles.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../../js', file), 'utf8'), context);
  }
  const rect = { pointsBuf: [], textures: [{ baseTexture: { source: { _nativeImage: atlas } } }],
    addRect(texture, sx, sy, dx, dy, width, height) {
      this.pointsBuf.push(sx, sy, dx, dy, width, height, 0, 0, texture);
    } };
  context.PMJS.pixi4.tilePointRevision = (target, points) =>
    target === rect && points === rect.pointsBuf ? rect._pmjsNativeGeneration || 0 : -1;
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
  return { atlas, map, api, context, rect, render, get uploads() { return uploads; }, dispose() {
    context.pmjsReleaseNativeGeometry(rect, 'tile');
    native.canvas.release(atlas.handle);
  } };
}

module.exports = { createRetainedTileScene };
