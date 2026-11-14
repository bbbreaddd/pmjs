'use strict';
const { installTilemapStatics } = require('./native-tilemap-statics.cjs');

function installTilemap(runtime, engine, session) {
  const scope = runtime.scope;
  function Tilemap() { throw new Error('Tilemap construction is engine-owned'); }
  Tilemap.prototype._drawShadow = function(bitmap, bits, x, y) {
    for (let i = 0; i < 4; ++i) if (bits & (1 << i))
      bitmap.fillRect(x + i % 2 * this._tileWidth / 2, y + Math.floor(i / 2) * this._tileHeight / 2,
        this._tileWidth / 2, this._tileHeight / 2, 'rgba(0,0,0,0.5)');
  };
  function ShaderTilemap() { throw new Error('Tilemap construction is engine-owned'); }
  ShaderTilemap.prototype = Object.create(Tilemap.prototype); ShaderTilemap.prototype.constructor = ShaderTilemap;
  const base = ShaderTilemap.prototype._drawShadow = function(layer, bits, x, y) {
    for (let i = 0; i < 4; ++i) if (bits & (1 << i))
      layer.addRect(-1, 0, 0, x + i % 2 * this._tileWidth / 2, y + Math.floor(i / 2) * this._tileHeight / 2,
        this._tileWidth / 2, this._tileHeight / 2);
  };
  const tilemap = Object.create(ShaderTilemap.prototype);
  let width = 48, height = 48, previous = base;
  Object.defineProperties(tilemap, {
    _tileWidth: { get: () => width }, _tileHeight: { get: () => height }
  });
  Tilemap.prototype.refresh = function() { engine.gameDataInvoke(session, 'map', 'invalidateTileShadows', [tilemap._drawShadow !== base]); };
  Object.assign(scope, { Tilemap, ShaderTilemap });
  installTilemapStatics(runtime);
  return {
    update() {
      if (tilemap._drawShadow !== previous) { previous = tilemap._drawShadow; tilemap.refresh(); }
    },
    draw(bits, x, y, tileWidth, tileHeight) {
      if (tilemap._drawShadow === base) return undefined;
      width = tileWidth; height = tileHeight;
      const rectangles = [];
      const layer = { addRect(texture, sx, sy, dx, dy, w, h) {
        if (texture !== -1) throw new Error('Tile shadow drawing only supports shadow rectangles');
        if (![dx, dy, w, h].every(Number.isFinite)) throw new Error('Tile shadow rectangle must be finite');
        rectangles.push([dx, dy, w, h]);
      } };
      tilemap._drawShadow(layer, bits, x, y);
      return rectangles;
    }
  };
}
module.exports = { installTilemap };
