'use strict';

(function() {

  // MV 1.6.1 membership and YEP_SlipperyTiles 1.05 query.
  var KNOWN_CONTAINS = ['0a14e5f3f0be233bf31d33eeecb6d55d5c34aca2a60a567f65891cbf7dc7e3f5', 'c8973dbd38a3d5da461ca1d9e5292a6f120b88595b65888819c5e70f95a3ccac'];
  var KNOWN_SLIPPERY_QUERY = ['425386319071765fdcb4f7874c65eb031dbe13f651098a84b1e1ff633505ccbe'];
  var KNOWN_TERRAIN_TAG = 'c486790fa3a2b6c29178f7ba022359887fbb889cc1e5c0288e57cde42241ea57';
  var KNOWN_LAYERED_TILES = '3022b0dfce3d969db2d6bce417c7054c35790aff4d352c7f0be77d7e7b5564d8';
  var KNOWN_TILE_ID = '2ac59a6abab4d58c850ce7c6875d13a0248b7e888ae81c868bee5f17b8adf753';

  function install() {
    if (!PMJS.optimizations.isEnabled('plugins.yanfly.slippery-tiles')) {
      return false;
    }

    var mapProto = typeof Game_Map !== 'undefined' &&
      Game_Map.prototype ? Game_Map.prototype : null;
    if (!mapProto || typeof mapProto.isSlippery !== 'function') {
      PMJS.optimizations.refuse('plugins.yanfly.slippery-tiles',
        'Yanfly map methods unavailable');
      return false;
    }
    if (mapProto.__pmjsSlipperyTilesGuard) return true;

    if (!PMJS.methods.matchesSource(mapProto.isSlippery, KNOWN_SLIPPERY_QUERY)) {
      PMJS.optimizations.refuse('plugins.yanfly.slippery-tiles',
        'unrecognized Yanfly isSlippery method composition');
      return false;
    }

    var originalIsSlippery = mapProto.isSlippery;
    var stockContains = Array.prototype.contains;
    var nativeIndexOf = Array.prototype.indexOf;
    var knownContains = typeof stockContains === 'function' &&
      PMJS.methods.matchesSource(stockContains, KNOWN_CONTAINS) &&
      /\[native code\]/.test(PMJS.methods.sourceOf(nativeIndexOf));
    var terrainTag = mapProto.terrainTag;
    var layeredTiles = mapProto.layeredTiles;
    var tileId = mapProto.tileId;
    var nativePush = Array.prototype.push;
    var inlineTerrain = PMJS.methods.matchesSource(terrainTag, KNOWN_TERRAIN_TAG) &&
      PMJS.methods.matchesSource(layeredTiles, KNOWN_LAYERED_TILES) &&
      PMJS.methods.matchesSource(tileId, KNOWN_TILE_ID) &&
      /\[native code\]/.test(PMJS.methods.sourceOf(nativePush));
    if (!knownContains || typeof Yanfly === 'undefined' || !Yanfly.Param ||
        Yanfly.Param.SlipRegion !== 0 && !inlineTerrain) {
      PMJS.optimizations.refuse('plugins.yanfly.slippery-tiles',
        'slippery region or array membership composition requires guest query');
      return false;
    }

    mapProto.isSlippery = function(mx, my) {
      if (inlineTerrain && Yanfly.Param.SlipRegion !== 0) {
        if ($gameParty.inBattle()) return false;
        if (!this.isValid(mx, my) || !this.tileset()) return false;
        if (Yanfly.Param.SlipRegion !== 0 &&
            this.regionId(mx, my) === Yanfly.Param.SlipRegion) return true;
        var tagId;
        if (this.terrainTag === terrainTag) {
          tagId = 0;
          if (this.isValid(mx, my)) {
            var flags = this.tilesetFlags();
            if (this.layeredTiles === layeredTiles && this.tileId === tileId &&
                Array.prototype.push === nativePush) {
              // Preserve eager tile reads before inspecting flags, without a temporary array.
              var tile3 = this.tileId(mx, my, 3), tile2 = this.tileId(mx, my, 2);
              var tile1 = this.tileId(mx, my, 1), tile0 = this.tileId(mx, my, 0);
              tagId = flags[tile3] >> 12;
              if (tagId <= 0) tagId = flags[tile2] >> 12;
              if (tagId <= 0) tagId = flags[tile1] >> 12;
              if (tagId <= 0) tagId = flags[tile0] >> 12;
              if (tagId <= 0) tagId = 0;
            } else {
              var tiles = this.layeredTiles(mx, my);
              for (var tileIndex = 0; tileIndex < tiles.length; tileIndex++) {
                var tag = flags[tiles[tileIndex]] >> 12;
                if (tag > 0) { tagId = tag; break; }
              }
            }
          }
        } else tagId = this.terrainTag(mx, my);
        return this.tileset().slippery.contains(tagId);
      }
      if (Yanfly.Param.SlipRegion === 0 &&
          Array.prototype.contains === stockContains &&
          Array.prototype.indexOf === nativeIndexOf) {
        var tileset = this.tileset();
        var slipTiles = tileset && tileset.slippery;
        if (Array.isArray(slipTiles) && slipTiles.length === 0 &&
            slipTiles.contains === stockContains &&
            slipTiles.indexOf === nativeIndexOf) return false;
        if (Array.isArray(slipTiles) && slipTiles.length === 0) {
          PMJS.optimizations.reportFallback('plugins.yanfly.slippery-tiles',
            'tileset array membership methods changed after installation');
        }
      } else {
        PMJS.optimizations.reportFallback('plugins.yanfly.slippery-tiles',
          'slippery region or array membership methods changed after installation');
      }
      return originalIsSlippery.call(this, mx, my);
    };

    mapProto.isSlippery._pmjsSlipperyTilesGuard = true;
    mapProto.__pmjsSlipperyTilesGuard = true;
    return true;
  }

  PMJS.plugins.installOptimization('YEP_SlipperyTiles', {
    id: 'plugins.yanfly.slippery-tiles',
    owner: 'pmjs-plugins/yanfly',
    fallback: 'stock YEP_SlipperyTiles isSlippery check on every call',
    phaseKey: 'pmjs.adapter.yanfly-slippery-tiles',
    install: install
  });
})();
