'use strict';

(function() {
  var sourceOf = Function.prototype.call.bind(Function.prototype.toString);
  var methods = Object.create(null);
  var order = [];
  var installed = false;
  var installationError = null;
  var installationFailed = false;

  function fail(message) {
    throw new Error('PMJS methods: ' + message);
  }

  function targetOf(record) {
    return record.getTarget() || null;
  }

  function methodSnapshot(record) {
    try {
      var target = targetOf(record);
      var owner = target;
      while (owner) {
        var descriptor = Object.getOwnPropertyDescriptor(owner, record.method);
        if (descriptor) return { target: target, owner: owner, descriptor: descriptor };
        owner = Object.getPrototypeOf(owner);
      }
      return { target: target, owner: null, descriptor: {} };
    } catch (_) {
      // Missing diagnostic evidence must not change guest plugin execution.
      return null;
    }
  }

  function sameSnapshot(before, after) {
    if (before.target !== after.target || before.owner !== after.owner) return false;
    return ['value', 'get', 'set', 'writable', 'enumerable', 'configurable'].every(function(key) {
      return before.descriptor[key] === after.descriptor[key];
    });
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
    try {
      var target = targetOf(record);
      var original = target ? target[record.method] : undefined;
      if (!target || typeof original !== 'function') {
        record.state = 'skipped';
        record.reason = target ? 'method is not a function' : 'target unavailable';
        return record.state;
      }
      var replacement = record.build(original);
      if (typeof replacement !== 'function') {
        fail(record.id + ' did not return a function');
      }
      target[record.method] = replacement;
      if (target[record.method] !== replacement) {
        fail(record.id + ' replacement did not become the effective method');
      }
      record.state = 'installed';
      record.reason = 'installed';
    } catch (error) {
      record.state = 'failed';
      installationError = error;
      installationFailed = true;
      try { record.reason = String((error && error.message) || error); }
      catch (_) { record.reason = 'unprintable installation error'; }
      throw error;
    }
    return record.state;
  }

  function canonicalSource(source) {
    return source.replace(/\r\n/g, '\n');
  }

  function fingerprint(source) {
    if (typeof source !== 'string' || typeof globalThis.__pmjsBuiltinRequire !== 'function') return null;
    try {
      return __pmjsBuiltinRequire('crypto').createHash('sha256')
        .update(canonicalSource(source)).digest('hex');
    } catch (_) {
      return null;
    }
  }

  function matchesReviewedSource(source, expected, allowExact) {
    if (typeof source !== 'string') return false;
    var accepted = Array.isArray(expected) ? expected : [expected];
    if (allowExact && accepted.some(function(value) {
      return typeof value === 'string' && canonicalSource(value) === canonicalSource(source);
    })) return true;
    var digest = fingerprint(source);
    return digest !== null && accepted.includes(digest);
  }

  globalThis.PMJS = globalThis.PMJS || {};
  PMJS.methods = {
    sourceOf: sourceOf,
    fingerprint: fingerprint,

    matchesSource: function(fn, expected) {
      return typeof fn === 'function' &&
        matchesReviewedSource(sourceOf(fn), expected, true);
    },

    matchesText: function(source, expected) {
      return matchesReviewedSource(source, expected, false);
    },

    optimize: function(definition) {
      var def = definition;
      var original = def.getTarget()[def.method];
      if (typeof original !== 'function') return;
      function activate() {
        if (!PMJS.optimizations.isEnabled(def.id)) return;
        var target = def.getTarget();
        if (!PMJS.methods.matchesSource(original, def.recognized) || target[def.method] !== original) {
          PMJS.optimizations.refuse(def.id, def.refusalReason);
          return;
        }
        // Optional installation preserves non-throwing rejection of a locked method.
        Reflect.set(target, def.method, def.replace(original));
      }
      PMJS.optimizations.install({
        id: def.id, owner: def.owner, fallback: def.fallback,
        phaseKey: def.phaseKey, install: activate
      });
    },

    wrap: function(definition) { return register(definition, 'wrap'); },
    own: function(definition) { return register(definition, 'own'); },

    install: function() {
      if (installationFailed) throw installationError;
      if (installed) return [];
      installed = true;
      return order.map(function(key) {
        return { key: key, state: installRecord(methods[key]) };
      });
    },

    beginPlugin: function(pluginName) {
      var token = { name: String(pluginName), snapshots: Object.create(null) };
      order.forEach(function(key) { token.snapshots[key] = methodSnapshot(methods[key]); });
      return token;
    },

    endPlugin: function(token, options) {
      if (!token || typeof token.name !== 'string' || !token.snapshots) {
        fail('endPlugin requires a token from beginPlugin');
      }
      order.forEach(function(key) {
        var before = token.snapshots[key];
        var after = methodSnapshot(methods[key]);
        if (!before || !after || sameSnapshot(before, after)) return;
        methods[key].mutations.push({
          plugin: token.name, failed: !!(options && (options.failed || options.error))
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
