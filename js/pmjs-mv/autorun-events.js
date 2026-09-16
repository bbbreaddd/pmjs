var pmjsAutorunStockFingerprint =
  'function(){' +
  'for(vari=0;i<$dataCommonEvents.length;i++){' +
  'varevent=$dataCommonEvents[i];' +
  'if(event&&event.trigger===1&&$gameSwitches.value(event.switchId)){' +
  'this._interpreter.setup(event.list);returntrue;}}returnfalse;}';

var pmjsAutorunCommonEventState = {
  data: null,
  length: 0,
  candidates: [],
  stats: { rebuilds: 0, fallbackCalls: 0, setupInvalidations: 0 }
};

function pmjsRebuildAutorunCommonEventList(data) {
  var state = pmjsAutorunCommonEventState;
  var candidates = [];
  if (Array.isArray(data)) {
    for (var i = 0; i < data.length; i++) {
      var entry = data[i];
      if (entry && entry.trigger === 1) candidates.push({ id: i, entry: entry });
    }
    state.data = data;
    state.length = data.length;
  }
  state.candidates = candidates;
  state.stats.rebuilds++;
}

function pmjsAutorunMethodIsStock(method) {
  var source = '';
  try {
    source = Function.prototype.toString.call(method);
  } catch (_) { return false; }
  return source.replace(/\s+/g, '') === pmjsAutorunStockFingerprint;
}

function pmjsInstallAutorunCommonEventIndex(host) {
  host = host || globalThis;
  if (!pmjsAutorunCommonEventIndexEnabled()) return false;
  var mapProto = host.Game_Map && host.Game_Map.prototype;
  if (!mapProto || mapProto.__pmjsAutorunCommonEventIndex ||
      typeof mapProto.setupAutorunCommonEvent !== 'function') return false;
  if (!pmjsAutorunMethodIsStock(mapProto.setupAutorunCommonEvent)) return false;
  var original = mapProto.setupAutorunCommonEvent;
  var stats = pmjsAutorunCommonEventState.stats;
  mapProto.setupAutorunCommonEvent = function() {
    var data = host.$dataCommonEvents;
    if (!Array.isArray(data)) {
      stats.fallbackCalls++;
      return original.apply(this, arguments);
    }
    var state = pmjsAutorunCommonEventState;
    if (data !== state.data || data.length !== state.length) {
      pmjsRebuildAutorunCommonEventList(data);
      state = pmjsAutorunCommonEventState;
    }
    var candidates = state.candidates;
    for (var i = 0; i < candidates.length; i++) {
      var candidate = candidates[i];
      var entry = data[candidate.id];
      if (entry !== candidate.entry) {
        pmjsRebuildAutorunCommonEventList(data);
        return this.setupAutorunCommonEvent();
      }
      if (entry && entry.trigger === 1 &&
          host.$gameSwitches.value(entry.switchId)) {
        this._interpreter.setup(entry.list);
        return true;
      }
    }
    return false;
  };
  mapProto.__pmjsAutorunCommonEventIndex = true;
  // Transfer bound: map setup is the choke point every load/transfer/new
  // game passes through. Purely additive invalidation with no shape
  // requirement on the existing method.
  if (typeof mapProto.setupEvents === 'function' &&
      !mapProto.__pmjsAutorunSetupInvalidation) {
    var originalSetupEvents = mapProto.setupEvents;
    mapProto.setupEvents = function() {
      var result = originalSetupEvents.apply(this, arguments);
      pmjsAutorunCommonEventState.data = null;
      pmjsAutorunCommonEventState.length = 0;
      pmjsAutorunCommonEventState.stats.setupInvalidations++;
      return result;
    };
    mapProto.__pmjsAutorunSetupInvalidation = true;
  }
  return true;
}

function pmjsRebuildAutorunCommonEvents() {
  var host = globalThis;
  if (Array.isArray(host.$dataCommonEvents)) {
    pmjsRebuildAutorunCommonEventList(host.$dataCommonEvents);
  }
}

function pmjsAutorunCommonEventIndexEnabled() {
  try {
    if (typeof NativeHost === 'undefined' || !NativeHost ||
        !NativeHost.runtime ||
        typeof NativeHost.runtime.env !== 'function') return true;
    return NativeHost.runtime.env('PMJS_MV_AUTORUN_INDEX') !== '0';
  } catch (_) { return true; }
}

globalThis.pmjsInstallAutorunCommonEventIndex = pmjsInstallAutorunCommonEventIndex;
globalThis.pmjsRebuildAutorunCommonEvents = pmjsRebuildAutorunCommonEvents;
globalThis.pmjsAutorunCommonEventStats = function() {
  var stats = pmjsAutorunCommonEventState.stats;
  return { rebuilds: stats.rebuilds, fallbackCalls: stats.fallbackCalls,
    setupInvalidations: stats.setupInvalidations };
};
globalThis.pmjsAutorunMethodIsStock = pmjsAutorunMethodIsStock;
