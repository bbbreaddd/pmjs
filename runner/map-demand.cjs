'use strict';

const vm = require('node:vm');
const path = require('node:path');

const COMPILER_VERSION = 'map-demand-v4';
function mapContract(map, tileset, tileWidth, tileHeight) {
  return { width: map.width, height: map.height, data: map.data, tilesetId: map.tilesetId, scrollType: map.scrollType,
    events: (map.events || []).map(event => event && (event.pages || []).map(page => page.image && page.image.tileId || 0)),
    tilesetNames: tileset.tilesetNames, flags: tileset.flags, tileWidth, tileHeight };
}
function engineTilemap(source, mz) {
  const start = source.indexOf('\nfunction Tilemap()');
  const end = source.indexOf(mz ? 'Tilemap.Layer = function' : '\nfunction ShaderTilemap()', start);
  if (start < 0 || end < start) throw new Error('unrecognized tilemap source boundaries');
  const context = { PIXI: { Container: function() {} } };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context, { timeout: 1000 });
  const Tilemap = context.Tilemap;
  for (const name of mz ? ['_addNormalTile', '_addAutotile', '_addTableEdge'] :
    ['_drawNormalTile', '_drawAutotile', '_drawTableEdge']) {
    if (typeof Tilemap.prototype[name] !== 'function') throw new Error('missing tilemap rectangle producer '+name);
  }
  return Tilemap;
}
function compileRpgMap({ map, tileset, Tilemap, mz, tileWidth = 48, tileHeight = tileWidth }) {
  if (!Number.isSafeInteger(tileWidth) || !Number.isSafeInteger(tileHeight) ||
      tileWidth <= 0 || tileHeight <= 0 || tileWidth % 2 || tileHeight % 2) throw new Error('unsupported tile dimensions');
  if (!map || !tileset || !Array.isArray(map.data) || map.data.length !== map.width*map.height*6)
    throw new Error('incomplete map visual planes');
  const ids = new Set(map.data.slice(0, map.width*map.height*4).filter(id => id > 0));
  for (const event of map.events || []) if (event) for (const page of event.pages || [])
    if (page.image && page.image.tileId > 0) ids.add(page.image.tileId);
  const demands = new Map(), counts = new Map();
  let rectanglesThisPhase = 0;
  function record(index, x, y, width, height) {
    rectanglesThisPhase++;
    if (!tileset.tilesetNames[index]) throw new Error('missing configured sheet for tile demand '+index);
    if (![x, y, width, height].every(Number.isSafeInteger)) throw new Error('noninteger tile rectangle');
    const source = 'img/tilesets/'+tileset.tilesetNames[index]+'.png';
    if (!demands.has(source)) demands.set(source, new Map());
    const rect = [x, y, width, height]; demands.get(source).set(rect.join(','), rect);
  }
  const tilemap = Object.create(Tilemap.prototype);
  tilemap._tileWidth = tileWidth; tilemap._tileHeight = tileHeight;
  Object.defineProperties(tilemap, { tileWidth: { value: tileWidth }, tileHeight: { value: tileHeight } });
  tilemap.flags = tileset.flags;
  tilemap.bitmaps = tileset.tilesetNames.map((name, index) => name ? { index } : null);
  const target = mz ? { addRect(index, x, y, dx, dy, width, height) { record(index, x, y, width, height); } } :
    { bltImage(bitmap, x, y, width, height) { if (bitmap) record(bitmap.index, x, y, width, height); },
      blt(bitmap, x, y, width, height) { if (bitmap) record(bitmap.index, x, y, width, height); } };
  for (const id of [...ids].sort((a, b) => a-b)) for (let phase = 0; phase < 12; ++phase) {
    rectanglesThisPhase = 0;
    tilemap.animationFrame = phase;
    if (mz) {
      if (Tilemap.isAutotile(id)) tilemap._addAutotile(target, id, 0, 0);
      else tilemap._addNormalTile(target, id, 0, 0);
      if (Tilemap.isTileA2(id)) tilemap._addTableEdge(target, id, 0, 0);
    } else {
      if (Tilemap.isAutotile(id)) tilemap._drawAutotile(target, id, 0, 0);
      else tilemap._drawNormalTile(target, id, 0, 0);
      if (Tilemap.isTileA2(id)) tilemap._drawTableEdge(target, id, 0, 0);
    }
    counts.set(id, Math.max(counts.get(id) || 0, rectanglesThisPhase));
  }
  for (const name of tileset.tilesetNames.filter(Boolean)) {
    const source = 'img/tilesets/'+name+'.png';
    if (!demands.has(source)) demands.set(source, new Map());
  }
  return { renderer: mz ? 'mz' : 'mv', contract: mapContract(map, tileset, tileWidth, tileHeight),
    features: { animation: [...ids].some(id => Tilemap.isTileA1 && Tilemap.isTileA1(id)),
      priority: [...ids].some(id => tileset.flags[id] & 16),
      table: [...ids].some(id => Tilemap.isTileA2(id) && tileset.flags[id] & 128),
      shadows: map.data.slice(map.width*map.height*4,map.width*map.height*5).some(Boolean),
      tileEvents: (map.events || []).some(event => event && event.pages.some(page => page.image && page.image.tileId)),
      looping: !!map.scrollType },
    animationPhases: 12, tileWidth, tileHeight,
    geometryDensity: Array.from({ length: map.width*map.height }, (_, index) => {
      let count = 0;
      for (let plane = 0; plane < 4; plane++) count += counts.get(map.data[index+plane*map.width*map.height]) || 0;
      if (map.data[index+4*map.width*map.height]) count += 4;
      return count;
    }), geometryWidth: map.width, geometryHeight: map.height,
    loopHorizontal: map.scrollType === 2 || map.scrollType === 3,
    loopVertical: map.scrollType === 1 || map.scrollType === 3,
    sources: [...demands].map(([source, rectangles]) => ({ source, rectangles: [...rectangles.values()] })),
    ordinarySources: tileset.tilesetNames.filter(Boolean).map(name => 'img/tilesets/'+name+'.png') };
}
function compileTiledMap(map) {
  if (!map || !Array.isArray(map.tilesets) || !Array.isArray(map.layers)) throw new Error('incomplete Tiled map');
  const tilesets = [...map.tilesets].sort((a, b) => a.firstgid-b.firstgid);
  const ids = new Set(), preserved = new Set();
  const strip = gid => (Number(gid) >>> 0) & 0x0fffffff;
  function tileset(gid) { return tilesets.findLast(set => set.firstgid <= gid); }
  function layers(rows) {
    for (const layer of rows) {
      if (layer.layers) layers(layer.layers);
      if (layer.data) {
        if (!Array.isArray(layer.data)) throw new Error('compressed Tiled layer is unsupported');
        for (const gid of layer.data) if (strip(gid)) ids.add(strip(gid));
      }
      for (const chunk of layer.chunks || []) {
        if (!Array.isArray(chunk.data)) throw new Error('compressed Tiled chunk is unsupported');
        for (const gid of chunk.data) if (strip(gid)) ids.add(strip(gid));
      }
      for (const object of layer.objects || []) if (strip(object.gid)) {
        const id = strip(object.gid), set = tileset(id); ids.add(id);
        if (!set || object.rotation || (object.width && object.width !== map.tilewidth) ||
            (object.height && object.height !== map.tileheight) ||
            set.tilewidth !== map.tilewidth || set.tileheight !== map.tileheight) preserved.add(set);
      }
    }
  }
  layers(map.layers);
  // Animation frames may themselves contain animation metadata. Close demand
  // transitively without inventing another clock or changing authored durations.
  for (const gid of ids) {
    const set = tileset(gid); if (!set) throw new Error('unknown Tiled GID '+gid);
    const definitions = set.tiles || [];
    const tile = Array.isArray(definitions) ? definitions.find(tile => tile.id === gid-set.firstgid) : definitions[gid-set.firstgid];
    for (const frame of tile && tile.animation || []) ids.add(set.firstgid+frame.tileid);
  }
  const demands = new Map(), ordinarySources = [];
  for (const set of tilesets) if (!set.image || !set.columns || !set.tilewidth || !set.tileheight || set.tileoffset ||
      set.objectalignment && set.objectalignment !== 'unspecified') preserved.add(set);
  const sourcePath = set => path.posix.normalize('img/tilesets/'+path.posix.basename(set.image.replaceAll('\\', '/')));
  const preservedImages = new Set([...preserved].filter(set => set && set.image).map(sourcePath));
  for (const set of tilesets) {
    if (!set.image || !set.columns || !set.tilewidth || !set.tileheight || set.tileoffset || set.objectalignment && set.objectalignment !== 'unspecified') {
      preserved.add(set); continue;
    }
    const source = sourcePath(set);
    ordinarySources.push(source);
    if (preservedImages.has(source)) continue;
    const rectangles = demands.get(source) || new Map();
    for (const gid of [...ids].sort((a, b) => a-b)) if (tileset(gid) === set) {
      const id = gid-set.firstgid;
      const x = (set.margin || 0)+(id%set.columns)*(set.tilewidth+(set.spacing || 0));
      const y = (set.margin || 0)+Math.floor(id/set.columns)*(set.tileheight+(set.spacing || 0));
      const rect = [x, y, set.tilewidth, set.tileheight]; rectangles.set(rect.join(','), rect);
    }
    if (rectangles.size) demands.set(source, rectangles);
  }
  return { renderer: 'tiled', contract: map, animationPhases: 'authored', tileWidth: map.tilewidth,
    features: { animation: tilesets.some(set => Object.values(set.tiles || {}).some(tile => tile.animation)),
      priority: map.layers.some(layer => layer.properties && layer.properties.priority),
      looping: false, objects: map.layers.some(layer => layer.objects && layer.objects.length),
      chunks: map.layers.some(layer => layer.chunks && layer.chunks.length) },
    tileHeight: map.tileheight, ordinarySources,
    preservedSources: tilesets.filter(set => preserved.has(set)).map(set => set.image),
    sources: [...demands].map(([source, rectangles]) => ({ source, rectangles: [...rectangles.values()] })) };
}
function geometryEstimate(demand, width, height) {
  const columns = Math.ceil(width/demand.tileWidth)+3, rows = Math.ceil(height/demand.tileHeight)+3;
  if (!demand.geometryDensity) return columns*rows*16*400;
  const mw = demand.geometryWidth, mh = demand.geometryHeight;
  let maximum = 0;
  // Bound each reached row separately; this conservative window bound avoids
  // quadratic map scans and includes wrapping maps and sparse visual planes.
  const rowMax = [];
  for (let y = 0; y < mh; y++) {
    let sum = 0, best = 0;
    for (let x = 0; x < mw+columns; x++) {
      const value = at => at < mw || demand.loopHorizontal ? demand.geometryDensity[y*mw+(at%mw)] : 0;
      sum += value(x);
      if (x >= columns) sum -= value(x-columns);
      best = Math.max(best, sum);
    }
    rowMax.push(best);
  }
  let sum = 0;
  for (let y = 0; y < mh+rows; y++) {
    const value = at => at < mh || demand.loopVertical ? rowMax[at%mh] : 0;
    sum += value(y);
    if (y >= rows) sum -= value(y-rows);
    maximum = Math.max(maximum, sum);
  }
  return maximum*400;
}
module.exports = { geometryEstimate, COMPILER_VERSION, mapContract, engineTilemap, compileRpgMap, compileTiledMap };
