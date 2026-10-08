'use strict';

(function() {
  var methods = PMJS.methods;
  var reviewedBitmapLoad = ImageManager.loadBitmapFromUrl;
  var crypto = globalThis.__pmjsBuiltinRequire('crypto');
  var mz = typeof ShaderTilemap === 'undefined';
  var producers = mz ? ['_addNormalTile', '_addAutotile', '_addTableEdge', '_isTableTile'] :
    ['_drawNormalTile', '_drawAutotile', '_drawTableEdge', '_isTableTile'];
  var reviewed = producers.map(function(name) { return [Tilemap.prototype, name, Tilemap.prototype[name]]; });
  var producerContract = crypto.createHash('sha256').update(JSON.stringify(producers.map(function(name) {
    return String(Tilemap.prototype[name]);
  }))).digest('hex');
  var reviewedProducerContract = mz ? producerContract === '68c2143a9a120a448e3cb88e95aeb981ee3d1afca128a9eef04f30d36412115b' :
    producerContract === '7b711e244ab4120a34c90994cc9752f36d72b8fc94a0d428f3bd33936a817fff';
  if (!mz) {
    var shaderProducers = ['_drawNormalTile', '_drawAutotile', '_drawTableEdge'];
    var shaderContract = crypto.createHash('sha256').update(JSON.stringify(shaderProducers.map(function(name) {
      return String(ShaderTilemap.prototype[name]);
    }))).digest('hex');
    reviewedProducerContract = reviewedProducerContract && shaderContract === '2829c68a0d2b1dff64ac1afca9b47ab01c8a0f13ef9aed1276435daf4c00b02f';
    shaderProducers.forEach(function(name) { reviewed.push([ShaderTilemap.prototype, name, ShaderTilemap.prototype[name]]); });
  }
  var stats = { selected: 0, refused: 0, reasons: Object.create(null) };
  function refuse(reason) { stats.refused++; stats.reasons[reason] = (stats.reasons[reason] || 0)+1; return ''; }
  function stale(reason) {
    if (typeof NativeHost.assets.invalidateMapCatalog === 'function') NativeHost.assets.invalidateMapCatalog();
    return refuse(reason);
  }
  function hash(value) { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
  function selected() {
    if (!NativeHost.assets.mapPreparationEnabled || typeof $gameMap === 'undefined' || !$gameMap ||
        typeof $dataMap === 'undefined' || !$dataMap) return '';
    var entry = (NativeHost.assets.preparedMapIndex || {})[$gameMap.mapId()];
    if (!entry) return '';
    var currentTiled = typeof $gameMap.isTiledMap === 'function' && $gameMap.isTiledMap();
    if (Boolean(currentTiled) !== (entry.renderer === 'tiled')) return stale('map-renderer-changed');
    if (entry.renderer === 'tiled') {
      var data = $gameMap.tiledData;
      var contract = PMJS.maps.tiledContract && PMJS.maps.tiledContract(data);
      if (contract !== true) return refuse(typeof contract === 'string' ? contract : 'unreviewed-tiled-methods');
      return hash(data) === entry.contractHash ? entry.identity : stale('tiled-content-changed');
    }
    if (!reviewedProducerContract) return refuse('unreviewed-tile-producers');
    for (var method of reviewed) if (method[0][method[1]] !== method[2]) return refuse('tile-producer-changed:'+method[1]);
    var tileset = $gameMap.tileset(), width = $gameMap.tileWidth(), height = $gameMap.tileHeight();
      var contract = { width: $dataMap.width, height: $dataMap.height, data: $dataMap.data, tilesetId: $dataMap.tilesetId, scrollType: $dataMap.scrollType,
        events: ($dataMap.events || []).map(function(event) { return event && (event.pages || []).map(function(page) {
          return page.image && page.image.tileId || 0;
        }); }), tilesetNames: tileset.tilesetNames, flags: tileset.flags, tileWidth: width, tileHeight: height };
    return hash(contract) === entry.contractHash ? entry.identity : stale('map-contract-changed');
  }
  function scope(identity, callback) {
    var previous = PMJS.images.preparedTileSet;
    PMJS.images.preparedTileSet = identity;
    try { return callback(); } finally { PMJS.images.preparedTileSet = previous; }
  }
  PMJS.maps = { selected: selected, scope: scope, stats: stats };
  methods.wrap({ key: 'ImageManager.loadTileset', id: 'pmjs.map-image-context',
    getTarget: function() { return ImageManager; }, method: 'loadTileset',
    wrap: function(original) {
      return function(filename, hue) {
        var self = this, args = arguments, identity = hue ? '' : selected();
        if (identity) stats.selected++;
        return scope(identity, function() {
          var bitmap = original.apply(self, args);
          if (bitmap && identity) bitmap._pmjsPreparedTileSet = identity;
          return bitmap;
        });
      };
    }
  });
  methods.wrap({ key: 'ImageManager.loadParserTileset', id: 'pmjs.map-tiled-image-context',
    getTarget: function() { return ImageManager; }, method: 'loadParserTileset',
    wrap: function(original) {
      return function(filename, hue) {
        var self = this, args = arguments, identity = hue ? '' : selected();
        if (identity) stats.selected++;
        return scope(identity, function() {
          var bitmap = original.apply(self, args);
          if (bitmap && identity) bitmap._pmjsPreparedTileSet = identity;
          return bitmap;
        });
      };
    }
  });
  if (!mz) methods.wrap({ key: 'ImageManager._generateCacheKey', id: 'pmjs.map-image-cache-key',
    getTarget: function() { return ImageManager; }, method: '_generateCacheKey',
    wrap: function(original) {
      return function() {
        return original.apply(this, arguments)+(PMJS.images.preparedTileSet ? '#pmjs-tile-set='+PMJS.images.preparedTileSet : '');
      };
    }
  });
  else methods.wrap({ key: 'ImageManager.loadBitmapFromUrl', id: 'pmjs.map-image-cache-key',
    getTarget: function() { return ImageManager; }, method: 'loadBitmapFromUrl',
    wrap: function(original) {
      var reviewedLoad = reviewedBitmapLoad;
      return function(url) {
        var identity = PMJS.images.preparedTileSet;
        if (!identity || original !== reviewedLoad || !url.startsWith('img/tilesets/')) {
          var self = this, args = arguments;
          return scope('', function() { return original.apply(self, args); });
        }
        var key = url+'#pmjs-tile-set='+identity;
        if (!this._cache[key]) this._cache[key] = Bitmap.load(url);
        return this._cache[key];
      };
    }
  });
  var requestMethod = mz ? '_startLoading' : '_requestImage';
  methods.wrap({ key: 'Bitmap.'+requestMethod+'.tile-context', id: 'pmjs.map-image-retry',
    getTarget: function() { return Bitmap.prototype; }, method: requestMethod,
    wrap: function(original) {
      return function() {
        var self = this, args = arguments, identity = this._pmjsPreparedTileSet || PMJS.images.preparedTileSet || '';
        return scope(identity, function() { return original.apply(self, args); });
      };
    }
  });
})();
