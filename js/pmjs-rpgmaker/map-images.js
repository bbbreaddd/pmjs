'use strict';

(function() {
  var methods = PMJS.methods;
  var reviewedBitmapLoad = ImageManager.loadBitmapFromUrl;
  var crypto = globalThis.__pmjsBuiltinRequire('crypto');
  var mz = typeof ShaderTilemap === 'undefined';
  var contracts = [{ target: Tilemap.prototype, methods: mz ? {
    _addNormalTile: '43c23024b34b5d1dcf800f5e90b4fbdff32e3fdf6112c1a406c59e7703934dc0',
    _addAutotile: '884826d62c40cd90cf48d0355e7630ea8bd3bc06b601612677a1ae0c607fb4df',
    _addTableEdge: 'aaa305f1620271a22583c731638858bb9f220b6961d7dd82cc989e85a083db22',
    _isTableTile: 'c1e217261601d6125dd0211ece3f248a45025c30cc4be563a79fb29ca03165ca'
  } : {
    _drawNormalTile: '6f10cd8b82be621fdbac6c0547f5917eb4060f3a6ad592b0d7b3500f4b098373',
    _drawAutotile: '75d130a645f6bf591f775cc828f087ed69d16d572b7cb462c95b970b2a1b992e',
    _drawTableEdge: 'a9170acdcfa7c9193e53e3fdff39efb39eb5c710e5155f2c6fc5853023d79a76',
    _isTableTile: 'b5b5a0a8584e9a7d6c1fc252aa6fe48f15188996297fe9a8c591305b81004824'
  } }];
  if (!mz) contracts.push({ target: ShaderTilemap.prototype, methods: {
    _drawNormalTile: '5fd670384171babd4362d6e8927b66fdabb5fcdb99b5e053537d52d6bbe4eb83',
    _drawAutotile: 'f6ab2ddd304f540075f02dd13c05951c1352bac96ca378e24edc2c4a01f0b956',
    _drawTableEdge: 'f4e9daf4a8a5cce847d39e4e4fe35c0c22dde4dbf0e29bc921707862c6fc4a73'
  } });
  var reviewed = [], reviewedProducerContract = true;
  contracts.forEach(function(contract) {
    Object.keys(contract.methods).forEach(function(name) {
      var method = contract.target[name];
      reviewed.push([contract.target, name, method]);
      if (!methods.matchesSource(method, contract.methods[name])) reviewedProducerContract = false;
    });
  });
  var stats = { selected: 0, refused: 0, unscoped: 0, reasons: Object.create(null) };
  function refuse(reason) { stats.refused++; stats.reasons[reason] = (stats.reasons[reason] || 0)+1; return ''; }
  function stale(reason) {
    if (typeof NativeHost.assets.invalidateMapCatalog === 'function') NativeHost.assets.invalidateMapCatalog($gameMap.mapId());
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
  // Maps load every tileset they name, including ones no tile uses (Tiled maps commonly list
  // shared sheets). Those images are not in the prepared set, so loading them in its scope only
  // reached the native "source changed" check and discarded the catalog. Load them unscoped.
  function selectedFor(source) {
    var identity = selected();
    if (!identity) return '';
    var entry = NativeHost.assets.preparedMapIndex[$gameMap.mapId()];
    if (source && Array.isArray(entry.sources) && entry.sources.indexOf(source) < 0) {
      stats.unscoped++;
      return '';
    }
    return identity;
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
        var self = this, args = arguments;
        var identity = hue ? '' : selectedFor(filename ? 'img/tilesets/'+filename+'.png' : '');
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
        // YED_Tiled loads 'img/tilesets/' plus the last path segment; the compiler names sources alike.
        var self = this, args = arguments;
        var identity = hue ? '' : selectedFor(filename ? 'img/tilesets/'+String(filename).split('/').pop() : '');
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
