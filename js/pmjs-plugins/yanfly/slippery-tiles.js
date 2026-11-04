'use strict';

if (typeof PMJS !== 'undefined' && PMJS.plugins &&
    typeof PMJS.plugins.registerOptimization === 'function') {
  PMJS.plugins.registerOptimization('YEP_SlipperyTiles', {
    id: 'plugins.yanfly.slippery-tiles',
    owner: 'pmjs-plugins/yanfly',
    fallback: 'stock YEP_SlipperyTiles isSlippery check on every call'
  });
}

(function() {

  // MV 1.6.1 membership and YEP_SlipperyTiles 1.05 query.
  var KNOWN_CONTAINS = ['0a14e5f3f0be233bf31d33eeecb6d55d5c34aca2a60a567f65891cbf7dc7e3f5', 'c8973dbd38a3d5da461ca1d9e5292a6f120b88595b65888819c5e70f95a3ccac'];
  var KNOWN_SLIPPERY_QUERY = ['425386319071765fdcb4f7874c65eb031dbe13f651098a84b1e1ff633505ccbe'];

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

  PMJS.plugins.onLoaded('YEP_SlipperyTiles',
    'pmjs.adapter.yanfly-slippery-tiles', function() {
      PMJS.phases.on('afterGuestPlugins',
        'pmjs.adapter.yanfly-slippery-tiles', install);
    });
})();
