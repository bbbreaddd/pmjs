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
  function matchesReviewedFunction(fn, expected) {
    if (typeof fn !== 'function' || !globalThis.__pmjsBuiltinRequire) return false;
    var source = Function.prototype.toString.call(fn)
      .replace(/^function(?:\s+[\w$]+)?\s*\(/, 'function(');
    return globalThis.__pmjsBuiltinRequire('crypto').createHash('sha256')
      .update(source).digest('hex') === expected;
  }

  function isKnownTerraxCreateLightmask(fn) {
    return matchesReviewedFunction(fn,
      'd4c1c118e263003d317475cbd0f3d0f2ed52b57c1e4251fa38bfe204c8e580b5');
  }

  function isKnownTerraxAddSprite(fn) {
    return matchesReviewedFunction(fn,
      '4d84eff24f4ff08377d5770c777f19b4a28b28cc0fbcc26ba3e772e1ca5135b5');
  }

  function isKnownTerraxRemoveSprite(fn) {
    return matchesReviewedFunction(fn,
      '0b9bbbb8af744215d532ed784b9d567f3943446e955c28c43f306f910e887cc4');
  }

  function isKnownTerraxUpdateMask(fn) {
    return matchesReviewedFunction(fn,
      'c9ba1198824f74c3e3917b1c604e30d39f66ffdac937f28f54ec6b567f6d34b5');
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
        PMJS.mv.bitmap.createPrimitiveRecorder(bitmap);
      if (!recorder) return;
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
      if (!lightmask || !lightmask._sprites ||
          !isKnownTerraxUpdateMask(lightmask._updateMask) ||
          !isKnownTerraxAddSprite(lightmask._addSprite) ||
          !isKnownTerraxRemoveSprite(lightmask._removeSprite)) return result;
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
