'use strict';

// Shared YED_Tiled fast paths for RPG Maker MV.
// Unrecognized methods stay on reference behavior.
(function() {
  if (typeof PMJS !== 'undefined' && PMJS.optimizations &&
      typeof PMJS.optimizations.register === 'function') {
    PMJS.optimizations.register({
      id: 'tilemap.yed-indexed-paint-loops',
      owner: 'plugins/yed/tiled',
      fallback: 'run the original YED tile paint and priority-tile loops'
    });
    PMJS.optimizations.register({
      id: 'tilemap.yed-indexed-animation',
      owner: 'plugins/yed/tiled',
      fallback: 'full tilemap repaint on every animation tick'
    });
  }

  // Optional aggregate counters for scene audits. Dormant unless
  // PMJS_SCENE_CENSUS=1.
  function pmjsYedCensus() {
    // Resolve once: per-frame call sites must not pay a NativeHost env
    // lookup on every call while the census stays disabled all session.
    if (typeof pmjsYedCensus.enabled !== 'boolean') {
      var enabled = false;
      try {
        enabled = typeof NativeHost !== 'undefined' && NativeHost &&
          NativeHost.runtime &&
          typeof NativeHost.runtime.env === 'function' &&
          NativeHost.runtime.env('PMJS_SCENE_CENSUS') === '1';
      } catch (_) { enabled = false; }
      pmjsYedCensus.enabled = enabled;
    }
    if (!pmjsYedCensus.enabled) return null;
    try {
      if (!globalThis.__pmjsYedCensus) {
        globalThis.__pmjsYedCensus = { updateLayerCalls: 0,
          layerVisited: 0, layerChanged: 0, priorityVisited: 0,
          priorityChanged: 0, poolSize: 0, active: 0, hidden: 0, repaints: 0,
          animRepaints: 0, animPatches: 0,
          hideCalls: 0, hideExecutions: 0, hideLevelChanges: 0,
          lastHideLevel: null, lastRepaintGeneration: 0 };
      }
      return globalThis.__pmjsYedCensus;
    } catch (_) {
      return null;
    }
  }

  function fnSource(fn) {
    return Function.prototype.toString.call(fn);
  }

  function isGuarded(fn) {
    return !!(fn && fn._pmjsYedGuard);
  }

  // Shipped shape: reset priority cursor, repaint layers, hide tail.
  function looksLikeKnownYedPaintAllTiles(fn) {
    if (typeof fn !== 'function' || isGuarded(fn)) return false;
    var str = fnSource(fn);
    return str.indexOf('_priorityTilesCount') !== -1 &&
           str.indexOf('objectgroup') !== -1 &&
           str.indexOf('_paintObjectLayers') !== -1 &&
           str.indexOf('_paintTiles') !== -1 &&
           str.indexOf('_priorityTiles.length') !== -1 &&
           str.indexOf('.hide()') !== -1 &&
           (str.indexOf('layerId = -1') !== -1 ||
            str.indexOf('layerId=-1') !== -1);
  }

  // Shipped shape: floor origin on roundPixels, reposition layers/priority.
  function looksLikeKnownYedUpdateLayerPositions(fn) {
    if (typeof fn !== 'function' || isGuarded(fn)) return false;
    var str = fnSource(fn);
    return str.indexOf('roundPixels') !== -1 &&
           str.indexOf('_layers') !== -1 &&
           str.indexOf('_priorityTiles') !== -1 &&
           str.indexOf('origX') !== -1 &&
           str.indexOf('Math.floor') !== -1 &&
           (str.indexOf('Symbol.iterator') !== -1 ||
            str.indexOf('_iterator') !== -1);
  }

  // Shipped shape: skip gid-less/hidden objects, paint priority tiles.
  function looksLikeKnownYedPaintObjectLayers(fn) {
    if (typeof fn !== 'function' || isGuarded(fn)) return false;
    var str = fnSource(fn);
    return str.indexOf('objects') !== -1 &&
           str.indexOf('_getTextureId') !== -1 &&
           str.indexOf('_paintPriorityTile') !== -1 &&
           str.indexOf('gid') !== -1 &&
           str.indexOf('visible') !== -1;
  }

  // Shipped shape: overdrawn tile grid, paint every cell.
  function looksLikeKnownYedPaintTilesLayer(fn) {
    if (typeof fn !== 'function' || isGuarded(fn)) return false;
    var str = fnSource(fn);
    return str.indexOf('Math.ceil') !== -1 &&
           str.indexOf('_tileWidth') !== -1 &&
           str.indexOf('_tileHeight') !== -1 &&
           str.indexOf('_paintTile') !== -1;
  }

  // Shipped shape: map bounds, wrap, texture id, anim tile id, addRect/priority.
  function looksLikeKnownYedPaintTile(fn) {
    if (typeof fn !== 'function' || isGuarded(fn)) return false;
    var str = fnSource(fn);
    return str.indexOf('horizontalWrap') !== -1 &&
           str.indexOf('tilePosition') !== -1 &&
           str.indexOf('_getTextureId') !== -1 &&
           str.indexOf('_getAnimTileId') !== -1 &&
           str.indexOf('_isPriorityTile') !== -1 &&
           str.indexOf('addRect') !== -1;
  }

  // Shipped shape: priority tile sprite setup from pool.
  function looksLikeKnownYedPaintPriorityTile(fn) {
    if (typeof fn !== 'function' || isGuarded(fn)) return false;
    var str = fnSource(fn);
    return str.indexOf('origX') !== -1 &&
           str.indexOf('origY') !== -1 &&
           str.indexOf('setFrame') !== -1 &&
           str.indexOf('_priorityTilesCount') !== -1;
  }

  // Shipped shape: animation timer decrement, advance frame, refresh.
  function looksLikeKnownYedUpdateAnim(fn) {
    if (typeof fn !== 'function' || isGuarded(fn)) return false;
    var str = fnSource(fn);
    return str.indexOf('_animDuration') !== -1 &&
           str.indexOf('_animFrame') !== -1 &&
           str.indexOf('_updateAnimFrames') !== -1 &&
           str.indexOf('refresh') !== -1;
  }

  function looksLikeKnownShaderTilemapUpdateTransform(tiledProto) {
    if (Object.prototype.hasOwnProperty.call(tiledProto, 'updateTransform')) {
      return false;
    }
    var fn = tiledProto.updateTransform;
    if (typeof fn !== 'function' || isGuarded(fn)) return false;
    var str = fnSource(fn);
    return str.indexOf('_updateLayerPositions') !== -1 &&
           str.indexOf('_needsRepaint') !== -1 &&
           str.indexOf('_lastStartX') !== -1 &&
           str.indexOf('_lastStartY') !== -1 &&
           str.indexOf('_paintAllTiles') !== -1 &&
           str.indexOf('_sortChildren') !== -1 &&
           str.indexOf('PIXI.Container.prototype.updateTransform.call(this)') !== -1;
  }

  function looksLikeKnownYedImplementation(tiledProto) {
    return looksLikeKnownYedPaintAllTiles(tiledProto._paintAllTiles) &&
           looksLikeKnownYedUpdateLayerPositions(tiledProto._updateLayerPositions) &&
           looksLikeKnownYedPaintObjectLayers(tiledProto._paintObjectLayers) &&
           looksLikeKnownYedPaintTilesLayer(tiledProto._paintTilesLayer);
  }

  function looksLikeKnownYedChildOrder(fn) {
    if (fn === undefined) return true;
    if (typeof fn !== 'function' || isGuarded(fn)) return false;
    var body = fnSource(fn);
    body = body.slice(body.indexOf('{') + 1, body.lastIndexOf('}'));
    return body.replace(/\s+/g, '') ===
      'if((a.z||0)!==(b.z||0)){return(a.z||0)-(b.z||0);}' +
      'elseif((a.y||0)!==(b.y||0)){return(a.y||0)-(b.y||0);}' +
      'elseif((a.priority||0)!==(b.priority||0)){' +
      'return(a.priority||0)-(b.priority||0);}' +
      'else{returna.spriteId-b.spriteId;}';
  }

  function looksLikeKnownYedHideOnLevel(fn) {
    if (typeof fn !== 'function') return false;
    var body = fnSource(fn);
    body = body.slice(body.indexOf('{') + 1, body.lastIndexOf('}'));
    return body.replace(/\s+/g, '') ===
      'this._tilemap.hideOnLevel($gameMap.currentMapLevel);';
  }

  function looksLikeKnownYedIndexedAnimation(tiledProto) {
    return typeof tiledProto._paintTile === 'function' &&
           looksLikeKnownYedPaintTile(tiledProto._paintTile) &&
           typeof tiledProto._paintPriorityTile === 'function' &&
           looksLikeKnownYedPaintPriorityTile(tiledProto._paintPriorityTile) &&
           typeof tiledProto._updateAnim === 'function' &&
           looksLikeKnownYedUpdateAnim(tiledProto._updateAnim) &&
           looksLikeKnownShaderTilemapUpdateTransform(tiledProto);
  }

  function installYedTiledFastPaths(tiledConstructor) {
    if (typeof tiledConstructor !== 'function' &&
        typeof globalThis.TiledTilemap === 'function') {
      tiledConstructor = globalThis.TiledTilemap;
    }
    if (typeof tiledConstructor !== 'function' ||
        typeof Spriteset_Map !== 'function') return false;

    var tiledProto = tiledConstructor.prototype;
    if (!tiledProto || tiledProto._pmjsIndexedPaintLoops) return true;

    if (!looksLikeKnownYedImplementation(tiledProto) ||
        !looksLikeKnownYedChildOrder(tiledProto._compareChildOrder)) {
      PMJS.optimizations.refuse('tilemap.yed-indexed-paint-loops',
        'unrecognized YED tilemap method composition');
      PMJS.optimizations.refuse('tilemap.yed-indexed-animation',
        'unrecognized YED tilemap method composition');
      return false;
    }

    var useIndexedPaintLoops = PMJS.optimizations.isEnabled('tilemap.yed-indexed-paint-loops');
    if (!useIndexedPaintLoops) {
      if (PMJS.optimizations.isEnabled('tilemap.yed-indexed-animation')) {
        PMJS.optimizations.refuse('tilemap.yed-indexed-animation',
          'requires tilemap.yed-indexed-paint-loops');
      }
      return true;
    }

    var useIndexedAnimation = PMJS.optimizations.isEnabled('tilemap.yed-indexed-animation');
    if (useIndexedAnimation && !looksLikeKnownYedIndexedAnimation(tiledProto)) {
      PMJS.optimizations.refuse('tilemap.yed-indexed-animation',
        'unrecognized YED animation method composition');
      useIndexedAnimation = false;
    }

    tiledProto._updateLayerPositions = function(startX, startY) {
      var ox = this.roundPixels ? Math.floor(this.origin.x) : this.origin.x;
      var oy = this.roundPixels ? Math.floor(this.origin.y) : this.origin.y;
      var census = typeof pmjsYedCensus === 'function' ? pmjsYedCensus() : null;
      var layers = this._layers || [];
      for (var index = 0; index < layers.length; index++) {
        var layer = layers[index];
        var layerData = this.tiledData.layers[layer.layerId];
        var newX = startX * this._tileWidth - ox +
          (layerData.offsetx || 0);
        var newY = startY * this._tileHeight - oy +
          (layerData.offsety || 0);
        if (census) {
          census.layerVisited++;
          if (layer.position.x !== newX || layer.position.y !== newY) {
            census.layerChanged++;
          }
        }
        layer.position.x = newX;
        layer.position.y = newY;
      }
      var priorityTiles = this._priorityTiles || [];
      var activePriorityTiles = Math.max(0, Math.min(priorityTiles.length,
        Number(this._pmjsActivePriorityTileCount) || 0));
      if (census) {
        census.updateLayerCalls++;
        census.poolSize = priorityTiles.length;
        census.active = activePriorityTiles;
        census.hidden = priorityTiles.length - activePriorityTiles;
      }
      for (var priorityIndex = 0; priorityIndex < activePriorityTiles;
          priorityIndex++) {
        var sprite = priorityTiles[priorityIndex];
        var priorityLayer = this.tiledData.layers[sprite.layerId];
        var offsetX = priorityLayer ? priorityLayer.offsetx || 0 : 0;
        var offsetY = priorityLayer ? priorityLayer.offsety || 0 : 0;
        var spriteX = sprite.origX + startX * this._tileWidth - ox + offsetX +
          sprite.width / 2;
        var spriteY = sprite.origY + startY * this._tileHeight - oy + offsetY +
          sprite.height;
        if (census) {
          census.priorityVisited++;
          if (sprite.x !== spriteX || sprite.y !== spriteY) {
            census.priorityChanged++;
          }
        }
        sprite.x = spriteX;
        sprite.y = spriteY;
      }
    };

    tiledProto._paintTilesLayer = function(layer, startX, startY) {
      var tileCols = Math.ceil(this._width / this._tileWidth) + 1;
      var tileRows = Math.ceil(this._height / this._tileHeight) + 1;
      for (var y = 0; y < tileRows; y++) {
        for (var x = 0; x < tileCols; x++) {
          this._paintTile(layer, startX, startY, x, y);
        }
      }
    };

    tiledProto._paintObjectLayers = function(layerId, startX, startY) {
      var layerData = this.tiledData.layers[layerId];
      var objects = layerData.objects || [];
      for (var index = 0; index < objects.length; index++) {
        var object = objects[index];
        if (!object.gid || !object.visible) continue;
        var tileId = object.gid;
        var textureId = this._getTextureId(tileId);
        var dx = object.x - startX * this._tileWidth;
        var dy = object.y - startY * this._tileHeight - object.height;
        this._paintPriorityTile(layerId, textureId, tileId,
          startX, startY, dx, dy);
      }
    };

    tiledProto._paintAllTiles = function(startX, startY) {
      this._priorityTilesCount = 0;
      this._pmjsAnimPrioritySprites = Object.create(null);
      this._pmjsFallbackAnimKeys = Object.create(null);
      this._pmjsChangedAnimKeys = null;
      this._needsAnimRepaint = false;

      var layers = this._layers || [];
      for (var index = 0; index < layers.length; index++) {
        if (layers[index]) layers[index]._pmjsAnimRecords = Object.create(null);
        layers[index].clear();
        this._paintTiles(layers[index], startX, startY);
      }
      var tiledLayers = this.tiledData.layers || [];
      for (var layerId = 0; layerId < tiledLayers.length; layerId++) {
        if (tiledLayers[layerId].type === 'objectgroup') {
          this._paintObjectLayers(layerId, startX, startY);
        }
      }
      // Snapshot the active prefix before the tail loop consumes the cursor.
      var activePriorityTileCount = this._priorityTilesCount;
      while (this._priorityTilesCount < this._priorityTiles.length) {
        var sprite = this._priorityTiles[this._priorityTilesCount];
        sprite.hide();
        sprite.layerId = -1;
        this._priorityTilesCount++;
      }
      this._pmjsActivePriorityTileCount = activePriorityTileCount;
      this._pmjsPriorityRepaintGeneration =
        (this._pmjsPriorityRepaintGeneration || 0) + 1;
      var paintCensus = typeof pmjsYedCensus === 'function' ?
        pmjsYedCensus() : null;
      if (paintCensus) {
        paintCensus.repaints++;
        paintCensus.poolSize = this._priorityTiles.length;
        paintCensus.active = activePriorityTileCount;
        paintCensus.hidden = this._priorityTiles.length - activePriorityTileCount;
        paintCensus.lastRepaintGeneration =
          this._pmjsPriorityRepaintGeneration;
      }

      if (globalThis.PMJS_DEVELOPMENT_MODE) {
        for (var devI = activePriorityTileCount; devI < this._priorityTiles.length; devI++) {
          if (this._priorityTiles[devI].visible) {
            throw new Error('YED priority tile visible outside PMJS active prefix');
          }
        }
      }

      if (typeof this.hideOnLevel === 'function' && globalThis.$gameMap) {
        // Repaint re-shows tiles after the update-phase check; rehide here.
        var currentLevel = $gameMap.currentMapLevel;
        this.hideOnLevel(currentLevel);
        this._pmjsLastHideLevel = currentLevel;
        this._pmjsLastHideRepaintGeneration =
          this._pmjsPriorityRepaintGeneration;
      }
    };

    tiledProto._updateLayerPositions._pmjsYedGuard = true;
    tiledProto._paintTilesLayer._pmjsYedGuard = true;
    tiledProto._paintObjectLayers._pmjsYedGuard = true;
    tiledProto._paintAllTiles._pmjsYedGuard = true;
    tiledProto._pmjsIndexedPaintLoops = true;

    if (useIndexedAnimation) {
      tiledProto._paintTile = function(layer, startX, startY, x, y) {
        var mx = x + startX;
        var my = y + startY;
        if (this.horizontalWrap) {
          mx = mx.mod(this._mapWidth);
        }
        if (this.verticalWrap) {
          my = my.mod(this._mapHeight);
        }
        var tilePosition = mx + my * this._mapWidth;
        var layerObj = this.tiledData.layers[layer.layerId];
        var tileId = layerObj && layerObj.data ? layerObj.data[tilePosition] : 0;
        var rectLayer = layer.children && layer.children[0];
        if (!rectLayer || !tileId) {
          return;
        }

        if (mx < 0 || mx >= this._mapWidth || my < 0 || my >= this._mapHeight) {
          return;
        }

        var textureId = this._getTextureId(tileId);
        var tileset = this.tiledData.tilesets[textureId];
        if (!tileset) return;
        var dx = x * this._tileWidth;
        var dy = y * this._tileHeight;
        var w = tileset.tilewidth;
        var h = tileset.tileheight;
        var tileCols = tileset.columns;
        var localId = tileId - tileset.firstgid;
        var rId = this._getAnimTileId(textureId, localId);
        var ux = (rId % tileCols) * w;
        var uy = Math.floor(rId / tileCols) * h;

        if (this._isPriorityTile(layer.layerId)) {
          this._paintPriorityTile(layer.layerId, textureId, tileId, startX, startY, dx, dy);
          return;
        }

        var pointOffset = rectLayer.pointsBuf.length;
        rectLayer.addRect(textureId, ux, uy, dx, dy, w, h);

        var tilesData = tileset.tiles;
        if (tilesData && tilesData[localId] && tilesData[localId].animation) {
          var key = String(localId);
          if (w === h) {
            if (!layer._pmjsAnimRecords) layer._pmjsAnimRecords = Object.create(null);
            var records = layer._pmjsAnimRecords[key];
            if (!records) records = layer._pmjsAnimRecords[key] = [];
            records.push({
              rectLayer: rectLayer,
              pointOffset: pointOffset,
              textureId: textureId,
              localId: localId,
              w: w,
              h: h,
              tileCols: tileCols
            });
          } else {
            if (!this._pmjsFallbackAnimKeys) this._pmjsFallbackAnimKeys = Object.create(null);
            this._pmjsFallbackAnimKeys[key] = true;
          }
        }
      };

      tiledProto._paintPriorityTile = function(layerId, textureId, tileId, startX, startY, dx, dy) {
        var tileset = this.tiledData.tilesets[textureId];
        if (!tileset) return;
        var w = tileset.tilewidth;
        var h = tileset.tileheight;
        var tileCols = tileset.columns;
        var localId = tileId - tileset.firstgid;
        var rId = this._getAnimTileId(textureId, localId);
        var ux = (rId % tileCols) * w;
        var uy = Math.floor(rId / tileCols) * h;

        if (this._priorityTilesCount >= this._priorityTiles.length) {
          return;
        }
        var sprite = this._priorityTiles[this._priorityTilesCount];
        var layerData = this.tiledData.layers[layerId];
        var offsetX = layerData ? layerData.offsetx || 0 : 0;
        var offsetY = layerData ? layerData.offsety || 0 : 0;
        var ox = this.roundPixels ? Math.floor(this.origin.x) : this.origin.x;
        var oy = this.roundPixels ? Math.floor(this.origin.y) : this.origin.y;

        sprite.layerId = layerId;
        sprite.anchor.x = 0.5;
        sprite.anchor.y = 1.0;
        sprite.origX = dx;
        sprite.origY = dy;
        sprite.x = sprite.origX + startX * this._tileWidth - ox + offsetX + w / 2;
        sprite.y = sprite.origY + startY * this._tileHeight - oy + offsetY + h;
        sprite.bitmap = this.bitmaps[textureId];
        sprite.setFrame(ux, uy, w, h);
        sprite.priority = this._getPriority(layerId);
        sprite.z = sprite.zIndex = this._getZIndex(layerId);
        sprite.show();

        this._priorityTilesCount += 1;

        var tilesData = tileset.tiles;
        if (tilesData && tilesData[localId] && tilesData[localId].animation) {
          var key = String(localId);
          if (!this._pmjsAnimPrioritySprites) this._pmjsAnimPrioritySprites = Object.create(null);
          var list = this._pmjsAnimPrioritySprites[key];
          if (!list) list = this._pmjsAnimPrioritySprites[key] = [];
          list.push({
            sprite: sprite,
            textureId: textureId,
            localId: localId,
            w: w,
            h: h,
            tileCols: tileCols
          });
        }
      };

      tiledProto._updateAnim = function() {
        var changedKeys = null;
        for (var key in this._animDuration) {
          this._animDuration[key] -= 1;
          if (this._animDuration[key] <= 0) {
            this._animFrame[key] += 1;
            if (!changedKeys) changedKeys = [];
            changedKeys.push(key);
          }
        }

        if (changedKeys) {
          this._updateAnimFrames();

          if (this.bitmaps && this._lastBitmapLength !== this.bitmaps.length) {
            this.refresh();
            this._needsAnimRepaint = false;
            this._pmjsChangedAnimKeys = null;
            return;
          }

          if (this._pmjsFallbackAnimKeys) {
            for (var f = 0; f < changedKeys.length; f++) {
              if (this._pmjsFallbackAnimKeys[changedKeys[f]]) {
                this.refresh();
                this._needsAnimRepaint = false;
                this._pmjsChangedAnimKeys = null;
                return;
              }
            }
          }

          var pending = this._pmjsChangedAnimKeys;
          if (!pending) pending = this._pmjsChangedAnimKeys = Object.create(null);
          for (var c = 0; c < changedKeys.length; c++) {
            pending[changedKeys[c]] = true;
          }
          this._needsAnimRepaint = true;
        }
      };

      tiledProto._paintAnimTiles = function(pendingKeys) {
        if (!pendingKeys) return;

        var census = typeof pmjsYedCensus === 'function' ? pmjsYedCensus() : null;
        if (census) {
          census.animRepaints = (census.animRepaints || 0) + 1;
        }

        var layers = this._layers || [];
        for (var l = 0; l < layers.length; l++) {
          var layer = layers[l];
          var animRecords = layer._pmjsAnimRecords;
          if (!animRecords) continue;

          var dirtiedRectLayers = null;

          for (var key in pendingKeys) {
            var instances = animRecords[key];
            if (!instances) continue;

            for (var i = 0; i < instances.length; i++) {
              var inst = instances[i];
              var rId = this._getAnimTileId(inst.textureId, inst.localId);
              var ux = (rId % inst.tileCols) * inst.w;
              var uy = Math.floor(rId / inst.tileCols) * inst.h;

              var points = inst.rectLayer.pointsBuf;
              var offset = inst.pointOffset;
              if (points && offset + 1 < points.length &&
                  (points[offset] !== ux || points[offset + 1] !== uy)) {
                points[offset] = ux;
                points[offset + 1] = uy;
                if (census) {
                  census.animPatches = (census.animPatches || 0) + 1;
                }
                if (!dirtiedRectLayers) dirtiedRectLayers = [];
                if (dirtiedRectLayers.indexOf(inst.rectLayer) === -1) {
                  dirtiedRectLayers.push(inst.rectLayer);
                }
              }
            }
          }

          if (dirtiedRectLayers) {
            for (var d = 0; d < dirtiedRectLayers.length; d++) {
              var rl = dirtiedRectLayers[d];
              rl.modificationMarker = 0;
              if (rl.parent) {
                rl.parent.modificationMarker = 0;
              }
              rl._pmjsNativeGeneration = (rl._pmjsNativeGeneration || 0) + 1;
            }
          }
        }

        var prioritySprites = this._pmjsAnimPrioritySprites;
        if (prioritySprites) {
          for (var pKey in pendingKeys) {
            var pList = prioritySprites[pKey];
            if (!pList) continue;

            for (var p = 0; p < pList.length; p++) {
              var pEntry = pList[p];
              var pId = this._getAnimTileId(pEntry.textureId, pEntry.localId);
              var pUx = (pId % pEntry.tileCols) * pEntry.w;
              var pUy = Math.floor(pId / pEntry.tileCols) * pEntry.h;

              var s = pEntry.sprite;
              if (!s._frame || s._frame.x !== pUx || s._frame.y !== pUy ||
                  s._frame.width !== pEntry.w ||
                  s._frame.height !== pEntry.h) {
                s.setFrame(pUx, pUy, pEntry.w, pEntry.h);
              }
            }
          }
        }
      };

      tiledProto.updateTransform = function() {
        var ox = this.roundPixels ? Math.floor(this.origin.x) : this.origin.x;
        var oy = this.roundPixels ? Math.floor(this.origin.y) : this.origin.y;
        var margin = this._margin || 0;
        var startX = Math.floor((ox - margin) / this._tileWidth);
        var startY = Math.floor((oy - margin) / this._tileHeight);
        this._updateLayerPositions(startX, startY);

        var isFullRepaint = this._needsRepaint ||
            this._lastStartX !== startX || this._lastStartY !== startY;

        if (isFullRepaint) {
          this._lastStartX = startX;
          this._lastStartY = startY;
          this._paintAllTiles(startX, startY);
          this._needsRepaint = false;
          this._needsAnimRepaint = false;
          this._pmjsChangedAnimKeys = null;
        } else if (this._needsAnimRepaint && this._pmjsChangedAnimKeys) {
          var pending = this._pmjsChangedAnimKeys;
          this._pmjsChangedAnimKeys = null;
          this._needsAnimRepaint = false;
          this._paintAnimTiles(pending);
        }

        if (typeof this._sortChildren === 'function') {
          this._sortChildren();
        }
        if (typeof PIXI.Container.prototype.updateTransform === 'function') {
          PIXI.Container.prototype.updateTransform.call(this);
        }
      };

      tiledProto._paintTile._pmjsYedGuard = true;
      tiledProto._paintPriorityTile._pmjsYedGuard = true;
      tiledProto._updateAnim._pmjsYedGuard = true;
      tiledProto._paintAnimTiles._pmjsYedGuard = true;
      tiledProto.updateTransform._pmjsYedGuard = true;
      tiledProto._pmjsIndexedAnimation = true;
    }

    if (looksLikeKnownYedHideOnLevel(
          Spriteset_Map.prototype._updateHideOnLevel) &&
        !Spriteset_Map.prototype._pmjsStateDrivenHideOnLevel) {
      var updateHideOnLevel = Spriteset_Map.prototype._updateHideOnLevel;
      Spriteset_Map.prototype._updateHideOnLevel = function() {
        var tilemap = this._tilemap;
        var currentLevel = $gameMap.currentMapLevel;
        var repaintGeneration = tilemap._pmjsPriorityRepaintGeneration || 0;
        var hideCensus = typeof pmjsYedCensus === 'function' ?
          pmjsYedCensus() : null;
        if (hideCensus) {
          hideCensus.hideCalls++;
          hideCensus.lastHideLevel = currentLevel;
          hideCensus.lastRepaintGeneration = repaintGeneration;
        }
        if (tilemap._pmjsLastHideLevel === currentLevel &&
            tilemap._pmjsLastHideRepaintGeneration === repaintGeneration) return;
        updateHideOnLevel.call(this);
        if (hideCensus) {
          hideCensus.hideExecutions++;
          if (tilemap._pmjsLastHideLevel !== currentLevel) {
            hideCensus.hideLevelChanges++;
          }
        }
        tilemap._pmjsLastHideLevel = currentLevel;
        tilemap._pmjsLastHideRepaintGeneration = repaintGeneration;
      };
      Spriteset_Map.prototype._pmjsStateDrivenHideOnLevel = true;
    }

    return true;
  }

  globalThis.pmjsInstallYedTiledFastPaths = installYedTiledFastPaths;

  function activateYedTiled() {
    if (typeof globalThis.TiledTilemap !== 'function') {
      PMJS.optimizations.refuse('tilemap.yed-indexed-paint-loops',
        'YED tilemap constructor unavailable after guest plugins');
      PMJS.optimizations.refuse('tilemap.yed-indexed-animation',
        'YED tilemap constructor unavailable after guest plugins');
      return;
    }
    installYedTiledFastPaths();
  }

  PMJS.plugins.onLoaded('YED_Tiled', 'pmjs.adapter.yed-tiled', function() {
    PMJS.phases.on('afterGuestPlugins', 'pmjs.adapter.yed-tiled', activateYedTiled);
  });
})();
