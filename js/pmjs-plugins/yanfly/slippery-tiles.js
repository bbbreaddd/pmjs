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

    if (fnBody(mapProto.isSlippery) !== KNOWN_SLIPPERY_QUERY) {
      PMJS.optimizations.refuse('plugins.yanfly.slippery-tiles',
        'unrecognized Yanfly isSlippery method composition');
      return false;
    }

    var originalIsSlippery = mapProto.isSlippery;
    var stockContains = Array.prototype.contains;
    var nativeIndexOf = Array.prototype.indexOf;
    var knownContains = typeof stockContains === 'function' &&
      fnBody(stockContains) === 'return this.indexOf(element) >= 0;' &&
      /\[native code\]/.test(Function.prototype.toString.call(nativeIndexOf));
    if (!knownContains || typeof Yanfly === 'undefined' || !Yanfly.Param ||
        Yanfly.Param.SlipRegion !== 0) {
      PMJS.optimizations.refuse('plugins.yanfly.slippery-tiles',
        'slippery region or array membership composition requires guest query');
      return false;
    }

    mapProto.isSlippery = function(mx, my) {
      if (Yanfly.Param.SlipRegion === 0 &&
          Array.prototype.contains === stockContains &&
          Array.prototype.indexOf === nativeIndexOf) {
        var tileset = this.tileset();
        var slipTiles = tileset && tileset.slippery;
        if (Array.isArray(slipTiles) && slipTiles.length === 0 &&
            slipTiles.contains === stockContains &&
            slipTiles.indexOf === nativeIndexOf) return false;
      }
      return originalIsSlippery.call(this, mx, my);
    };

    mapProto.isSlippery._pmjsSlipperyTilesGuard = true;
    mapProto.__pmjsSlipperyTilesGuard = true;
    return true;
  }

  PMJS.plugins.onLoaded('YEP_SlipperyTiles',
    'pmjs.adapter.yanfly-slippery-tiles', function() {
      PMJS.phases.on('afterGuestPlugins',
        'pmjs.adapter.yanfly-slippery-tiles', install);
    });
})();
