// Per-optimization compatibility controls.
//
// Required runtime capabilities are never gated here. Optimizations are
// default-enabled accelerators with an ordinary/reference fallback.
//
// This module owns disable policy, effective state, validation, diagnostics,
// and registry lifetime. Implementations are registered by their owning
// module: pmjs-pixi4 and pmjs-mv register shared caches, and a port adapter
// registers its own plugin accelerators. Core never catalogs game plugins.
//
// Requested disables (port config, then PMJS_DISABLE_OPT) may precede
// registration. finalize() rejects unresolved IDs and freezes registration
// before game boot. Lifecycle: module evaluation -> plugin setup hooks ->
// afterPlugins -> beforeBoot (last registration seam) -> finalize().
//
// An owner must register an optimization only when disabling it genuinely
// bypasses the accelerator and reaches its verified ordinary fallback.

function pmjsOptimizationEnv(name) {
  try {
    if (typeof NativeHost !== 'undefined' && NativeHost.runtime &&
        typeof NativeHost.runtime.env === 'function') {
      return NativeHost.runtime.env(name);
    }
  } catch (_) {}
  return undefined;
}

function pmjsOptimizationParseList(value) {
  if (value === undefined || value === null) return [];
  var text = String(value);
  var seen = Object.create(null);
  var result = [];
  text.split(',').forEach(function(raw) {
    var id = raw.trim();
    if (!id || seen[id]) return;
    seen[id] = true;
    result.push(id);
  });
  return result;
}

function pmjsOptimizationPortDisables() {
  var config = globalThis.PMJS_GAME_CONFIG || {};
  var disables = config.disableOptimizations;
  if (disables === undefined) return [];
  if (!Array.isArray(disables)) {
    throw new Error('PMJS disableOptimizations must be an array of optimization IDs');
  }
  var seen = Object.create(null);
  disables.forEach(function(id) {
    if (typeof id !== 'string' || !id) {
      throw new Error('PMJS disableOptimizations must be an array of unique nonempty strings');
    }
    if (seen[id]) {
      throw new Error('PMJS disableOptimizations must be an array of unique nonempty strings');
    }
    seen[id] = true;
  });
  return disables.slice();
}

// Requested disables, parsed at load and kept pending until owners register.
// disabledBy per id: null (enabled default) | 'port' | 'PMJS_DISABLE_OPT'.
var pmjsOptimizationPortDisabled = Object.create(null);
var pmjsOptimizationEnvDisabled = Object.create(null);
var pmjsOptimizationStates = Object.create(null);
var pmjsOptimizationFinalized = false;

pmjsOptimizationPortDisables().forEach(function(id) {
  pmjsOptimizationPortDisabled[id] = true;
});
pmjsOptimizationParseList(pmjsOptimizationEnv('PMJS_DISABLE_OPT')).forEach(function(id) {
  pmjsOptimizationEnvDisabled[id] = true;
});

function pmjsOptimizationState(id) {
  var state = pmjsOptimizationStates[id];
  if (!state) {
    throw new Error('Unknown PMJS optimization: ' + id);
  }
  return state;
}

function pmjsLogOptimizationPolicy() {
  var diagnostics = pmjsOptimizationEnv('PMJS_OPT_DIAGNOSTICS') === '1';
  var bootDiagnostics = pmjsOptimizationEnv('PMJS_BOOT_DIAGNOSTICS') === '1';
  if (!diagnostics && !bootDiagnostics) return;
  Object.keys(pmjsOptimizationStates).forEach(function(id) {
    var state = pmjsOptimizationStates[id];
    if (!diagnostics && state.enabled) return;
    try {
      console.log('[pmjs-opt] ' + id + ' ' + PMJS.optimizations.reason(id));
    } catch (_) {}
  });
}

globalThis.PMJS = globalThis.PMJS || {};
PMJS.optimizations = {
  register: function(definition) {
    var id = definition && definition.id;
    if (pmjsOptimizationFinalized) {
      throw new Error('PMJS optimizations are finalized; cannot register: ' + id);
    }
    if (!definition || typeof id !== 'string' || !id) {
      throw new Error('PMJS optimization registration requires a nonempty string id');
    }
    if (typeof definition.owner !== 'string' || !definition.owner) {
      throw new Error('PMJS optimization registration requires a nonempty string owner: ' + id);
    }
    if (typeof definition.fallback !== 'string' || !definition.fallback) {
      throw new Error('PMJS optimization registration requires a nonempty string fallback: ' + id);
    }
    if (pmjsOptimizationStates[id]) {
      throw new Error('PMJS optimization already registered: ' + id);
    }
    var disabledBy = pmjsOptimizationEnvDisabled[id] ? 'PMJS_DISABLE_OPT' :
      (pmjsOptimizationPortDisabled[id] ? 'port' : null);
    pmjsOptimizationStates[id] = { enabled: disabledBy === null,
      disabledBy: disabledBy, owner: definition.owner,
      fallback: definition.fallback };
  },
  isEnabled: function(id) {
    return pmjsOptimizationState(id).enabled;
  },
  reason: function(id) {
    var state = pmjsOptimizationState(id);
    if (state.enabled) return 'enabled';
    if (state.disabledBy === 'refusal') {
      return 'refused: ' + state.refusalReason;
    }
    return 'disabled by ' + state.disabledBy;
  },
  refuse: function(id, reason) {
    if (pmjsOptimizationFinalized) {
      throw new Error('PMJS optimizations are finalized; cannot refuse: ' + id);
    }
    var state = pmjsOptimizationState(id);
    if (typeof reason !== 'string' || !reason) {
      throw new Error('PMJS optimization refusal requires a nonempty string reason: ' + id);
    }
    if (!state.enabled) return state.disabledBy;
    state.enabled = false;
    state.disabledBy = 'refusal';
    state.refusalReason = reason;
    return state.disabledBy;
  },
  ids: function() {
    return Object.keys(pmjsOptimizationStates);
  },
  dump: function() {
    return Object.keys(pmjsOptimizationStates).map(function(id) {
      var state = pmjsOptimizationStates[id];
      return { id: id, owner: state.owner, fallback: state.fallback,
        enabled: state.enabled, disabledBy: state.disabledBy,
        refusalReason: state.refusalReason || null };
    });
  },
  finalize: function() {
    if (pmjsOptimizationFinalized) return;
    var seen = Object.create(null);
    var unknown = [];
    Object.keys(pmjsOptimizationPortDisabled)
      .concat(Object.keys(pmjsOptimizationEnvDisabled)).forEach(function(id) {
        if (seen[id] || pmjsOptimizationStates[id]) return;
        seen[id] = true;
        unknown.push(id);
      });
    if (unknown.length) {
      throw new Error('Unknown PMJS optimization: ' + unknown.join(', '));
    }
    pmjsOptimizationFinalized = true;
    pmjsLogOptimizationPolicy();
  }
};

// Narrow gating helper for optimization boundaries. Effective state is
// computed once at registration and frozen at finalization; this delegates
// to that stored state.
//
// Transitional behavior: bundles assembled without this module keep existing
// fast behavior (enabled) instead of throwing, so old handcrafted bundles
// keep working. Long-term direction: every official profile carries this
// module, and an official bundle that omits it must fail rather than
// silently ignore requested disables. A present registry with an unknown ID
// already throws: that is a programming error and must stay loud.
globalThis.pmjsOptimizationEnabled = function(id) {
  if (!globalThis.PMJS || !PMJS.optimizations ||
      typeof PMJS.optimizations.isEnabled !== 'function') {
    return true;
  }
  return PMJS.optimizations.isEnabled(id);
};
