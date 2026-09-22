'use strict';

// Shared Terrax Lighting native accelerator.
// Gates the GPU recorder plus mask-sprite pooling; disabled means stock
// Terrax Canvas _updateMask and light-sprite handling.
(function() {
  if (typeof PMJS !== 'undefined' && PMJS.optimizations &&
      typeof PMJS.optimizations.register === 'function') {
    PMJS.optimizations.register({
      id: 'terrax.native-lighting',
      owner: 'plugins/terrax/lighting',
      fallback: 'ordinary Terrax Canvas _updateMask and stock light-sprite handling'
    });
  }

  function lightColor(value, alpha) {
    var rgba = colorWithGlobalAlpha(value, alpha);
    return [((rgba >>> 24) & 255) / 255, ((rgba >>> 16) & 255) / 255,
      ((rgba >>> 8) & 255) / 255, (rgba & 255) / 255];
  }

  function appendLightRecord(records, kind, bounds, center, radii, stops, alpha,
      blendMode) {
    records.push(kind, bounds[0], bounds[1], bounds[2], bounds[3],
      center[0], center[1], radii[0], radii[1], stops.length);
    for (var offsetIndex = 0; offsetIndex < 3; offsetIndex++) {
      records.push(offsetIndex < stops.length ? stops[offsetIndex].offset : 0);
    }
    for (var colorIndex = 0; colorIndex < 3; colorIndex++) {
      var color = colorIndex < stops.length ?
        lightColor(stops[colorIndex].color, alpha) : [0, 0, 0, 0];
      records.push(color[0], color[1], color[2], color[3]);
    }
    records.push(blendMode);
  }

  function fnSource(fn) {
    return Function.prototype.toString.call(fn);
  }

  function hasTokens(fn, tokens) {
    if (typeof fn !== 'function') return false;
    var source = fnSource(fn);
    for (var index = 0; index < tokens.length; index++) {
      if (source.indexOf(tokens[index]) === -1) return false;
    }
    return true;
  }

  function looksLikeKnownCreateLightmask(fn) {
    return hasTokens(fn, ['_lightmask', 'new Lightmask', 'addChild']);
  }

  function looksLikeKnownAddSprite(fn) {
    return hasTokens(fn, ['new Sprite', '_sprites.push', 'addChild',
      'bitmap', 'blendMode']);
  }

  function looksLikeKnownRemoveSprite(fn) {
    return hasTokens(fn, ['_sprites.pop', 'removeChild']);
  }

  function looksLikeKnownUpdateMask(fn) {
    return hasTokens(fn, ['_maskBitmap', 'fillRect']);
  }

  function installTerraxLightingFastPaths() {
    if (typeof Spriteset_Map === 'undefined' ||
        typeof Spriteset_Map.prototype.createLightmask !== 'function' ||
        Spriteset_Map.prototype.createLightmask._pmjsTerraxGuard) return false;

    var useNativeLighting = PMJS.optimizations.isEnabled('terrax.native-lighting');
    if (!useNativeLighting ||
        !looksLikeKnownCreateLightmask(
          Spriteset_Map.prototype.createLightmask)) return false;
    var useGpuLighting = useNativeLighting && typeof NativeHost !== 'undefined' &&
      NativeHost.render &&
      typeof NativeHost.render.createPrimitiveSurface === 'function' &&
      typeof NativeHost.render.renderPrimitiveSurface === 'function' &&
      typeof NativeHost.render.releasePrimitiveSurface === 'function' &&
      typeof colorWithGlobalAlpha === 'function';
    var primitiveSurfaceFinalizer = typeof FinalizationRegistry === 'function'
      ? new FinalizationRegistry(function(handle) {
          try { NativeHost.render.releasePrimitiveSurface(handle); } catch (_) {}
        }) : null;

    function installGpuLightRecorder(lightmask) {
      var bitmap = lightmask._maskBitmap;
      var context = bitmap && bitmap._context;
      var canvas = bitmap && bitmap._canvas;
      if (!context || !canvas || typeof context.fillRect !== 'function' ||
          !looksLikeKnownUpdateMask(lightmask._updateMask)) return;
      var surface = NativeHost.render.createPrimitiveSurface(bitmap.width, bitmap.height);
      if (primitiveSurfaceFinalizer) {
        primitiveSurfaceFinalizer.register(bitmap, surface.handle, bitmap);
      }
      var originalFillRect = context.fillRect;
      var originalFill = context.fill;
      var originalUpdateMask = lightmask._updateMask;
      var records = [];
      var replay = [];
      var clearColor = [0, 0, 0, 0];
      var recording = false;
      var fallback = false;

      function replayRecordedCanvasOperations() {
        if (fallback) return;
        fallback = true;
        delete canvas._nativeImage;
        for (var index = 0; index < replay.length; index++) {
          var operation = replay[index];
          context.save();
          context.fillStyle = operation.style;
          context.globalAlpha = operation.alpha;
          context.globalCompositeOperation = operation.composite;
          context.setTransform.apply(context, operation.transform);
          originalFillRect.apply(context, operation.arguments);
          context.restore();
        }
      }

      context.fillRect = function(x, y, width, height) {
        if (!recording || fallback) return originalFillRect.apply(this, arguments);
        var transform = this._transform;
        var identity = transform && transform[0] === 1 && transform[1] === 0 &&
          transform[2] === 0 && transform[3] === 1;
        var blendMode = this.globalCompositeOperation === 'lighter' ? 1 :
          this.globalCompositeOperation === 'source-over' ? 0 : -1;
        var style = this.fillStyle;
        var supportedGradient = style && style._pmjsStyle === 'radial-gradient' &&
          style.nativeConcentric && style.stops.length > 0 && style.stops.length <= 3;
        var supportedSolid = typeof style === 'string' || typeof style === 'number';
        if (!identity || blendMode < 0 || (!supportedGradient && !supportedSolid)) {
          replayRecordedCanvasOperations();
          return originalFillRect.apply(this, arguments);
        }
        var bounds = [x + transform[4], y + transform[5], width, height];
        replay.push({ style: style, alpha: this.globalAlpha,
          composite: this.globalCompositeOperation,
          transform: Array.prototype.slice.call(transform),
          arguments: Array.prototype.slice.call(arguments) });
        if (supportedSolid && blendMode === 0 && records.length === 0 &&
            bounds[0] <= 0 && bounds[1] <= 0 &&
            bounds[0] + bounds[2] >= bitmap.width &&
            bounds[1] + bounds[3] >= bitmap.height) {
          clearColor = lightColor(style, this.globalAlpha);
          return;
        }
        if (supportedGradient) {
          appendLightRecord(records, 1, bounds, [style.x0, style.y0],
            [style.r0, style.r1], style.stops, this.globalAlpha, blendMode);
        } else {
          appendLightRecord(records, 0, bounds, [0, 0], [0, 0],
            [{ offset: 0, color: style }], this.globalAlpha, blendMode);
        }
      };
      context.fill = function() {
        if (recording && !fallback) replayRecordedCanvasOperations();
        return originalFill.apply(this, arguments);
      };

      lightmask._updateMask = function() {
        records.length = 0;
        replay.length = 0;
        clearColor = [0, 0, 0, 0];
        fallback = false;
        recording = true;
        try {
          originalUpdateMask.apply(this, arguments);
        } finally {
          recording = false;
        }
        if (!fallback) {
          try {
            NativeHost.render.renderPrimitiveSurface(
              surface.handle, clearColor, records);
            canvas._nativeImage = surface.image;
          } catch (_) {
            replayRecordedCanvasOperations();
          }
        }
      };

      var originalDestroy = bitmap.destroy;
      bitmap.destroy = function() {
        if (surface) {
          if (primitiveSurfaceFinalizer) primitiveSurfaceFinalizer.unregister(bitmap);
          NativeHost.render.releasePrimitiveSurface(surface.handle);
          surface = null;
        }
        if (typeof originalDestroy === 'function') {
          return originalDestroy.apply(this, arguments);
        }
      };
    }

    var createLightmask = Spriteset_Map.prototype.createLightmask;
    Spriteset_Map.prototype.createLightmask = function() {
      var result = createLightmask.apply(this, arguments);
      var lightmask = this._lightmask;
      if (!lightmask || !lightmask._sprites) return result;
      if (useGpuLighting) installGpuLightRecorder(lightmask);

      if (looksLikeKnownAddSprite(lightmask._addSprite) &&
          looksLikeKnownRemoveSprite(lightmask._removeSprite)) {
        lightmask._addSprite = function(x, y, bitmap) {
          var sprite = this._pmjsMaskSprite;
          if (!sprite) {
            sprite = this._pmjsMaskSprite = new Sprite(this.viewport);
            this.addChild(sprite);
          }
          sprite.bitmap = bitmap;
          sprite.opacity = 255;
          sprite.blendMode = 2;
          sprite.x = x;
          sprite.y = y;
          sprite.rotation = 0;
          sprite.ax = 0;
          sprite.ay = 0;
          sprite.visible = true;
          if (this._sprites.indexOf(sprite) < 0) this._sprites.push(sprite);
        };
        lightmask._removeSprite = function() {
          var sprite = this._sprites.pop();
          if (sprite) sprite.visible = false;
        };
      }
      return result;
    };
    Spriteset_Map.prototype.createLightmask._pmjsTerraxGuard = true;
    return true;
  }

  PMJS.phases.on('afterGuestPlugins', 'pmjs.adapter.terrax-lighting', function() {
    installTerraxLightingFastPaths();
    PMJS.phases.on('beforeBoot', 'pmjs.adapter.terrax-lighting',
      installTerraxLightingFastPaths);
  });

  globalThis.pmjsInstallTerraxLightingFastPaths = installTerraxLightingFastPaths;
})();
