'use strict';

(function() {
  var paintingId = 'tilemap.yed-indexed-paint-loops';
  var animationId = 'tilemap.yed-indexed-animation';
  PMJS.plugins.registerOptimization('YED_Tiled', {
    id: paintingId, owner: 'plugins/yed/tiled',
    fallback: 'guest tile preparation and priority-sprite painting'
  });
  PMJS.plugins.registerOptimization('YED_Tiled', {
    id: animationId, owner: 'plugins/yed/tiled',
    fallback: 'guest animation updates with full tile repaint'
  });

  var reviewedMethods = {
    _paintAllTiles: 'e9b49d6deb06b751a5c2d605b252a951bbf3155c5db0ab4a1a2d2fc090ea2aec',
    _updateLayerPositions: '192c62e166187aeb511ac40046b4299999b4f53fe4dd1a77a5676f734d8eeeeb',
    _paintObjectLayers: '695762171e06d553823ce50a2c1b54067ae9e124c893b24ba116c42cd4a9dc8e',
    _paintTilesLayer: '2ffe4cd820664ad0911e7f25db7272416613dfde1d4e2b772373637f0f6773ec',
    _paintTile: '3179495717cb0e9ee850549aad37258435125b8b91f980e7a965ecb35fd0f40e',
    _paintPriorityTile: '9d8ed2d54c4397ed8fc7ac5ffb202022c37bb11af28b9611c2e42fd8cf22d1c3',
    _updateAnim: '61c2fed25261010df7f9b37abb4f691863ef23f2e3d84aad3f50d4599d9d840b',
    updateTransform: 'b7a7a370946ce0ae21b0627c85c55abd0efd8db9eef430a0afcb92f37637f236',
    _compareChildOrder: '4a81bea0be0ed6cb764109f1846f04e4bae324b85999d5258bdf920e3f4eb012',
    _paintTiles: '7b10b95d1b40b756830d4a685e29706839bdc548fd2b1fddd53ada242edc33bc',
    _getTextureId: 'd61c490aaedc4da890a6f13299bfa605a707146a1eb4fad8a9a303ef17f7d3b3',
    _getAnimTileId: '6b2481626a353fe2df179a7260405ee1a32b2ca7af8acc6a5a5254d19d47e637',
    _getPriority: 'aeac6b3ac39790e16616036a059d0114218504718d8bee3dc0dea93b4b4b05d9',
    _isPriorityTile: 'a83e33b7e55289e825b00d3a60e3f83d622f8843199ce0efbb1ee5e29f45beeb',
    _getZIndex: 'd04b04844182e1fcc628e8d0b21899fdcde0cc0d7649a720207f862894791b99',
    _updateAnimFrames: '1784d51ae97e984417d78e6ba34073a9d31e53259873765f040d3693cf9ab8cf',
    hideOnLevel: '0140d27e86bc6e413e5450c27b2446445b7c26a180de67339b7d54f6926e14aa',
    _sortChildren: 'f70b7bc23a18ba594dba1664022d1aac77f4285cde92b18e3c4040d995a82210'
  };
  var contracts = new WeakMap();

  function matches(fn, digest) {
    if (typeof fn !== 'function' || !globalThis.__pmjsBuiltinRequire) return false;
    var source = Function.prototype.toString.call(fn)
      .replace(/^function(?:\s+[\w$]+)?\s*\(/, 'function(');
    return globalThis.__pmjsBuiltinRequire('crypto').createHash('sha256')
      .update(source).digest('hex') === digest;
  }

  function dataContract(data) {
    if (!data || !Array.isArray(data.layers) || !Array.isArray(data.tilesets)) return 'unreviewed-tiled-data';
    if (data.infinite || data.orientation && data.orientation !== 'orthogonal' ||
        data.layers.some(function(layer) { return !layer || layer.layers || layer.chunks ||
          layer.data !== undefined && !Array.isArray(layer.data) ||
          layer.objects !== undefined && !Array.isArray(layer.objects); })) {
      return 'unreviewed-tiled-layer-geometry';
    }
    if (data.tilesets.some(function(set) { return !set || set.margin || set.spacing ||
        Array.isArray(set.tiles) && set.tiles.some(function(tile, index) { return tile && tile.id !== index; }); })) {
      return 'unreviewed-tiled-tileset-geometry';
    }
    if (data.layers.some(function(layer) {
      return (layer.data || []).some(function(gid) { return (Number(gid) >>> 0) > 0x0fffffff; }) ||
        (layer.objects || []).some(function(object) { return object && (Number(object.gid) >>> 0) > 0x0fffffff; });
    })) return 'unreviewed-tiled-flips';
    return true;
  }

  function activate(constructor) {
    if (typeof constructor !== 'function') {
      PMJS.optimizations.refuse(paintingId, 'tilemap constructor unavailable');
      PMJS.optimizations.refuse(animationId, 'tilemap constructor unavailable');
      return;
    }
    if (contracts.has(constructor)) {
      if (PMJS.maps) PMJS.maps.tiledContract = contracts.get(constructor);
      return;
    }
    var prototype = constructor.prototype;
    var names = Object.keys(reviewedMethods);
    var qualified = !Object.prototype.hasOwnProperty.call(prototype, 'updateTransform') &&
      names.every(function(name) {
        return name === '_compareChildOrder' && prototype[name] === undefined ||
          matches(prototype[name], reviewedMethods[name]);
      });
    if (!qualified) {
      PMJS.optimizations.refuse(paintingId, 'unrecognized tile preparation composition');
      PMJS.optimizations.refuse(animationId, 'unrecognized tile preparation composition');
      if (PMJS.maps) PMJS.maps.tiledContract = function() { return 'unreviewed-tiled-methods'; };
      return;
    }
    var original = {};
    names.forEach(function(name) { original[name] = prototype[name]; });
    var effective = Object.assign({}, original);
    var disabled = new WeakSet();
    var retained = PMJS.yedRetainedTiles;
    var painting = PMJS.optimizations.isEnabled(paintingId);
    var animation = painting && PMJS.optimizations.isEnabled(animationId);
    if (!painting && PMJS.optimizations.isEnabled(animationId)) {
      PMJS.optimizations.refuse(animationId, 'requires ' + paintingId);
    }

    function methodsUnchanged(instance) {
      return names.every(function(name) { return instance[name] === effective[name]; });
    }
    function deactivate(instance) {
      if (disabled.has(instance)) return;
      disabled.add(instance);
      instance._pmjsIndexedAnimation = false;
      instance._pmjsIndexedPaintLoops = false;
      instance._needsRepaint = true;
      instance._needsAnimRepaint = false;
      instance._pmjsChangedAnimKeys = null;
      retained.invalidate(instance);
    }
    function eligible(instance) {
      if (disabled.has(instance)) return false;
      if (methodsUnchanged(instance) && retained.supported(instance)) return true;
      deactivate(instance);
      return false;
    }
    function coordinates(instance) {
      var camera = instance.origin;
      return [Math.floor(((instance.roundPixels ? Math.floor(camera.x) : camera.x) - (instance._margin || 0)) / instance._tileWidth),
        Math.floor(((instance.roundPixels ? Math.floor(camera.y) : camera.y) - (instance._margin || 0)) / instance._tileHeight)];
    }
    function prepare(instance) {
      if (!eligible(instance)) return false;
      var window = coordinates(instance);
      if (!retained.prepare(instance, window[0], window[1])) {
        deactivate(instance);
        return false;
      }
      instance._sortChildren();
      return true;
    }
    function wrap(name, operation) {
      var guest = original[name];
      var wrapped = function() {
        if (!eligible(this)) return guest.apply(this, arguments);
        if (operation.apply(this, arguments) === false) {
          deactivate(this);
          return guest.apply(this, arguments);
        }
      };
      wrapped._pmjsYedGuard = true;
      prototype[name] = effective[name] = wrapped;
    }
    if (painting) {
      wrap('_paintAllTiles', function(x, y) { return retained.paint(this, x, y); });
      wrap('_updateLayerPositions', function(x, y) { return retained.updatePositions(this, x, y); });
      if (animation) wrap('_updateAnim', function() { return retained.updateAnimation(this); });
      wrap('updateTransform', function() {
        if (!prepare(this)) return false;
        PIXI.Container.prototype.updateTransform.call(this);
        return true;
      });
      prototype._paintAnimTiles = function(pending) {
        if (!eligible(this)) return;
        if (pending) this._pmjsChangedAnimKeys = Object.assign(this._pmjsChangedAnimKeys || Object.create(null), pending);
        prepare(this);
      };
      prototype._pmjsPrepareTiles = function() { return prepare(this); };
      prototype._pmjsIndexedPaintLoops = true;
      prototype._pmjsIndexedAnimation = animation;
    }
    var contract = function(data) {
      if (!names.every(function(name) { return prototype[name] === effective[name]; })) return 'tiled-producer-changed';
      return data ? dataContract(data) : true;
    };
    contracts.set(constructor, contract);
    if (PMJS.maps) PMJS.maps.tiledContract = contract;
  }

  PMJS.methods.wrap({
    key: 'Spriteset_Map.loadTileset', id: 'pmjs.yed-map-contract',
    getTarget: function() { return typeof Spriteset_Map === 'function' ? Spriteset_Map.prototype : null; },
    method: 'loadTileset',
    wrap: function(guest) { return function() {
      if (this._tilemap && typeof $gameMap !== 'undefined' &&
          typeof $gameMap.isTiledMap === 'function' && $gameMap.isTiledMap()) {
        activate(this._tilemap.constructor);
      }
      return guest.apply(this, arguments);
    }; }
  });
  PMJS.plugins.onLoaded('YED_Tiled', 'pmjs.adapter.yed-tiled', function() {
    PMJS.phases.on('afterGuestPlugins', 'pmjs.adapter.yed-tiled', function() {
      if (typeof globalThis.TiledTilemap === 'function') activate(globalThis.TiledTilemap);
    });
  });
})();
