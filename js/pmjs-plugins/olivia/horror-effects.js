'use strict';

// Shared Olivia HorrorEffects guard: Olivia_HorrorEffects
// Skips inactive HorrorEffects updates when filters are absent.
// Recognize delegated update methods before skipping inactive effects.
(function() {
  if (typeof PMJS !== 'undefined' && PMJS.plugins &&
      typeof PMJS.plugins.registerOptimization === 'function') {
    PMJS.plugins.registerOptimization('Olivia_HorrorEffects', {
      id: 'plugins.olivia.horror-effects',
      owner: 'plugins/olivia/horror-effects',
      fallback: 'run original Olivia HorrorEffects methods unconditionally on every sprite'
    });
  }

  // Match the complete reviewed function, including parameters and literals.
  // Formatting changes safely retain guest behavior until reviewed.
  function matchesReviewedFunction(fn, expected) {
    if (typeof fn !== 'function' || !globalThis.__pmjsBuiltinRequire) return false;
    var source = Function.prototype.toString.call(fn)
      .replace(/^function(?:\s+[\w$]+)?\s*\(/, 'function(');
    return globalThis.__pmjsBuiltinRequire('crypto').createHash('sha256')
      .update(source).digest('hex') === expected;
  }

  function isKnownOliviaUpdateHorrorEffects(fn) {
    return !fn?._pmjsOliviaGuard && matchesReviewedFunction(fn,
      '5a2e127a3a66d10dbac9ea5a08ce2f600c8c51737d8e60141b8e3fab61f4b66f');
  }

  function isKnownOliviaNoise(fn) {
    return !fn?._pmjsOliviaGuard && matchesReviewedFunction(fn,
      '5886848c86d64f40d6342cd985179c8d0f328e8d4231011f044ebcd3b8c2d686');
  }

  function isKnownOliviaGlitch(fn) {
    return !fn?._pmjsOliviaGuard && matchesReviewedFunction(fn,
      '1dfffbc540671e82481f9d99431290422c72a8c1b036a25c68e52708457b406c');
  }

  function isKnownOliviaTV(fn) {
    return !fn?._pmjsOliviaGuard && matchesReviewedFunction(fn,
      'f5469ca6d318fe389e00824aa5daf6f698f3e4a300b21a79372910c5434f2254');
  }

  function hasActiveHorrorFilter(sprite) {
    var filters = sprite._horrorFilters;
    return !!(filters && (filters.noiseFilter || filters.glitchFilter ||
      filters.tvFilter));
  }

  function installOliviaHorrorEffects() {
    if (typeof Sprite !== 'function' || !globalThis.Olivia ||
        !globalThis.Olivia.HorrorEffects) return false;
    var proto = Sprite.prototype;
    if (!proto || proto._pmjsOliviaInstalled) return true;
    if (typeof proto.updateHorrorEffects !== 'function') {
      PMJS.optimizations.refuse('plugins.olivia.horror-effects',
        'Olivia updateHorrorEffects method unavailable');
      return false;
    }

    if (!PMJS.optimizations.isEnabled('plugins.olivia.horror-effects')) {
      return false;
    }

    var integrated = false;

    var updateEffects = proto.updateHorrorEffects;
    var knownNoise = proto.updateHorrorNoise;
    var knownGlitch = proto.updateHorrorGlitch;
    var knownTV = proto.updateHorrorTV;
    var knownDispatcher = isKnownOliviaUpdateHorrorEffects(updateEffects);
    var knownDelegates = isKnownOliviaNoise(knownNoise) &&
      isKnownOliviaGlitch(knownGlitch) && isKnownOliviaTV(knownTV);
    if (knownDispatcher && knownDelegates) {
      proto.updateHorrorEffects = (function(original) {
        var guarded = function() {
          var delegatesUnchanged = this.updateHorrorNoise === knownNoise &&
            this.updateHorrorGlitch === knownGlitch &&
            this.updateHorrorTV === knownTV;
          if (delegatesUnchanged && !hasActiveHorrorFilter(this)) {
            return;
          }
          return original.apply(this, arguments);
        };
        guarded._pmjsOliviaGuard = true;
        return guarded;
      })(updateEffects);
      integrated = true;

    } else if (!knownDispatcher && !updateEffects._pmjsOliviaGuard) {
      // Composed wrapper: guard only recognized leaves.
      var leaves = [
        { method: 'updateHorrorNoise', filter: 'noiseFilter',
          recognize: isKnownOliviaNoise },
        { method: 'updateHorrorGlitch', filter: 'glitchFilter',
          recognize: isKnownOliviaGlitch },
        { method: 'updateHorrorTV', filter: 'tvFilter',
          recognize: isKnownOliviaTV }
      ];
      for (var i = 0; i < leaves.length; i++) {
        var leaf = leaves[i];
        var original = proto[leaf.method];
        if (typeof original === 'function' && !original._pmjsOliviaGuard &&
            leaf.recognize(original)) {
          proto[leaf.method] = (function(originalMethod, filterName) {
            var guarded = function() {
              var filters = this._horrorFilters;
              if (!filters || !filters[filterName]) {
                return;
              }
              return originalMethod.apply(this, arguments);
            };
            guarded._pmjsOliviaGuard = true;
            return guarded;
          })(original, leaf.filter);
          integrated = true;
        }
      }
    }

    if (!integrated) {
      PMJS.optimizations.refuse('plugins.olivia.horror-effects',
        'unrecognized Olivia method composition');
      return false;
    }
    proto._pmjsOliviaInstalled = true;
    proto._pmjsOliviaFastPaths = true;
    return true;
  }

  PMJS.plugins.onLoaded('Olivia_HorrorEffects', 'pmjs.adapter.olivia-horror',
    function() {
      PMJS.phases.on('afterGuestPlugins', 'pmjs.adapter.olivia-horror',
        installOliviaHorrorEffects);
    });

})();
