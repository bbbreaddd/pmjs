'use strict';

(function() {
  var states = new WeakMap();

  function supported(map) {
    var data = map.tiledData;
    return !!(data && (!data.orientation || data.orientation === 'orthogonal') && Array.isArray(data.layers) &&
      Array.isArray(data.tilesets) && Array.isArray(map._layers) &&
      Array.isArray(map._priorityTiles) && Array.isArray(map.bitmaps) && !data.infinite &&
      [map._tileWidth, map._tileHeight, map._mapWidth, map._mapHeight, map._width, map._height].every(function(value) { return Number.isFinite(value) && value > 0; }) &&
      map._layers.every(function(layer) {
        var rect = layer && layer.children && layer.children[0];
        return !!(layer && data.layers[layer.layerId] && rect && Array.isArray(rect.pointsBuf) &&
          Array.isArray(rect.textures) && typeof rect.addRect === 'function' && typeof layer.clear === 'function');
      }) &&
      data.tilesets.every(function(set) {
        return set && [set.columns, set.tilewidth, set.tileheight].every(function(value) {
          return Number.isFinite(value) && value > 0;
        }) && Number.isFinite(set.firstgid) &&
          !set.margin && !set.spacing && (!Array.isArray(set.tiles) ||
            Object.keys(set.tiles).length === set.tiles.length && set.tiles.every(function(tile, index) { return tile && tile.id === index; }));
      }) && data.layers.every(function(layer) {
        return layer && !layer.chunks && !layer.layers &&
          (layer.type !== 'tilelayer' || Array.isArray(layer.data)) &&
          (layer.type !== 'objectgroup' || Array.isArray(layer.objects));
      }));
  }

  function windowSize(map) {
    return [Math.ceil(map._width / map._tileWidth) + 1,
      Math.ceil(map._height / map._tileHeight) + 1];
  }

  function visit(map, x, y, value, points) {
    var data = map.tiledData, size = windowSize(map);
    value(data); value(data.layers); value(data.tilesets); value(map._layers);
    value(map._priorityTiles); value(map._priorityTiles.length);
    for (var active = 0; active < (map._pmjsActivePriorityTileCount || 0); active++) {
      value(map._priorityTiles[active]);
    }
    value(map.bitmaps); value(map.bitmaps.length);
    value(x); value(y); value(size[0]); value(size[1]);
    value(map._width); value(map._height);
    value(map._tileWidth); value(map._tileHeight); value(map._mapWidth); value(map._mapHeight);
    value(map.horizontalWrap); value(map.verticalWrap);
    data.tilesets.forEach(function(set, index) {
      value(set); value(set.firstgid); value(set.tilewidth); value(set.tileheight);
      value(set.columns); value(map.bitmaps[index]);
    });
    var retained = states.get(map);
    if (retained) retained.materials.forEach(function(material) {
      var tiles = material.set.tiles, tile = tiles && tiles[material.local];
      value(tiles); value(tile);
      if (tile) {
        value(tile.id); value(tile.animation);
        if (tile.animation) tile.animation.forEach(function(frame) { value(frame.tileid); value(frame.duration); });
      }
    });
    map._layers.forEach(function(layer) {
      var meta = data.layers[layer.layerId], rect = layer.children[0];
      value(layer); value(layer.layerId); value(rect); value(rect.pointsBuf);
      value(rect.pointsBuf.length);
      points(rect.pointsBuf);
      value(rect.textures); value(rect.textures.length);
      rect.textures.forEach(value);
      value(meta); value(meta.type); value(meta.visible); value(meta.offsetx); value(meta.offsety);
      value(meta.properties && meta.properties.priority); value(meta.properties && meta.properties.zIndex);
      value(meta.properties && meta.properties.hideOnLevel); value(meta.data);
      if (meta.type !== 'tilelayer' || !meta.visible) return;
      for (var row = 0; row < size[1]; row++) {
        for (var column = 0; column < size[0]; column++) {
          value(cell(map, meta, x + column, y + row));
        }
      }
    });
    data.layers.forEach(function(layer) {
      if (layer.type !== 'objectgroup') return;
      value(layer); value(layer.offsetx); value(layer.offsety);
      value(layer.properties && layer.properties.priority);
      value(layer.properties && layer.properties.zIndex);
      value(layer.properties && layer.properties.hideOnLevel);
      value(layer.objects); value(layer.objects.length);
      layer.objects.forEach(function(object) {
        value(object.gid); value(object.visible); value(object.x); value(object.y);
        value(object.width); value(object.height);
      });
    });
  }

  function capture(map, state) {
    visit(map, state.x, state.y, function(value) { state.values.push(value); },
      function(points) {
        for (var index = 0; index < points.length; index++) state.values.push(points[index]);
      });
  }

  function cell(map, layer, x, y) {
    var width = map._mapWidth, height = map._mapHeight;
    if (map.horizontalWrap) x = ((x % width) + width) % width;
    if (map.verticalWrap) y = ((y % height) + height) % height;
    return x < 0 || y < 0 || x >= width || y >= height ? 0 : layer.data[y * width + x] || 0;
  }

  function source(map, material) {
    var id = map._getAnimTileId(material.texture, material.local);
    return [id % material.set.columns * material.set.tilewidth,
      Math.floor(id / material.set.columns) * material.set.tileheight];
  }

  function paint(map, x, y) {
    if (!supported(map)) return false;
    var state = { x: x, y: y, values: [], records: [], materials: [], dependencies: Object.create(null), generations: [] };
    var size = windowSize(map), candidates = [], materials = Object.create(null);
    function collect(gid, layerId, rect, dx, dy, priority) {
      if (!gid) return true;
      if (!Number.isInteger(gid) || gid < 0 || gid >= 0x10000000) return false;
      var material = materials[gid];
      if (!material) {
        var texture = map._getTextureId(gid), set = map.tiledData.tilesets[texture];
        if (!set) return false;
        material = materials[gid] = { texture: texture, set: set, local: gid - set.firstgid };
        material.uv = source(map, material);
        state.materials.push(material);
      }
      candidates.push({ material: material,
        layerId: layerId, rect: rect, dx: dx, dy: dy, priority: priority });
      return true;
    }
    for (var i = 0; i < map._layers.length; i++) {
      var layer = map._layers[i], meta = map.tiledData.layers[layer.layerId];
      if (!meta || !layer.children[0] || typeof layer.children[0].addRect !== 'function') return false;
      if (meta.type !== 'tilelayer' || !meta.visible) continue;
      for (var row = 0; row < size[1]; row++) {
        for (var column = 0; column < size[0]; column++) {
          if (!collect(cell(map, meta, x + column, y + row), layer.layerId,
            layer.children[0], column * map._tileWidth, row * map._tileHeight,
            map._isPriorityTile(layer.layerId))) return false;
        }
      }
    }
    for (var id = 0; id < map.tiledData.layers.length; id++) {
      var objects = map.tiledData.layers[id];
      if (objects.type !== 'objectgroup') continue;
      for (var oi = 0; oi < objects.objects.length; oi++) {
        var object = objects.objects[oi];
        if (object.visible && !collect(object.gid, id, null,
          object.x - x * map._tileWidth, object.y - y * map._tileHeight - object.height, true)) return false;
      }
    }
    map._layers.forEach(function(item) { item.clear(); });
    var active = 0;
    candidates.forEach(function(record) {
      var material = record.material, uv = material.uv, set = material.set;
      if (record.priority) {
        var sprite = map._priorityTiles[active];
        if (!sprite) return;
        active++;
        record.sprite = sprite;
        sprite.layerId = record.layerId;
        sprite.anchor.x = 0.5; sprite.anchor.y = 1;
        sprite.origX = record.dx; sprite.origY = record.dy;
        sprite.bitmap = map.bitmaps[material.texture];
        sprite.setFrame(uv[0], uv[1], set.tilewidth, set.tileheight);
        sprite.priority = map._getPriority(record.layerId);
        sprite.z = sprite.zIndex = map._getZIndex(record.layerId);
        sprite.show();
      } else {
        record.offset = record.rect.pointsBuf.length;
        record.rect.addRect(material.texture, uv[0], uv[1], record.dx, record.dy,
          set.tilewidth, set.tileheight);
        record.length = record.rect.pointsBuf.length - record.offset;
      }
      record.uv = uv;
      state.records.push(record);
      (state.dependencies[String(material.local)] || (state.dependencies[String(material.local)] = [])).push(record);
    });
    map._pmjsActivePriorityTileCount = active;
    for (var tail = active; tail < map._priorityTiles.length; tail++) {
      map._priorityTiles[tail].hide(); map._priorityTiles[tail].layerId = -1;
    }
    map._priorityTilesCount = map._priorityTiles.length;
    map._pmjsChangedAnimKeys = null; map._needsAnimRepaint = false;
    map._lastStartX = x; map._lastStartY = y; map._needsRepaint = false;
    states.set(map, state);
    capture(map, state);
    state.generations = map._layers.map(function(item) { return item.children[0]._pmjsNativeGeneration || 0; });
    map._pmjsPriorityRepaintGeneration = (map._pmjsPriorityRepaintGeneration || 0) + 1;
    updatePositions(map, x, y);
    if (globalThis.$gameMap) {
      map.hideOnLevel($gameMap.currentMapLevel);
      map._pmjsLastHideLevel = $gameMap.currentMapLevel;
      map._pmjsLastHideRepaintGeneration = map._pmjsPriorityRepaintGeneration;
    }
    return true;
  }

  function flushAnimation(map, pending) {
    var state = states.get(map);
    if (!state) return false;
    var changed = pending || map._pmjsChangedAnimKeys;
    if (!changed) return true;
    var dirty = new Set(), rebuild = false, sources = new Map(), affected = [];
    Object.keys(changed).forEach(function(key) {
      (state.dependencies[key] || []).forEach(function(record) {
        var material = record.material, uv = sources.get(material);
        if (!uv) { uv = source(map, material); sources.set(material, uv); }
        if (uv[0] === record.uv[0] && uv[1] === record.uv[1]) return;
        if (!record.sprite && material.set.tilewidth !== material.set.tileheight) rebuild = true;
        affected.push(record);
      });
    });
    if (rebuild) return paint(map, state.x, state.y);
    affected.forEach(function(record) {
      var material = record.material, uv = sources.get(material);
      if (record.sprite) record.sprite.setFrame(uv[0], uv[1], material.set.tilewidth, material.set.tileheight);
      else {
        record.rect.pointsBuf[record.offset] = uv[0];
        record.rect.pointsBuf[record.offset + 1] = uv[1]; dirty.add(record.rect);
      }
      record.uv = uv;
    });
    dirty.forEach(function(rect) {
      rect._pmjsNativeGeneration = (rect._pmjsNativeGeneration || 0) + 1;
      rect.modificationMarker = 0;
      if (rect.parent) rect.parent.modificationMarker = 0;
    });
    state.generations = map._layers.map(function(item) { return item.children[0]._pmjsNativeGeneration || 0; });
    state.values.length = 0;
    capture(map, state);
    map._pmjsChangedAnimKeys = null; map._needsAnimRepaint = false;
    return true;
  }

  function updateAnimation(map) {
    if (!supported(map)) return false;
    var changed = map._pmjsChangedAnimKeys || Object.create(null), any = false;
    Object.keys(map._animDuration).forEach(function(key) {
      map._animDuration[key]--;
      if (map._animDuration[key] <= 0) {
        map._animFrame[key]++; changed[key] = true; any = true;
      }
    });
    if (any) {
      map._updateAnimFrames();
      if (map._lastBitmapLength !== undefined && map.bitmaps.length !== map._lastBitmapLength) map.refresh();
    }
    if (any) { map._pmjsChangedAnimKeys = changed; map._needsAnimRepaint = true; }
    return true;
  }

  function updatePositions(map, x, y) {
    var ox = map.roundPixels ? Math.floor(map.origin.x) : map.origin.x;
    var oy = map.roundPixels ? Math.floor(map.origin.y) : map.origin.y;
    map._layers.forEach(function(layer) {
      var meta = map.tiledData.layers[layer.layerId];
      layer.position.x = x * map._tileWidth - ox + (meta.offsetx || 0);
      layer.position.y = y * map._tileHeight - oy + (meta.offsety || 0);
    });
    for (var index = 0; index < (map._pmjsActivePriorityTileCount || 0); index++) {
      var sprite = map._priorityTiles[index], meta = map.tiledData.layers[sprite.layerId];
      sprite.x = sprite.origX + x * map._tileWidth - ox + (meta.offsetx || 0) + sprite.width / 2;
      sprite.y = sprite.origY + y * map._tileHeight - oy + (meta.offsety || 0) + sprite.height;
    }
    return true;
  }

  function prepare(map, x, y) {
    if (!supported(map)) return false;
    var state = states.get(map), same = !!state, cursor = 0;
    if (state) {
      visit(map, x, y, function(value) { if (state.values[cursor++] !== value) same = false; },
        function(points) {
          for (var index = 0; index < points.length; index++) {
            if (state.values[cursor++] !== points[index]) same = false;
          }
        });
      if (cursor !== state.values.length) same = false;
      map._layers.forEach(function(layer, index) {
        if ((layer.children[0]._pmjsNativeGeneration || 0) !== state.generations[index]) same = false;
      });
    }
    if (!same || map._needsRepaint) { if (!paint(map, x, y)) return false; }
    else if (!flushAnimation(map)) return false;
    return updatePositions(map, x, y);
  }

  PMJS.yedRetainedTiles = { invalidate: function(map) { states.delete(map); }, supported: supported, paint: paint, prepare: prepare,
    updatePositions: updatePositions, updateAnimation: updateAnimation, flushAnimation: flushAnimation };
})();
