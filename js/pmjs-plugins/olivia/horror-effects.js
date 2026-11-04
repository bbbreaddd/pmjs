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

  function hasActiveHorrorFilter(sprite) {
    var filters = sprite._horrorFilters;
    return !!(filters && (filters.noiseFilter || filters.glitchFilter ||
      filters.tvFilter));
  }

  function installOliviaHorrorEffects() {
    if (typeof Sprite !== 'function' || !globalThis.Olivia ||
        !globalThis.Olivia.HorrorEffects) {
      PMJS.optimizations.refuse('plugins.olivia.horror-effects',
        'Olivia Sprite or HorrorEffects globals unavailable');
      return false;
    }
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
    var knownDispatcher = !updateEffects._pmjsOliviaGuard && PMJS.methods.matchesSource(updateEffects,
      ['5a2e127a3a66d10dbac9ea5a08ce2f600c8c51737d8e60141b8e3fab61f4b66f', '3d661c4d877d03ab6263383bef281abd7af0762b56a8358036fddb2ab961d6f8']);
    var leaves = [
      { method: 'updateHorrorNoise', filter: 'noiseFilter', hashes: ['5886848c86d64f40d6342cd985179c8d0f328e8d4231011f044ebcd3b8c2d686', '39ecec355e2ba9f146be450dc1db0e3383f1f8145e99bae4aa607fcb3427d751'] },
      { method: 'updateHorrorGlitch', filter: 'glitchFilter', hashes: ['1dfffbc540671e82481f9d99431290422c72a8c1b036a25c68e52708457b406c', 'e9cd9bde2e143ff995b921da4afdaf4f1f580f2fa6340888a36e7536f5e20ea6'] },
      { method: 'updateHorrorTV', filter: 'tvFilter', hashes: ['f5469ca6d318fe389e00824aa5daf6f698f3e4a300b21a79372910c5434f2254', '16f0ea220202863bd97b9004f9e0645091724d5c16fd1872c1fb04057b56bd50'] }
    ];
    leaves.forEach(function(leaf) {
      leaf.original = proto[leaf.method];
      leaf.recognized = !leaf.original?._pmjsOliviaGuard &&
        PMJS.methods.matchesSource(leaf.original, leaf.hashes);
    });
    var knownDelegates = leaves.every(function(leaf) { return leaf.recognized; });
    var knownNoise = leaves[0].original, knownGlitch = leaves[1].original, knownTV = leaves[2].original;
    if (knownDispatcher && knownDelegates) {
      proto.updateHorrorEffects = (function(original) {
        var guarded = function() {
          var delegatesUnchanged = this.updateHorrorNoise === knownNoise &&
            this.updateHorrorGlitch === knownGlitch &&
            this.updateHorrorTV === knownTV;
          if (delegatesUnchanged && !hasActiveHorrorFilter(this)) {
            return;
          }
          if (!delegatesUnchanged) PMJS.optimizations.reportFallback('plugins.olivia.horror-effects',
            'sprite HorrorEffects methods changed after installation');
          return original.apply(this, arguments);
        };
        guarded._pmjsOliviaGuard = true;
        return guarded;
      })(updateEffects);
      integrated = true;

    } else if (!knownDispatcher && !updateEffects._pmjsOliviaGuard) {
      // Composed wrapper: guard only recognized leaves.
      for (var i = 0; i < leaves.length; i++) {
        var leaf = leaves[i];
        var original = leaf.original;
        if (leaf.recognized) {
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
      var unrecognized = leaves.filter(function(leaf) {
        return !leaf.recognized;
      }).map(function(leaf) { return leaf.method; });
      if (!knownDispatcher) unrecognized.unshift('updateHorrorEffects');
      PMJS.optimizations.refuse('plugins.olivia.horror-effects',
        'unrecognized Olivia method composition: ' + unrecognized.join(', '));
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
