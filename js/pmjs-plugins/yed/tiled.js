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
    _paintAllTiles: '1bba1daa9d6fc8acc867abb2a294246a47aadcbcb5fa218ac22fbd5e1beaa89f',
    _updateLayerPositions: '1a2e2865cc172588e7e32bfbdaee4935dd0049d51c659435981849e370cd43ca',
    _paintObjectLayers: 'cf071947f708471afc2df032e5f90cb7b8e5c7bda22aab6b8030d1138bf025c4',
    _paintTilesLayer: '5deda3d868a70344e8fa64fb4f334b93fa565846d50e6a58306978e6a77b403c',
    _paintTile: '75b4aab273a49dc43676a165418acfff0d94769985666629b8e6bc55d7c7e2ba',
    _paintPriorityTile: '62ddc0287ad5710cb51507fa58ac284c6c172a459aba35325215584ad1588e81',
    _updateAnim: 'b7d03e8e83c836f3c7464014c4784cc4e90982fe660545f6701ceda190471b89',
    updateTransform: '0b7ff0daca0957e3b83d04114304eb6263ab76da0275136f9361ad02b06bbde6',
    _compareChildOrder: 'db07efd07e95b65b3aa502a0d9ae5f75da827d46e64e5449a6347b01ef22aac8',
    _paintTiles: '53df696c0ef8be7331a1a992298d58620b6f302bc38e7d317b087ece941e813a',
    _getTextureId: '040618de07ca6b6897c7765d0990d13f27be85cdc478e534cc3f224c2afb343f',
    _getAnimTileId: '77cb7812f66610870bc0f6b774091f760ea9bed6b4cad7bf2988778d491306c7',
    _getPriority: '8f23b6281737b5f857dde3c2d613244d4c43f3cbb7cf5cbb90febd001d391f57',
    _isPriorityTile: '5e12217040f5abf6272ec5421d73c234cce1f0860371f0cdf89197df0372aa6e',
    _getZIndex: '2fdeac7553ac8ea51ccdf937cde52e16d28ddf1fcea1f2aa6c149c999e06986d',
    _updateAnimFrames: 'bf0d3158238176ad550b6a9360ccccde094c035d5c83ab4def866786fa369379',
    hideOnLevel: 'b34a77a24826714c608486703bf6c0b7e143da74946002bd3a3e672b02752a1a',
    _sortChildren: '31e0ce88f7b3499320e66a5cc868df35b3a02ea9bb5d03927393927a260050d9'
  };
  var contracts = new WeakMap();

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

  function rejectActivation(reason, beforeBoot, detail) {
    [paintingId, animationId].forEach(function(id) {
      if (beforeBoot) PMJS.optimizations.refuse(id, reason, detail);
      else PMJS.optimizations.reportFallback(id, reason, detail);
    });
    if (PMJS.maps) PMJS.maps.tiledContract = function() { return reason; };
  }

  function activate(constructor, beforeBoot) {
    if (typeof constructor !== 'function') {
      rejectActivation('tilemap constructor unavailable', beforeBoot);
      return;
    }
    if (contracts.has(constructor)) {
      if (PMJS.maps) PMJS.maps.tiledContract = contracts.get(constructor);
      return;
    }
    var prototype = constructor.prototype;
    var names = Object.keys(reviewedMethods);
    var mismatch = Object.prototype.hasOwnProperty.call(prototype, 'updateTransform') ? 'updateTransform' : null;
    var qualified = !mismatch &&
      names.every(function(name) {
        var recognized = name === '_compareChildOrder' && prototype[name] === undefined ||
          PMJS.methods.matchesSource(prototype[name], reviewedMethods[name]);
        if (!recognized) mismatch = name;
        return recognized;
      });
    if (!qualified) {
      rejectActivation('unrecognized tile preparation composition', beforeBoot, 'TiledTilemap.' + mismatch);
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
      if (beforeBoot) PMJS.optimizations.refuse(animationId, 'requires ' + paintingId);
      else PMJS.optimizations.reportFallback(animationId, 'requires ' + paintingId);
    }

    function methodsUnchanged(instance) {
      return names.every(function(name) { return instance[name] === effective[name]; });
    }
    function deactivate(instance, reason) {
      if (disabled.has(instance)) return;
      PMJS.optimizations.reportFallback(paintingId, reason);
      if (animation) PMJS.optimizations.reportFallback(animationId, reason);
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
      if (!methodsUnchanged(instance)) {
        deactivate(instance, 'tilemap methods changed after installation');
        return false;
      }
      if (!retained.supported(instance)) {
        deactivate(instance, 'tilemap data or instance contract unsupported');
        return false;
      }
      return true;
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
        deactivate(instance, 'retained tile preparation rejected');
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
          deactivate(this, 'retained tile operation rejected: ' + name);
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
      if (typeof pmjsPixiRenderPreflight !== 'undefined') {
        var containerUpdateTransform = PIXI.Container.prototype.updateTransform;
        pmjsPixiRenderPreflight.registerTransformPreparation(effective.updateTransform,
          prepare, function(instance) { return PIXI.Container.prototype.updateTransform === containerUpdateTransform &&
            eligible(instance) && names.every(function(name) {
            return prototype[name] === effective[name];
          }); });
      }
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
      if (typeof globalThis.TiledTilemap === 'function') activate(globalThis.TiledTilemap, true);
    });
  });
})();
