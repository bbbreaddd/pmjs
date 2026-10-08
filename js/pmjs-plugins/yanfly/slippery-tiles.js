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

  var KNOWN_SLIPPERY_QUERY = 'd06e176669197657614662215af1deb67bdae5c7a595914f7d82cf39e4e3f8b2';

  function fingerprint(fn) {
    if (!globalThis.__pmjsBuiltinRequire) return null;
    return globalThis.__pmjsBuiltinRequire('crypto').createHash('sha256')
      .update(fnBody(fn)).digest('hex');
  }

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

    if (fingerprint(mapProto.isSlippery) !== KNOWN_SLIPPERY_QUERY) {
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
