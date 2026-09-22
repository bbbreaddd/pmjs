'use strict';

(function() {
  var methods = Object.create(null);
  var order = [];
  var installed = false;

  function fail(message) {
    throw new Error('PMJS methods: ' + message);
  }

  function targetOf(record) {
    try { return record.getTarget() || null; } catch (_) { return null; }
  }

  function liveMethod(record) {
    var target = targetOf(record);
    if (!target) return undefined;
    try { return target[record.method]; } catch (_) { return undefined; }
  }

  function register(definition, mode) {
    var def = definition || {};
    if (typeof def.key !== 'string' || !def.key ||
        typeof def.id !== 'string' || !def.id ||
        typeof def.method !== 'string' || !def.method ||
        typeof def.getTarget !== 'function' ||
        typeof def[mode === 'wrap' ? 'wrap' : 'replace'] !== 'function') {
      fail('invalid ' + mode + ' registration');
    }
    if (methods[def.key]) fail('method already registered: ' + def.key);
    if (installed) fail('method registered after install: ' + def.key);
    methods[def.key] = {
      key: def.key, id: def.id, method: def.method,
      getTarget: def.getTarget, mode: mode,
      build: mode === 'wrap' ? def.wrap : def.replace,
      state: 'pending', reason: 'registered', mutations: []
    };
    order.push(def.key);
    return def.id;
  }

  function installRecord(record) {
    var target = targetOf(record);
    var original = liveMethod(record);
    if (!target || typeof original !== 'function') {
      record.state = 'skipped';
      record.reason = target ? 'method is not a function' : 'target unavailable';
      return record.state;
    }
    try {
      var replacement = record.build(original);
      if (typeof replacement !== 'function') {
        fail(record.id + ' did not return a function');
      }
      target[record.method] = replacement;
      record.state = 'installed';
      record.reason = 'installed';
    } catch (error) {
      record.state = 'failed';
      record.reason = String((error && error.message) || error);
    }
    return record.state;
  }

  globalThis.PMJS = globalThis.PMJS || {};
  PMJS.methods = {
    wrap: function(definition) { return register(definition, 'wrap'); },
    own: function(definition) { return register(definition, 'own'); },

    install: function() {
      if (installed) return [];
      installed = true;
      return order.map(function(key) {
        return { key: key, state: installRecord(methods[key]) };
      });
    },

    beginPlugin: function(pluginName) {
      var token = { name: String(pluginName), snapshots: Object.create(null) };
      order.forEach(function(key) { token.snapshots[key] = liveMethod(methods[key]); });
      return token;
    },

    endPlugin: function(token, options) {
      if (!token || typeof token.name !== 'string' || !token.snapshots) {
        fail('endPlugin requires a token from beginPlugin');
      }
      order.forEach(function(key) {
        var before = token.snapshots[key];
        var after = liveMethod(methods[key]);
        if (before === after || (before === undefined && after === undefined)) return;
        methods[key].mutations.push({
          plugin: token.name, failed: !!(options && options.error)
        });
      });
      return token.name;
    },

    dump: function() {
      return order.map(function(key) {
        var record = methods[key];
        return {
          key: key, id: record.id, mode: record.mode,
          state: record.state, reason: record.reason,
          mutations: record.mutations.map(function(mutation) {
            return { plugin: mutation.plugin, failed: mutation.failed };
          })
        };
      });
    }
  };
})();
