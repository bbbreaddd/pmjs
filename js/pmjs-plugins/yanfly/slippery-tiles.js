'use strict';

if (typeof PMJS !== 'undefined' && PMJS.optimizations &&
    typeof PMJS.optimizations.register === 'function') {
  PMJS.optimizations.register({
    id: 'plugins.yanfly.slippery-tiles',
    owner: 'pmjs-plugins/yanfly',
    fallback: 'stock YEP_SlipperyTiles isSlippery check on every call'
  });
}

(function() {
  function fnBody(fn) {
    var str = Function.prototype.toString.call(fn);
    var start = str.indexOf('{');
    var end = str.lastIndexOf('}');
    var body = start < 0 || end < 0 ? str : str.slice(start + 1, end);
    return body
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1 ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  var KNOWN_SLIPPERY_QUERY =
    'if ($gameParty.inBattle()) return false; ' +
    'if (this.isValid(mx, my) && this.tileset()) { ' +
    'if (Yanfly.Param.SlipRegion !== 0 && ' +
    'this.regionId(mx, my) === Yanfly.Param.SlipRegion) return true; ' +
    'var tagId = this.terrainTag(mx, my); ' +
    'var slipTiles = this.tileset().slippery; ' +
    'return slipTiles.contains(tagId); ' +
    '} return false;';

  function mapLevelCanBeSlippery(map, level) {
    var tileset = typeof map.tileset === 'function' ? map.tileset() : null;
    if (!tileset || !Array.isArray(tileset.slippery)) {
      return true; // Not ready or unknown shape, fail-safe to reference behavior
    }

    var slipTiles = tileset.slippery;
    if (slipTiles.length > 0) {
      return true; // Tileset declares slippery terrain tags
    }

    var slipRegion = (typeof Yanfly !== 'undefined' && Yanfly.Param && Yanfly.Param.SlipRegion) || 0;
    if (slipRegion === 0) {
      return false; // Neither tileset tags nor region configured
    }

    // Tiled maps (YED_Tiled)
    if (typeof map.isTiledMap === 'function' && map.isTiledMap()) {
      if (!Array.isArray(map._regions)) {
        return true; // Not initialized yet, fail-safe
      }
      var targetLevel = level !== undefined ? level : (map.currentMapLevel || 0);
      var regionMap = map._regions[targetLevel];
      if (!Array.isArray(regionMap) || regionMap.length === 0) {
        return true; // Level region layer not ready, fail-safe
      }
      for (var i = 0; i < regionMap.length; i++) {
        if (regionMap[i] === slipRegion) {
          return true; // Slippery region exists on this level
        }
      }
      return false; // Zero slippery regions on this level
    }

    // Stock RPG Maker MV maps
    var dataMap = typeof globalThis !== 'undefined' ? globalThis.$dataMap : null;
    if (dataMap && Array.isArray(dataMap.data) && typeof map.width === 'function' && typeof map.height === 'function') {
      var width = map.width();
      var height = map.height();
      var layerSize = width * height;
      if (layerSize > 0 && dataMap.data.length >= layerSize * 6) {
        var regionOffset = layerSize * 5;
        for (var j = 0; j < layerSize; j++) {
          if (dataMap.data[regionOffset + j] === slipRegion) {
            return true;
          }
        }
        return false;
      }
    }

    return true; // Unknown map structure fallback
  }

  function install() {
    if (typeof pmjsOptimizationEnabled === 'function' &&
        !pmjsOptimizationEnabled('plugins.yanfly.slippery-tiles')) {
      return false;
    }

    var mapProto = typeof Game_Map !== 'undefined' &&
      Game_Map.prototype ? Game_Map.prototype : null;
    if (!mapProto || mapProto.__pmjsSlipperyTilesGuard ||
        typeof mapProto.isSlippery !== 'function' ||
        typeof mapProto.setup !== 'function') return false;

    if (fnBody(mapProto.isSlippery) !== KNOWN_SLIPPERY_QUERY) return false;

    var originalIsSlippery = mapProto.isSlippery;
    var originalSetup = mapProto.setup;

    mapProto.isSlippery = function(mx, my) {
      var level = this.currentMapLevel || 0;
      var cache = this._pmjsSlipperyCache;
      if (!cache) {
        cache = this._pmjsSlipperyCache = {};
      }
      var canSlip = cache[level];
      if (canSlip === undefined) {
        canSlip = cache[level] = mapLevelCanBeSlippery(this, level);
      }
      if (canSlip === false) {
        return false;
      }
      return originalIsSlippery.call(this, mx, my);
    };

    mapProto.setup = function() {
      this._pmjsSlipperyCache = null;
      return originalSetup.apply(this, arguments);
    };

    if (typeof mapProto.changeTileset === 'function') {
      var originalChangeTileset = mapProto.changeTileset;
      mapProto.changeTileset = function(tilesetId) {
        this._pmjsSlipperyCache = null;
        return originalChangeTileset.apply(this, arguments);
      };
    }

    mapProto.isSlippery._pmjsSlipperyTilesGuard = true;
    mapProto.__pmjsSlipperyTilesGuard = true;
    return true;
  }

  PMJS.plugins.onLoaded('YEP_SlipperyTiles',
    'pmjs.adapter.yanfly-slippery-tiles', function() {
      install();
      PMJS.phases.on('beforeBoot', 'pmjs.adapter.yanfly-slippery-tiles', install);
    });
})();
