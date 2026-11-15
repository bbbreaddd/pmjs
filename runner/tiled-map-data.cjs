'use strict';
const fs = require('node:fs');
const path = require('node:path');

function loadTiledMap(root, source, mapData = null) {
  root = path.resolve(root);
  function relative(base, file) {
    const resolved = path.resolve(base, file);
    const name = path.relative(root, resolved);
    if (!name || name === '..' || name.startsWith('..' + path.sep) || path.isAbsolute(name))
      throw new Error(`${source}: asset path escapes game root`);
    return { resolved, name: name.split(path.sep).join('/') };
  }
  function read(file) {
    try { return JSON.parse(fs.readFileSync(file.resolved, 'utf8')); }
    catch (error) { throw new Error(`${file.name}: ${error.message}`); }
  }
  const file = relative(root, source), map = mapData || read(file);
  if (map.orientation !== 'orthogonal' || map.renderorder !== 'right-down' || map.infinite)
    throw new Error(`${source}: unsupported map orientation or layout`);
  for (const field of ['width', 'height', 'tilewidth', 'tileheight'])
    if (!Number.isSafeInteger(map[field]) || map[field] < 1 || map[field] > 16384)
      throw new Error(`${source}: invalid ${field}`);
  if (map.width * map.height > 1048576) throw new Error(`${source}: map is too large`);
  function properties(value) {
    if (value === undefined) return {};
    if (Array.isArray(value)) return Object.fromEntries(value.map(item => [item.name, item.value]));
    return { ...value };
  }
  const layers = (map.layers || []).flatMap((layer, index) => {
    const at = `${source}.layers[${index}]`;
    if (layer.type === 'objectgroup') {
      if (!Array.isArray(layer.objects)) throw new Error(`${at}: unsupported layer representation`);
      for (const [i, object] of layer.objects.entries()) {
        if (!object.gid || object.visible === false) continue;
        if (!Number.isInteger(object.gid) || object.gid < 1 || object.gid > 0x1fffffff ||
            ![object.x, object.y, object.height].every(Number.isFinite))
          throw new Error(`${at}.objects[${i}]: invalid tile object`);
      }
      return [{ ...layer, properties: properties(layer.properties),
        objects: layer.objects.map(object => ({ ...object, properties: properties(object.properties) })) }];
    }
    if (layer.type !== 'tilelayer' || layer.encoding || layer.compression || layer.chunks)
      throw new Error(`${at}: unsupported layer representation`);
    if (layer.width !== map.width || layer.height !== map.height ||
        !Array.isArray(layer.data) || layer.data.length !== map.width * map.height)
      throw new Error(`${at}: invalid layer extent`);
    for (const [i, gid] of layer.data.entries())
      if (!Number.isInteger(gid) || gid < 0 || gid > 0x1fffffff)
        throw new Error(`${at}.data[${i}]: unsupported tile ID or flip flags`);
    const props = properties(layer.properties);
    return [{ ...layer, visible: props.collision || props.regionId || props.toLevel ||
      props.reflectionSurface || props.reflectionCast ? false : layer.visible, properties: props }];
  });
  const tilesets = (map.tilesets || []).map((entry, index) => {
    const at = `${source}.tilesets[${index}]`;
    if (!Number.isSafeInteger(entry.firstgid) || entry.firstgid < 1)
      throw new Error(`${at}: invalid first tile ID`);
    const definition = entry.source ? relative(path.dirname(file.resolved), entry.source) : file;
    const set = entry.source ? read(definition) : entry;
    if (!set.image || set.margin || set.spacing || set.tilewidth !== map.tilewidth || set.tileheight !== map.tileheight ||
        !Number.isSafeInteger(set.columns) || set.columns < 1 || !Number.isSafeInteger(set.tilecount) || set.tilecount < 1)
      throw new Error(`${at}: unsupported tileset geometry`);
    const image = relative(path.dirname(definition.resolved), set.image).name;
    const tiles = {};
    const definitions = Array.isArray(set.tiles) ? set.tiles : Object.entries(set.tiles || {}).map(([id,tile]) => ({ ...tile, id: Number(id) }));
    for (const tile of definitions) {
      if (!Number.isSafeInteger(tile.id) || tile.id < 0 || tile.id >= set.tilecount || tile.image)
        throw new Error(`${at}: unsupported individual tile`);
      for (const frame of tile.animation || [])
        if (!Number.isSafeInteger(frame.tileid) || frame.tileid < 0 || frame.tileid >= set.tilecount ||
            !Number.isSafeInteger(frame.duration) || frame.duration < 1)
          throw new Error(`${at}.tiles[${tile.id}]: invalid animation frame`);
      tiles[tile.id] = { ...tile, properties: properties(tile.properties) };
    }
    return { ...set, firstgid: entry.firstgid, image, tiles, tileproperties: set.tileproperties || {} };
  });
  for (let i = 1; i < tilesets.length; ++i)
    if (tilesets[i].firstgid < tilesets[i-1].firstgid + tilesets[i-1].tilecount)
      throw new Error(`${source}: overlapping tileset ranges`);
  for (const [index, layer] of layers.entries()) {
    const ids = layer.type === 'objectgroup' ? layer.objects.map(object => object.gid || 0) : layer.data;
    for (const [i, gid] of ids.entries())
      if (gid && !tilesets.some(set => gid >= set.firstgid && gid < set.firstgid + set.tilecount))
        throw new Error(`${source}.layers[${index}].${layer.type === 'objectgroup' ? 'objects' : 'data'}[${i}]: unknown tile ID`);
  }
  const sourceLayers = (map.layers || []).map(layer => ({ ...layer, properties: properties(layer.properties),
    ...(layer.objects ? { objects: layer.objects.map(object => ({ ...object, properties: properties(object.properties) })) } : {}) }));
  return { ...map, layers, sourceLayers, tilesets };

}
module.exports = { loadTiledMap };
