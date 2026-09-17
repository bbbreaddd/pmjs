'use strict';

// Shared Olivia HorrorEffects guard: Olivia_HorrorEffects
// Skips inactive HorrorEffects updates and synchronize calls when filters are absent.
// Guard only exact Olivia implementations; leave composed or foreign wrappers untouched.
(function() {
  if (typeof PMJS !== 'undefined' && PMJS.optimizations &&
      typeof PMJS.optimizations.register === 'function') {
    PMJS.optimizations.register({
      id: 'plugins.olivia.horror-effects',
      owner: 'plugins/olivia/horror-effects',
      fallback: 'run original Olivia HorrorEffects methods unconditionally on every sprite'
    });
  }

  // Optional aggregate counters for scene audits. Dormant unless
  // PMJS_SCENE_CENSUS=1.
  function pmjsHorrorCensus() {
    try {
      if (typeof pmjsHorrorCensus.enabled !== 'boolean') {
        var enabled = false;
        try {
          enabled = typeof NativeHost !== 'undefined' && NativeHost &&
            NativeHost.runtime &&
            typeof NativeHost.runtime.env === 'function' &&
            NativeHost.runtime.env('PMJS_SCENE_CENSUS') === '1';
        } catch (_) { enabled = false; }
        pmjsHorrorCensus.enabled = enabled;
      }
      if (!pmjsHorrorCensus.enabled) return null;
    } catch (_) {
      return null;
    }
    try {
      if (!globalThis.__pmjsHorrorCensus) {
        globalThis.__pmjsHorrorCensus = { syncChecked: 0, syncSkipped: 0,
          effectsChecked: 0, effectsSkipped: 0, noise: 0, glitch: 0, tv: 0 };
      }
      return globalThis.__pmjsHorrorCensus;
    } catch (_) {
      return null;
    }
  }

  function fnSource(fn) {
    return Function.prototype.toString.call(fn);
  }

  function fnBody(fn) {
    var str = fnSource(fn);
    var start = str.indexOf('{');
    var end = str.lastIndexOf('}');
    var body = start < 0 || end < 0 ? str : str.slice(start + 1, end);
    return body
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1 ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Exactly three delegated calls; anything more is a composed wrapper.
  function isKnownOliviaUpdateHorrorEffects(fn) {
    if (typeof fn !== 'function' || fn._pmjsOliviaGuard) return false;
    var statements = fnBody(fn).split(';').map(function(part) {
      return part.trim();
    }).filter(function(part) {
      return part.length !== 0;
    });
    return statements.length === 3 &&
      statements[0] === 'this.updateHorrorNoise()' &&
      statements[1] === 'this.updateHorrorGlitch()' &&
      statements[2] === 'this.updateHorrorTV()';
  }

  function isKnownOliviaSynchronize(fn) {
    if (typeof fn !== 'function' || fn._pmjsOliviaGuard) return false;
    var str = fnSource(fn);
    return str.indexOf('_horrorFiltersSource') !== -1 &&
      str.indexOf('noiseFilter') !== -1 &&
      str.indexOf('glitchFilter') !== -1 &&
      str.indexOf('tvFilter') !== -1;
  }

  function isKnownOliviaNoise(fn) {
    if (typeof fn !== 'function' || fn._pmjsOliviaGuard) return false;
    var str = fnSource(fn);
    return str.indexOf('_horrorFilters') !== -1 &&
      str.indexOf('noiseFilter') !== -1 &&
      str.indexOf('animated') !== -1 &&
      str.indexOf('Math.random') !== -1;
  }

  function isKnownOliviaGlitch(fn) {
    if (typeof fn !== 'function' || fn._pmjsOliviaGuard) return false;
    var str = fnSource(fn);
    return str.indexOf('glitchFilter') !== -1 &&
      str.indexOf('_horrorFiltersGlitchSpecial') !== -1 &&
      str.indexOf('updateHorrorGlitchEffect') !== -1 &&
      str.indexOf('refreshRequest') !== -1;
  }

  function isKnownOliviaTV(fn) {
    if (typeof fn !== 'function' || fn._pmjsOliviaGuard) return false;
    var str = fnSource(fn);
    return str.indexOf('_horrorFilters') !== -1 &&
      str.indexOf('tvFilter') !== -1 &&
      str.indexOf('animated') !== -1 &&
      str.indexOf('aniSpeed') !== -1;
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
    if (typeof proto.updateHorrorEffects !== 'function') return false;

    if (typeof pmjsOptimizationEnabled === 'function' &&
        !pmjsOptimizationEnabled('plugins.olivia.horror-effects')) {
      return false;
    }

    var integrated = false;

    var synchronize = proto.synchronizeHorrorFiltersWithSource;
    if (typeof synchronize === 'function' && !synchronize._pmjsOliviaGuard &&
        isKnownOliviaSynchronize(synchronize)) {
      proto.synchronizeHorrorFiltersWithSource = (function(original) {
        var guarded = function() {
          var census = pmjsHorrorCensus();
          if (census) census.syncChecked++;
          if (!this._horrorFiltersSource && !hasActiveHorrorFilter(this)) {
            if (census) census.syncSkipped++;
            return;
          }
          return original.apply(this, arguments);
        };
        guarded._pmjsOliviaGuard = true;
        return guarded;
      })(synchronize);
      integrated = true;
    }

    var updateEffects = proto.updateHorrorEffects;
    if (isKnownOliviaUpdateHorrorEffects(updateEffects)) {
      proto.updateHorrorEffects = (function(original) {
        var guarded = function() {
          var census = pmjsHorrorCensus();
          if (census) census.effectsChecked++;
          if (!hasActiveHorrorFilter(this)) {
            if (census) census.effectsSkipped++;
            return;
          }
          return original.apply(this, arguments);
        };
        guarded._pmjsOliviaGuard = true;
        return guarded;
      })(updateEffects);
      integrated = true;

      if (pmjsHorrorCensus()) {
        var countedLeaves = [
          { method: 'updateHorrorNoise', counter: 'noise' },
          { method: 'updateHorrorGlitch', counter: 'glitch' },
          { method: 'updateHorrorTV', counter: 'tv' }
        ];
        for (var c = 0; c < countedLeaves.length; c++) {
          (function(leaf) {
            var original = proto[leaf.method];
            if (typeof original !== 'function' ||
                original._pmjsCensusCounted) return;
            var counting = function() {
              var census = pmjsHorrorCensus();
              if (census) census[leaf.counter]++;
              return original.apply(this, arguments);
            };
            counting._pmjsCensusCounted = true;
            proto[leaf.method] = counting;
          })(countedLeaves[c]);
        }
      }
    } else if (!updateEffects._pmjsOliviaGuard) {
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
              var census = pmjsHorrorCensus();
              var filters = this._horrorFilters;
              if (!filters || !filters[filterName]) {
                if (census) {
                  census.effectsChecked++;
                  census.effectsSkipped++;
                }
                return;
              }
              if (census) {
                census.effectsChecked++;
                if (filterName === 'noiseFilter') census.noise++;
                else if (filterName === 'glitchFilter') census.glitch++;
                else if (filterName === 'tvFilter') census.tv++;
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

    if (!integrated) return false;
    proto._pmjsOliviaInstalled = true;
    proto._pmjsOliviaFastPaths = true;
    return true;
  }

  installOliviaHorrorEffects();

  if (typeof globalThis.pmjsRegisterHook === 'function') {
    globalThis.pmjsRegisterHook('pluginLoaded', function(name) {
      if (name !== 'Olivia_HorrorEffects') return;
      installOliviaHorrorEffects();
    });
  }

  globalThis.pmjsInstallOliviaHorrorEffects = installOliviaHorrorEffects;
  globalThis.pmjsInstallOliviaHorrorFastPaths = installOliviaHorrorEffects;
})();
