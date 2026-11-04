// SPDX-FileCopyrightText: 2016 Terraxz
// SPDX-FileCopyrightText: 2026 PMJS contributors
// SPDX-License-Identifier: MIT
// Portions derived from TerraxLighting; see third_party/terrax.LICENSE.
'use strict';

// Shared Terrax Lighting native accelerator.
// Gates the GPU recorder plus mask-sprite pooling; disabled means stock
// Terrax Canvas _updateMask and light-sprite handling.
(function() {
  if (typeof PMJS !== 'undefined' && PMJS.plugins &&
      typeof PMJS.plugins.registerOptimization === 'function') {
    PMJS.plugins.registerOptimization('Terrax_Lighting', {
      id: 'terrax.native-lighting',
      owner: 'plugins/terrax/lighting',
      fallback: 'ordinary Terrax Canvas _updateMask and stock light-sprite handling'
    });
  }

  // Match complete reviewed implementations. Formatting changes and guest
  // wrappers retain ordinary behavior until their composition is reviewed.
  function isKnownTerraxCreateLightmask(fn) {
    return PMJS.methods.matchesSource(fn,
      'f66bec947329e01b9797d22c307b1fe2c7ab4c2c1eb1666431517c262ad549cc');
  }

  function isKnownTerraxAddSprite(fn) {
    return PMJS.methods.matchesSource(fn,
      'e7de1587b716859d2dd17c5c0d5454801d1cc0adcf86e89676f8a600f0572d30');
  }

  function isKnownTerraxRemoveSprite(fn) {
    return PMJS.methods.matchesSource(fn,
      'f5831f7a3d4387940ddbb7bd4cc5ee237fd338158ba68fbf1317718640e0cf61');
  }

  function isKnownTerraxUpdateMask(fn) {
    return PMJS.methods.matchesSource(fn,
      '42c09b1b373f5ffbfe3b2f0897cb4ac105d0b495b466efe173089bc2019486eb');
  }

  var installedCreateLightmask;

  function installTerraxLightingFastPaths() {
    var useNativeLighting = PMJS.optimizations.isEnabled('terrax.native-lighting');
    if (!useNativeLighting) return false;
    if (typeof Spriteset_Map === 'undefined' ||
        typeof Spriteset_Map.prototype.createLightmask !== 'function') {
      PMJS.optimizations.refuse('terrax.native-lighting',
        'Terrax createLightmask method unavailable');
      return false;
    }
    if (Spriteset_Map.prototype.createLightmask === installedCreateLightmask) return true;
    if (!isKnownTerraxCreateLightmask(
        Spriteset_Map.prototype.createLightmask)) {
      PMJS.optimizations.refuse('terrax.native-lighting',
        'unrecognized Terrax createLightmask method composition');
      return false;
    }
    function installGpuLightRecorder(lightmask) {
      var bitmap = lightmask._maskBitmap;
      var recorder = PMJS.mv && PMJS.mv.bitmap &&
        PMJS.mv.bitmap.createPrimitiveRecorder(bitmap, function(reason, detail) {
          PMJS.optimizations.reportFallback('terrax.native-lighting', reason, detail);
        });
      if (!recorder) {
        PMJS.optimizations.reportFallback('terrax.native-lighting',
          'lightmask primitive recorder unavailable');
        return;
      }
      var originalUpdateMask = lightmask._updateMask;
      lightmask._updateMask = function() {
        if (this !== lightmask) return originalUpdateMask.apply(this, arguments);
        var mask = this;
        var args = arguments;
        return recorder.record(function() { return originalUpdateMask.apply(mask, args); });
      };
    }

    var createLightmask = Spriteset_Map.prototype.createLightmask;
    Spriteset_Map.prototype.createLightmask = function() {
      var result = createLightmask.apply(this, arguments);
      var lightmask = this._lightmask;
      if (!lightmask || !lightmask._sprites) {
        PMJS.optimizations.reportFallback('terrax.native-lighting',
          'lightmask instance or sprite list unavailable');
        return result;
      }
      var rejectedMethod = !isKnownTerraxUpdateMask(lightmask._updateMask) ? '_updateMask' :
        !isKnownTerraxAddSprite(lightmask._addSprite) ? '_addSprite' :
        !isKnownTerraxRemoveSprite(lightmask._removeSprite) ? '_removeSprite' : null;
      if (rejectedMethod) {
        PMJS.optimizations.reportFallback('terrax.native-lighting',
          'unrecognized lightmask instance method: ' + rejectedMethod);
        return result;
      }
      installGpuLightRecorder(lightmask);

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
      return result;
    };
    installedCreateLightmask = Spriteset_Map.prototype.createLightmask;
    return true;
  }

  PMJS.phases.on('afterGuestPlugins', 'pmjs.adapter.terrax-lighting',
    installTerraxLightingFastPaths);
})();
