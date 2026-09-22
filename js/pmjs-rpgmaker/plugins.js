'use strict';

(function() {
  var originalManifest = null;
  var effectiveManifest = null;
  var guests = Object.create(null);
  var order = [];
  var loadSequence = 0;
  var callbacks = Object.create(null);
  var finished = false;

  function key(name) {
    return String(name).replace(/\.js$/i, '').toLowerCase();
  }

  function copyManifest(records) {
    return (Array.isArray(records) ? records : []).filter(function(record) {
      return record && typeof record.name === 'string' && record.name;
    }).map(function(record) {
      return { name: record.name, status: record.status !== false };
    });
  }

  function guest(name) {
    var canonical = key(name);
    if (!guests[canonical]) {
      guests[canonical] = {
        id: 'game:' + canonical, key: canonical,
        name: String(name).replace(/\.js$/i, ''), enabled: true,
        state: 'discovered', reason: 'loaded without manifest entry',
        loadOrder: null, error: null
      };
      order.push(canonical);
    }
    return guests[canonical];
  }

  function loaded(name) {
    var entry = guest(name);
    entry.state = 'loaded';
    entry.reason = 'loaded via PluginManager.setup';
    entry.loadOrder = loadSequence++;
    var listeners = callbacks[entry.key] || [];
    delete callbacks[entry.key];
    listeners.forEach(function(listener) {
      try { listener.callback(); } catch (error) {
        console.error('[pmjs] error running loaded callback for ' + entry.key +
          ' (owner ' + listener.owner + '):', error);
      }
    });
  }

  function failed(name, error) {
    var entry = guest(name);
    entry.state = 'failed';
    entry.reason = 'failed during setup';
    entry.error = String((error && error.message) || error);
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
      if (method.mode !== 'own' || method.mutations.length === 0) return;
      console.log('[pmjs] owned method ' + method.key +
        ' superseded guest changes from ' + method.mutations.map(function(mutation) {
          return mutation.plugin;
        }).join(', '));
    });
  }

  function boot(installManagerHooks, afterPlugins) {
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
  }

  function loadManifest() {
    NativeHost.runtime.loadScript('js/plugins.js');
    PMJS.plugins.snapshotOriginalManifest(
      (typeof $plugins !== 'undefined') ? $plugins : undefined);
  }

  globalThis.PMJS = globalThis.PMJS || {};
  PMJS.plugins = {
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
        try { callback(); } catch (error) {
          console.error('[pmjs] error running loaded callback for ' + canonical +
            ' (owner ' + owner + '):', error);
        }
        return;
      }
      (callbacks[canonical] || (callbacks[canonical] = [])).push({
        owner: owner, callback: callback
      });
    },

    execute: function(name, load) {
      var token = PMJS.methods.beginPlugin(name);
      var error = null;
      try {
        load();
      } catch (caught) {
        error = caught;
        failed(name, caught);
        throw caught;
      } finally {
        PMJS.methods.endPlugin(token, { error: error });
      }
      loaded(name);
      return true;
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
      return true;
    },

    dump: function() {
      var list = order.map(function(canonical) {
        var entry = guests[canonical];
        return {
          id: entry.id, key: entry.key, name: entry.name,
          manifestEnabled: entry.enabled, state: entry.state,
          reason: entry.reason, loadOrder: entry.loadOrder, error: entry.error
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
  };

  globalThis.pmjsInitializeRpgMakerPlugins = boot;
  globalThis.pmjsLoadRpgMakerPluginManifest = loadManifest;
})();
