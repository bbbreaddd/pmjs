'use strict';

(function() {
  var originalManifest = null;
  var effectiveManifest = null;
  var guests = Object.create(null);
  var order = [];
  var loadSequence = 0;
  var callbacks = Object.create(null);
  var loadingCallbacks = Object.create(null);
  var interceptors = Object.create(null);
  var finished = false;
  var bootError = null;
  var activeAttempt = null;
  var optimizationRequirements = [];

  function key(name) {
    var value = String(name).replace(/\.js$/i, '');
    // MZ registers script names and parameters by filename even when the
    // manifest stores a subdirectory. MV retains the complete plugin name.
    if (globalThis.PMJS_RUNTIME_ENGINE === 'mz') value = value.split('/').pop();
    return value.toLowerCase();
  }

  function copyManifest(records) {
    return (Array.isArray(records) ? records : []).filter(function(record) {
      return record && typeof record.name === 'string' && record.name;
    }).map(function(record) {
      return { name: record.name, status: !!record.status };
    });
  }

  function guest(name) {
    var canonical = key(name);
    if (!guests[canonical]) {
      guests[canonical] = {
        id: 'game:' + canonical, key: canonical,
        name: String(name).replace(/\.js$/i, ''), enabled: true,
        state: 'discovered', reason: 'loaded without manifest entry',
        loadOrder: null, error: null, failureStage: null
      };
      order.push(canonical);
    }
    return guests[canonical];
  }

  // Preserve the origin of a delegated exception, including primitive throws.
  function atStage(stage, callback) {
    var attempt = activeAttempt;
    try {
      var result = callback();
      if (attempt) attempt.failure = null;
      return result;
    } catch (error) {
      if (attempt && (!attempt.failure || !Object.is(attempt.failure.error, error))) {
        attempt.failure = { stage: stage, error: error };
      }
      throw error;
    }
  }

  function invokeCallback(plugin, owner, callback, phase, receiver) {
    try { return atStage(phase + '-callback', function() {
      return Reflect.apply(callback, receiver, []);
    }); } catch (error) {
      if (phase === 'loaded' && guest(plugin).state !== 'failed') {
        failed(plugin, error, 'loaded-callback', 'failed in loaded callback (owner ' + owner + ')');
      }
      console.error('[pmjs] error running ' + phase + ' callback for ' + plugin +
        ' (owner ' + owner + '):', error);
      throw error;
    }
  }

  function loaded(name) {
    var entry = guest(name);
    entry.state = 'loaded';
    entry.reason = 'loaded via PluginManager.setup';
    entry.loadOrder = loadSequence++;
    var listeners = callbacks[entry.key] || [];
    delete callbacks[entry.key];
    listeners.forEach(function(listener) {
      invokeCallback(entry.key, listener.owner, listener.callback, 'loaded', listener);
    });
  }

  function failed(name, error, stage, reason) {
    var entry = guest(name);
    entry.state = 'failed';
    entry.reason = reason || 'failed during setup';
    entry.failureStage = stage;
    try { entry.error = String((error && error.message) || error); }
    catch (_) { entry.error = 'unprintable plugin error'; }
  }

  function isLoaded(name) {
    var entry = guests[key(name)];
    return !!entry && entry.state === 'loaded';
  }

  function reportRuntime() {
    var snapshot = PMJS.plugins.dump();
    var counts = snapshot.counts;
    console.log('[pmjs] guest plugins: ' + counts.total +
      ' manifest, ' + counts.loaded + ' loaded' +
      (counts.disabled ? ', ' + counts.disabled + ' disabled' : '') +
      (counts.unloaded ? ', ' + counts.unloaded + ' UNLOADED' : '') +
      (counts.failed ? ', ' + counts.failed + ' FAILED' : ''));
    snapshot.guest.forEach(function(entry) {
      if (entry.state === 'loaded' || entry.state === 'discovered') return;
      console.log('[pmjs]   ' + entry.name + ' ' + entry.state +
        (entry.reason ? ' (' + entry.reason + ')' : ''));
    });
    if (snapshot.original.join('|') !== snapshot.effective.join('|')) {
      console.log('[pmjs]   original manifest differs from effective plan');
      console.log('[pmjs]     original: ' + snapshot.original.join(', '));
      console.log('[pmjs]     effective: ' + snapshot.effective.join(', '));
    }
    PMJS.methods.dump().forEach(function(method) {
      if (method.state === 'failed') {
        console.error('[pmjs] failed method installer ' + method.key + ': ' + method.reason);
      }
      if (method.mode !== 'own' || method.mutations.length === 0) return;
      console.log('[pmjs] owned method ' + method.key +
        ' superseded guest changes from ' + method.mutations.map(function(mutation) {
          return mutation.plugin;
        }).join(', '));
    });
  }

  function boot(installManagerHooks, afterPlugins) {
    if (bootError) throw bootError;
    try {
      installManagerHooks();
      PMJS.phases.emit('beforePlugins');
      PMJS.plugins.snapshotEffectiveManifest(
        (typeof $plugins !== 'undefined') ? $plugins : undefined);
      if (typeof $plugins !== 'undefined' && Array.isArray($plugins)) {
        PluginManager.setup($plugins);
      }
      PMJS.plugins.finish();
      PMJS.phases.emit('afterGuestPlugins');
      PMJS.phases.emit('afterPlugins');
      if (typeof afterPlugins === 'function') afterPlugins();
      PMJS.methods.install();
      reportRuntime();
      if (typeof nativeBootPhase === 'function') nativeBootPhase('plugins-loaded');
    } catch (error) {
      bootError = error;
      throw error;
    }
  }

  function loadManifest() {
    NativeHost.runtime.loadScript('js/plugins.js');
    PMJS.plugins.snapshotOriginalManifest(
      (typeof $plugins !== 'undefined') ? $plugins : undefined);
  }

  globalThis.PMJS = globalThis.PMJS || {};
  PMJS.plugins = PMJS.plugins || {};
  Object.assign(PMJS.plugins, {
    registerOptimization: function(name, definition) {
      if (finished) throw new Error('PMJS plugins: optimization registration after resolution');
      PMJS.optimizations.register(definition);
      optimizationRequirements.push({ plugin: key(name), id: definition.id });
    },

    snapshotOriginalManifest: function(records) {
      if (originalManifest) throw new Error('PMJS plugins: original manifest already captured');
      originalManifest = copyManifest(records);
      return originalManifest.length;
    },

    snapshotEffectiveManifest: function(records) {
      if (effectiveManifest) throw new Error('PMJS plugins: effective manifest already captured');
      effectiveManifest = copyManifest(records);
      effectiveManifest.forEach(function(record) {
        var entry = guest(record.name);
        entry.enabled = record.status;
        entry.reason = record.status ? 'in game manifest' : 'disabled in game manifest';
        entry.state = record.status ? 'discovered' : 'disabled';
      });
      return effectiveManifest.length;
    },

    onLoaded: function(name, owner, callback) {
      if (typeof owner === 'function') {
        callback = owner;
        owner = 'anonymous';
      }
      if (typeof callback !== 'function') return;
      var canonical = key(name);
      if (isLoaded(name)) {
        invokeCallback(canonical, owner, callback, 'loaded', undefined);
        return;
      }
      (callbacks[canonical] || (callbacks[canonical] = [])).push({
        owner: owner, callback: callback
      });
    },

    onLoading: function(name, owner, callback) {
      var canonical = key(name);
      if (finished || (guests[canonical] && guests[canonical].state !== 'discovered')) {
        throw new Error('PMJS plugins: loading callback registered after execution: ' + name);
      }
      if (typeof callback !== 'function') return;
      (loadingCallbacks[canonical] || (loadingCallbacks[canonical] = [])).push({
        owner: owner, callback: callback
      });
    },

    // Synchronous interception propagates results and exceptions; next() is single-use.
    // Unknown scripts
    // must delegate unchanged; replacement or suppression requires reviewed source.
    // A handled load may replace setup without evaluating the original script.
    interceptLoad: function(name, owner, callback) {
      if (typeof callback !== 'function') throw new TypeError('Plugin load interceptor must be a function');
      var canonical = key(name);
      var listener = { owner: owner, callback: callback };
      var list = interceptors[canonical] || (interceptors[canonical] = []);
      list.push(listener);
      return function() {
        var index = list.indexOf(listener);
        if (index >= 0) list.splice(index, 1);
      };
    },

    loadScript: function(name, path, load) {
      var listeners = (interceptors[key(name)] || []).slice();
      var context = { name: name, path: path };
      function next(index) {
        if (index === listeners.length) return atStage('guest-script', load);
        var listener = listeners[index], continued = false, active = true;
        try {
          return atStage('load-interceptor', function() {
            return listener.callback(function() {
              if (!active) throw new Error('Plugin load interceptor ' + listener.owner +
                ' called next() after returning for ' + name);
              if (continued) throw new Error('Plugin load interceptor ' + listener.owner +
                ' called next() twice for ' + name);
              continued = true;
              return next(index + 1);
            }, context);
          });
        } finally { active = false; }
      }
      return next(0);
    },

    execute: function(name, load) {
      var previousAttempt = activeAttempt;
      var attempt = activeAttempt = { failure: null };
      try {
        var token = null;
        var error = null;
        var loadFailed = false;
        var primaryFailure = null;
        var cleanups = [];
        try {
          token = atStage('method-audit', function() { return PMJS.methods.beginPlugin(name); });
          var listeners = loadingCallbacks[key(name)] || [];
          delete loadingCallbacks[key(name)];
          listeners.forEach(function(listener) {
            var cleanup = invokeCallback(key(name), listener.owner, listener.callback, 'loading', listener);
            if (typeof cleanup === 'function') cleanups.push(cleanup);
          });
          atStage('guest-script', load);
        } catch (caught) {
          error = caught;
          loadFailed = true;
          primaryFailure = attempt.failure || { stage: 'guest-script', error: caught };
          failed(name, caught, primaryFailure.stage);
          throw caught;
        } finally {
          var cleanupError, cleanupFailed = false, propagateCleanup = false;
          cleanups.reverse().forEach(function(cleanup) {
            try { cleanup(); } catch (caught) {
              if (!cleanupFailed) { cleanupError = caught; cleanupFailed = true; }
            }
          });
          if (!loadFailed && cleanupFailed) {
            propagateCleanup = true;
            error = cleanupError;
            loadFailed = true;
            primaryFailure = { stage: 'cleanup', error: error };
            failed(name, error, primaryFailure.stage);
          }
          if (token) {
            try { PMJS.methods.endPlugin(token, { error: error, failed: loadFailed }); }
            catch (auditError) {
              if (!loadFailed) {
                attempt.failure = { stage: 'method-audit', error: auditError };
                failed(name, auditError, 'method-audit'); throw auditError;
              }
              // A secondary diagnostic cannot replace the original load failure.
              try { console.error('[pmjs] method audit failed for ' + name + ':', auditError); }
              catch (_) { /* The original load failure is already propagating. */ }
            }
          }
          if (primaryFailure) attempt.failure = primaryFailure;
          if (propagateCleanup) throw cleanupError;
        }
        loaded(name);
        return true;
      } finally {
        activeAttempt = previousAttempt;
        if (previousAttempt && attempt.failure) previousAttempt.failure = attempt.failure;
      }
    },

    finish: function() {
      if (!effectiveManifest) throw new Error('PMJS plugins: effective manifest not captured');
      if (finished) return false;
      finished = true;
      order.forEach(function(canonical) {
        var entry = guests[canonical];
        if (entry.enabled && entry.state === 'discovered') {
          entry.state = 'unloaded';
          entry.reason = 'enabled in manifest but no load event observed';
        }
      });
      optimizationRequirements.forEach(function(requirement) {
        var entry = guests[requirement.plugin];
        if (!entry || entry.state !== 'loaded') {
          PMJS.optimizations.refuse(requirement.id,
            'required guest plugin ' + requirement.plugin + ' unavailable: ' +
            (entry ? entry.state : 'not discovered'));
        }
      });
      return true;
    },

    dump: function() {
      var list = order.map(function(canonical) {
        var entry = guests[canonical];
        return {
          id: entry.id, key: entry.key, name: entry.name,
          manifestEnabled: entry.enabled, state: entry.state,
          reason: entry.reason, loadOrder: entry.loadOrder, error: entry.error,
          failureStage: entry.failureStage
        };
      });
      var counts = { total: list.length, loaded: 0, disabled: 0,
        unloaded: 0, failed: 0, discovered: 0 };
      list.forEach(function(entry) { counts[entry.state]++; });
      var original = originalManifest || effectiveManifest || [];
      return {
        manifestSeen: !!effectiveManifest,
        originalManifestSeen: !!originalManifest,
        guest: list, counts: counts,
        original: original.map(function(record) { return record.name; }),
        effective: (effectiveManifest || []).map(function(record) {
          return record.name;
        })
      };
    }
  });

  globalThis.pmjsInitializeRpgMakerPlugins = boot;
  globalThis.pmjsLoadRpgMakerPluginManifest = loadManifest;
})();
