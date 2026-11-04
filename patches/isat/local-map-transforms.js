'use strict';

(function() {
  PMJS.phases.on('beforeBoot', 'pmjs.isat.local-map-transforms', function() {
    var qualification = PMJS.isatSourceQualification;
    if (!qualification || qualification.verified !== true || qualification.dormontDataVerified !== true) return;
    function digest(method) {
      return typeof method === 'function' ? PMJS.methods.fingerprint(PMJS.methods.sourceOf(method)) : null;
    }
    var reviewed = new Set([
      '1a091756d85883232da57aa53141f43968c21abfc58b6b231a46c0faa9014861',
      'f611889101e9659a0c13ef6cdfa1b6a0be5edb374a52ad864169ddf6976d9a8e',
      'cfcbeacef1f4ca9ed869519fdba23e734e6e70e75bce5b05bb75718e6fea548a',
      '2169c8e4be4708d97d9be182006b653aa0fcdb74dd7c1cf1270b1dd4f3963e48',
      '0b7ff0daca0957e3b83d04114304eb6263ab76da0275136f9361ad02b06bbde6',
      '387766129c695c855bf5a624b0dd29893b5188d97f812d310ff6a7aa41979f8a',
      '0938d1a3fcf18a6628689547f09640615c0b7a096e445b869559d2e3a6ecaa4f'
    ]);
    var approved = new Set(), graph = [];
    var classes = { Container: PIXI.Container, PixiSprite: PIXI.Sprite, Sprite: globalThis.Sprite,
      Window: globalThis.Window, Tilemap: globalThis.Tilemap, ShaderTilemap: globalThis.ShaderTilemap,
      TilingSprite: globalThis.TilingSprite, PixiTilingSprite: PIXI.extras && PIXI.extras.TilingSprite,
      RectTileLayer: PIXI.tilemap && PIXI.tilemap.RectTileLayer,
      CompositeRectTileLayer: PIXI.tilemap && PIXI.tilemap.CompositeRectTileLayer };
    var yepPredecessor = globalThis.Yanfly && Yanfly.Core && Yanfly.Core.Sprite_updateTransform;
    for (var key in classes) {
      var proto = classes[key] && classes[key].prototype;
      if (!proto) continue;
      var method = proto.updateTransform, hash = digest(method);
      var valid = reviewed.has(hash) || key === 'Sprite' && PMJS.methods.matchesSource(method,
        ['866ba21d861bf698e1a5ef3d034a58f8453b55fe618be6596beb29cd6b473429']) &&
        yepPredecessor === PIXI.Container.prototype.updateTransform;
      if (valid) approved.add(method);
      graph.push({ prototype: proto, method: method });
    }
    // Admitted preparation callbacks update local presentation state only.
    var preparationHashes = {
      "Window": {
        "_updateCursor": [
          "3cd215fcefb0811c8bded097aa4f94ea3e2f320f35f7db9ac385232186bf027b"
        ],
        "_updateArrows": [
          "f22a3f57cd8ecd7fa97860cdb1c90cd89f74dd1cbe38718aab423556574217f5",
          "84e126939b66b8a8dd33f8b9789917285c4e3164029fdc3d578036de87256923"
        ],
        "_updatePauseSign": [
          "ae29cd24d4b3d406e92e302d2901dad4ec5d00367fb0883fe5b4ff55afbc43f7",
          "c4e17a506604483ea089ea66f2397355a0a53470079d7efc0e3d2452c310d35f"
        ],
        "_updateContents": [
          "24f637291593ed4f2e7afb4cf23c5278a2be1ac224fe6bd82b07edc1c2c7a2f1"
        ],
        "isOpen": [
          "de6e8974f6ffcc880d122d5f97b5d75e1559bf42e23835b1664a897121473105"
        ]
      },
      "Tilemap": {
        "_sortChildren": [
          "31e0ce88f7b3499320e66a5cc868df35b3a02ea9bb5d03927393927a260050d9", "53cf0784889e2a5be27b7522f3ab5af7b26ef220fb42621bc213c31e746ae4b5"
        ],
        "_compareChildOrder": [
          "b9105871a0c28610d6beb9efe79a80d988671c4f0c52c038012b2aee0fb28750", "404a97a009e4a40e9ea03d452372c6585d7d818f76d5e51c1f014dc12fa27e9e"
        ],
        "_readMapData": [
          "779f7551fdc5e750ed17a8758cb4d6983d5bb9e94a348670e1ece594f8ae8312"
        ]
      },
      "ShaderTilemap": {
        "_updateLayerPositions": [
          "868447bde8b0f24f0a48ab9359bf0ffcff8d764c062954160cce23309e381ecd"
        ],
        "_paintAllTiles": [
          "ff0734b91ff16a7f8fcba6d1cd8afe9944a9be105a4ec41b40da6a4dc5f10814"
        ],
        "_paintTiles": [
          "2806e707cc60f2bd3fdcafc2b5a241dbabdcb43831ede86e61c88e2cf3155da7"
        ],
        "_drawTile": [
          "de42538692a6ca945253936aa456a6aa7c6c6f841d6ac01817240e0b1159fe72"
        ],
        "_drawNormalTile": [
          "5fd670384171babd4362d6e8927b66fdabb5fcdb99b5e053537d52d6bbe4eb83"
        ],
        "_drawAutotile": [
          "f6ab2ddd304f540075f02dd13c05951c1352bac96ca378e24edc2c4a01f0b956"
        ],
        "_drawShadow": [
          "baee0a3de12cec0ea1d285f9cf1191fc700155ca25faa0f966a2803a5da22772",
          "4e8aed98e625274c85422fc6bd8e771de1acd7039c8fe99709396966c9cb00b9"
        ],
        "_drawTableEdge": [
          "f4e9daf4a8a5cce847d39e4e4fe35c0c22dde4dbf0e29bc921707862c6fc4a73"
        ]
      }
    };
    var preparationPrototypes = { Window: Window.prototype, Tilemap: Tilemap.prototype, ShaderTilemap: ShaderTilemap.prototype };
    var preparationReady = true, preparationMethods = [];
    var preparationRefusals = [];
    for (var owner in preparationHashes) for (var name in preparationHashes[owner]) {
      var prototype = preparationPrototypes[owner], method = prototype[name];
      if (preparationHashes[owner][name].indexOf(digest(method)) < 0) {
        preparationReady = false; preparationRefusals.push(owner + '.' + name);
      }
      preparationMethods.push({ prototype: prototype, name: name, method: method });
    }
    var masterArrows = PMJS.methods.matchesSource(Window.prototype._updateArrows, "84e126939b66b8a8dd33f8b9789917285c4e3164029fdc3d578036de87256923");
    var arrowPredecessor = globalThis.master2015hp && master2015hp.isatSnp && master2015hp.isatSnp.b_67;
    if (masterArrows && !PMJS.methods.matchesSource(arrowPredecessor, "f22a3f57cd8ecd7fa97860cdb1c90cd89f74dd1cbe38718aab423556574217f5")) {
      preparationReady = false; preparationRefusals.push('master arrow predecessor');
    }
    function rendererCallbacksAllowed(renderer) {
      if (typeof renderer.listeners !== 'function') return typeof renderer.emit !== 'function';
      var callbacks = renderer.listeners('prerender');
      var manager = renderer.filterManager;
      return callbacks.every(function(callback) { return manager && callback === manager._onPrerender; }) &&
        renderer.listeners('postrender').length === 0;
    }
    if (!preparationReady) {
      console.warn('[pmjs-isat] local map transforms unavailable: ' + preparationRefusals.join(', '));
      return;
    }
    var scenes = new WeakMap(), owners = new WeakMap(), active = null, renderers = new WeakSet();
    var lastReason = 'not-admitted';
    function refuse(reason) { lastReason = reason; }
    function invalidate(node, why) {
      var record = owners.get(node);
      if (record && !record.invalid) record.invalid = why;

    }
    var weatherEpoch = 0, weatherGraph = [], weatherNotifications = false;
    var weatherHashes = {"weatherEX_initialize": "177b8c2990ae5c6cae9d02cf753d993d212c00c3e3b91c8dc9e13086573d28c7", "clearWeatherEX": "0b9ff9187eb4aec52775bfb4e1bb079e5731668350e21788e4dc10f4ee106199", "commandSetupWeather": "c2b0c8b6104f682de874ac4c28b6c1971850c481b49a2b0224da92f2ed99a07a"};
    if (globalThis.Game_System && Object.keys(weatherHashes).every(function(name) {
      return PMJS.methods.matchesSource(Game_System.prototype[name], weatherHashes[name]);
    })) {
      weatherNotifications = true;
      Object.keys(weatherHashes).forEach(function(name) {
        var original = Game_System.prototype[name];
        var wrapped = Game_System.prototype[name] = function() {
          weatherEpoch++;
          if (active) invalidate(active.stage, 'weather-producer:' + name);
          return original.apply(this, arguments);
        };
        weatherGraph.push({ name: name, method: wrapped });
      });
    }
    ['addChild', 'addChildAt', 'removeChild', 'removeChildAt', 'removeChildren', 'setChildIndex', 'swapChildren'].forEach(function(name) {
      var original = PIXI.Container.prototype[name];
      if (typeof original !== 'function') return;
      PIXI.Container.prototype[name] = function() {
        invalidate(this, 'tree:' + name);
        return original.apply(this, arguments);
      };
    });
    ['filters', 'mask'].forEach(function(name) {
      var proto = PIXI.DisplayObject.prototype, descriptor = Object.getOwnPropertyDescriptor(proto, name);
      if (!descriptor || !descriptor.configurable || !descriptor.set) return;
      Object.defineProperty(proto, name, Object.assign({}, descriptor, { set: function(value) {
        invalidate(this, 'property:' + name); return descriptor.set.call(this, value);
      } }));
    });
    if (globalThis.Sprite && typeof Sprite.prototype.createHorrorFilter === 'function') {
      var createHorrorFilter = Sprite.prototype.createHorrorFilter;
      Sprite.prototype.createHorrorFilter = function() { invalidate(this, 'horror-filter'); return createHorrorFilter.apply(this, arguments); };
    }
    function filtersAllowed(node) {
      var filters = node._filters;
      if (!filters) return true;
      for (var index = 0; index < filters.length; index++) {
        var filter = filters[index];
        if (!filter || filter.enabled === false) continue;
        if (typeof WindowLayer === 'function' && node instanceof WindowLayer && filter === WindowLayer.voidFilter && node.filterArea) continue;
        return false;
      }
      return true;
    }
    function inventory(stage) {
      var record = { stage: stage, invalid: null, effects: [], instanceTransforms: [], refusals: [], localRenders: 0 };
      function walk(node) {
        var name = node.constructor && node.constructor.name || 'node';
        var hash = digest(node.updateTransform);
        if (!approved.has(node.updateTransform)) record.refusals.push(name + ':unknown-transform:' + hash);
        var ownTransform = Object.getOwnPropertyDescriptor(node, 'updateTransform');
        if (ownTransform) {
          // Disabling Pixi's bitmap cache restores the inherited method as an own property.
          if (!('value' in ownTransform) || ownTransform.value !== Object.getPrototypeOf(node).updateTransform) {
            record.refusals.push(name + ':own-transform');
          } else record.instanceTransforms.push({ node: node, method: ownTransform.value });
        }
        if (node._mask || node.mask) record.refusals.push(name + ':mask');
        if (node._cacheAsBitmap) record.refusals.push(name + ':cache');
        if (!filtersAllowed(node)) record.refusals.push(name + ':active-filter');
        if (node.shader) record.refusals.push(name + ':shader');
        if (PIXI.Text && node instanceof PIXI.Text || PIXI.extras && PIXI.extras.BitmapText && node instanceof PIXI.extras.BitmapText ||
            PIXI.mesh && PIXI.mesh.Mesh && node instanceof PIXI.mesh.Mesh) record.refusals.push(name + ':unreviewed-preparation');
        for (var owner in preparationHashes) {
          if (!(node instanceof classes[owner])) continue;
          for (var callback in preparationHashes[owner]) {
            if (node[callback] !== preparationPrototypes[owner][callback]) record.refusals.push(name + ':own-preparation:' + callback);
          }
        }
        if (node._filters) record.effects.push({ node: node, filters: node._filters });
        owners.set(node, record);
        var children = node.children || [];
        for (var index = 0; index < children.length; index++) walk(children[index]);
      }
      walk(stage);
      if (record.refusals.length) record.invalid = 'inventory';
      record.sunlight = admitSunlight(stage._spriteset);
      record.weatherEpoch = weatherEpoch;
      record.gameSystem = globalThis.$gameSystem;
      record.mapData = globalThis.$dataMap;
      record.commonEvents = globalThis.$dataCommonEvents;
      scenes.set(stage, record);
      return record;
    }
    function sunlightData(data) {
      return data && data.mode === 21 && data.power === 15 && data.speed === 100 &&
        data.blendMode === 1 && data.fileName === 'SunLight_01B' && data.z === 1 &&
        data.scale === 100 && data.frames === 1;
    }
    function admitSunlight(set) {
      var owner = set && set._weatherEXSprites && set._weatherEXSprites[0];
      var data = globalThis.$gameSystem && $gameSystem._weatherEX_Data && $gameSystem._weatherEX_Data[0];
      var allData = globalThis.$gameSystem && $gameSystem._weatherEX_Data;
      if (allData && allData.some(function(value, index) { return index > 0 && value && value.mode >= 0; })) return null;
      if (!owner || !globalThis.SpriteWeatherEX || Object.getPrototypeOf(owner) !== SpriteWeatherEX.prototype ||
          owner._id !== 0 || !sunlightData(data) || owner.parent !== set._weatherField_2 ||
          !owner._sprites || owner._sprites.length !== 15 || owner.children.length !== 15) return null;
      for (var index = 0; index < owner._sprites.length; index++) {
        var sprite = owner._sprites[index];
        if (owner.children[index] !== sprite || Object.getPrototypeOf(sprite) !== Sprite.prototype ||
            sprite.children.length || sprite.bitmap !== owner._image || sprite.blendMode !== 1) return null;
      }
      return { owner: owner, data: data, sprites: owner._sprites, image: owner._image };
    }
    function sunlightReason(set, record) {
      var admitted = record.sunlight, list = set._weatherEXSprites || [];
      if (record.weatherEpoch !== weatherEpoch || record.gameSystem !== globalThis.$gameSystem) return 'weather-producer';
      var fields = [set._weatherField_1, set._weatherField_2, set._weatherField_3];
      if (!admitted) {
        if (list.some(function(value) { return !!value; })) return 'weather-ex';
        for (var index = 0; index < fields.length; index++) {
          if (fields[index] && fields[index].children.length) return 'weather-live';
        }
        return null;
      }
      var owner = admitted.owner, data = globalThis.$gameSystem && $gameSystem._weatherEX_Data;
      if (!data || data[0] !== admitted.data || !sunlightData(data[0]) ||
          !weatherNotifications && data.some(function(value, index) { return index > 0 && value && value.mode >= 0; }) ||
          list[0] !== owner || list.some(function(value, index) { return index > 0 && !!value; }) ||
          owner._image !== admitted.image || owner._sprites !== admitted.sprites || owner._sprites.length !== 15 ||
          owner.children.length !== 15 || owner.parent !== fields[1]) return 'sunlight-changed';
      for (var index = 0; index < fields.length; index++) {
        var children = fields[index] && fields[index].children;
        if (children && (index === 1 ? children.length !== 1 || children[0] !== owner : children.length)) return 'weather-live';
      }
      return null;
    }
    function liveReason(stage, record) {
      if (record.invalid) return record.invalid;
      for (var index = 0; index < record.instanceTransforms.length; index++) {
        var instance = record.instanceTransforms[index];
        if (instance.node.updateTransform !== instance.method || instance.node._cacheAsBitmap) return 'instance-transform';
      }
      if (PMJS.isatSourceQualification !== qualification) return 'source-qualification';
      if (record.mapData !== globalThis.$dataMap || record.commonEvents !== globalThis.$dataCommonEvents) return 'event-data';
      if (!preparationReady) return 'preparation-source';
      for (var index = 0; index < preparationMethods.length; index++) {
        var callback = preparationMethods[index];
        if (callback.prototype[callback.name] !== callback.method) return 'preparation-method';
      }
      if (masterArrows && master2015hp.isatSnp.b_67 !== arrowPredecessor) return 'arrow-predecessor';
      if (!globalThis.$gameMap || $gameMap.mapId() !== 30 || !globalThis.SceneManager || SceneManager._scene !== stage ||
          Object.getPrototypeOf(stage) !== Scene_Map.prototype) return 'scene';
      if (SceneManager._nextScene || stage._fadeDuration > 0 || stage._encounterEffectDuration > 0 ||
          globalThis.$gamePlayer && $gamePlayer.isTransferring() ||
          globalThis.EncounterEffect && EncounterEffect.isRunning && EncounterEffect.isRunning()) return 'transition';
      if ($gameMap.isEventRunning() || globalThis.$gameTemp && $gameTemp.isManipulatingHud) return 'event-or-hud';
      var screen = globalThis.$gameScreen, set = stage._spriteset;
      if (weatherNotifications) for (var index = 0; index < weatherGraph.length; index++) {
        var producer = weatherGraph[index];
        if (Game_System.prototype[producer.name] !== producer.method) return 'weather-method';
      }
      if (!screen || screen.zoomScale() !== 1 || screen._zoomDuration > 0 || !set ||
          set.scale.x !== 1 || set.scale.y !== 1) return 'zoom-or-spriteset';
      var tone = screen.tone();
      if (!tone || tone[0] || tone[1] || tone[2] || tone[3]) return 'tone';
      var weather = set._weather;
      if (weather && (weather.type !== 'none' || weather._sprites && weather._sprites.length)) return 'weather';
      var weatherReason = sunlightReason(set, record);
      if (weatherReason) return weatherReason;
      for (var index = 0; index < record.effects.length; index++) {
        var effect = record.effects[index];
        if (effect.node._filters !== effect.filters || !filtersAllowed(effect.node)) return 'effect';
      }
      for (var index = 0; index < graph.length; index++) {
        if (graph[index].prototype.updateTransform !== graph[index].method) return 'transform-graph';
      }
      if (yepPredecessor && Yanfly.Core.Sprite_updateTransform !== yepPredecessor) return 'yep-predecessor';
      return null;
    }
    function restore(context) {
      var current = PMJS.pixi4.getStageRenderOptions(context.stage);
      if (!current || current.worldState !== 'local') return false;
      var restored = Object.assign({}, current);
      if (context.hadWorldState) restored.worldState = context.worldState;
      else delete restored.worldState;
      if (Object.keys(restored).length) {
        if (!Object.prototype.hasOwnProperty.call(restored, 'worldState')) restored.worldState = 'native';
        PMJS.pixi4.setStageRenderOptions(context.stage, restored);
      } else PMJS.pixi4.setStageRenderOptions(context.stage, null);
      return true;
    }
    function suspend(context) {
      if (context.record.invalid) return;
      var current = PMJS.pixi4.getStageRenderOptions(context.stage);
      PMJS.pixi4.setStageRenderOptions(context.stage, Object.assign({}, current, { worldState: 'local' }));
    }
    function installRenderer(renderer) {
      if (!renderer || renderers.has(renderer)) return;
      renderers.add(renderer);
      var render = renderer.render;
      renderer.render = function(stage, renderTexture, clear, transform, skipUpdateTransform) {
        if (active) {
          var outer = active; active = null;
          var restored = restore(outer);
          var before = PMJS.pixi4.getStageRenderOptions(outer.stage);
          var worldState = before ? before.worldState : 'native';
          try { return render.apply(this, arguments); }
          finally {
            var current = PMJS.pixi4.getStageRenderOptions(outer.stage);
            // A nested render can install its own world mode or remove the policy.
            if (restored && (current ? current.worldState : 'native') === worldState) suspend(outer);
            active = outer;
          }
        }
        if (renderTexture || transform || skipUpdateTransform || !stage || !globalThis.Scene_Map ||
            Object.getPrototypeOf(stage) !== Scene_Map.prototype || !globalThis.$gameMap || $gameMap.mapId() !== 30) {
          return render.apply(this, arguments);
        }
        var record = scenes.get(stage);
        if (!record) {
          if ($gameMap.isEventRunning() || globalThis.$gameTemp && $gameTemp.isManipulatingHud ||
              globalThis.ImageManager && !ImageManager.isReady()) {
            refuse('admission-not-ready'); return render.apply(this, arguments);
          }
          record = inventory(stage);
        }
        var reason = rendererCallbacksAllowed(this) ? liveReason(stage, record) : 'renderer-callback';
        if (reason) { refuse(reason); return render.apply(this, arguments); }
        var options = PMJS.pixi4.getStageRenderOptions(stage);
        var context = { stage: stage, record: record,
          hadWorldState: !!options && Object.prototype.hasOwnProperty.call(options, 'worldState'),
          worldState: options && options.worldState };
        active = context; suspend(context);
        try {
          var result = render.apply(this, arguments);
          record.localRenders++; lastReason = null;
          return result;
        } finally { restore(context); active = null; }
      };
    }
    var renderGraphics = Graphics.render;
    Graphics.render = function() { installRenderer(this._renderer); return renderGraphics.apply(this, arguments); };
    PMJS.isatMapTransforms = { diagnostics: function(stage) {
      var record = scenes.get(stage);
      return { localRenders: record ? record.localRenders : 0,
        reason: record && record.invalid || lastReason };
    } };
  });
})();
