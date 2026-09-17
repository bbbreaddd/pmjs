// Global-info memoization owned by pmjs-mv. Gated at the read below; the
// ordinary path always calls through to the original implementation.
if (typeof PMJS !== 'undefined' && PMJS.optimizations &&
    typeof PMJS.optimizations.register === 'function') {
  PMJS.optimizations.register({ id: 'data.global-info-cache', owner: 'pmjs-mv',
    fallback: 'read global info through the original DataManager implementation on every call' });
}

if (typeof DataManager !== 'undefined' &&
    typeof DataManager.isDatabaseLoaded === 'function') {
  var originalIsDatabaseLoaded = DataManager.isDatabaseLoaded;
  DataManager._pmjsOriginalIsDatabaseLoaded = originalIsDatabaseLoaded;
  DataManager.isDatabaseLoaded = function() {
    if (!originalIsDatabaseLoaded.apply(this, arguments)) return false;
    if (typeof pendingNativeImageLoads !== 'undefined' &&
        pendingNativeImageLoads !== 0) return false;
    if (typeof pendingTasks !== 'undefined' && pendingTasks.length !== 0) return false;
    return true;
  };

  if (typeof DataManager.loadGlobalInfo === 'function' &&
      !DataManager._pmjsGlobalCachePatched) {
    var originalLoadGlobalInfo = DataManager.loadGlobalInfo;
    DataManager.loadGlobalInfo = function() {
      var useCache = typeof pmjsOptimizationEnabled !== 'function' ||
        pmjsOptimizationEnabled('data.global-info-cache');
      if (useCache && this._pmjsGlobalInfoCache) return this._pmjsGlobalInfoCache;
      var info = originalLoadGlobalInfo.apply(this, arguments);
      if (useCache) this._pmjsGlobalInfoCache = info;
      return info;
    };
    var originalSaveGlobalInfo = DataManager.saveGlobalInfo;
    if (typeof originalSaveGlobalInfo === 'function') {
      DataManager.saveGlobalInfo = function(info) {
        this._pmjsGlobalInfoCache = info;
        return originalSaveGlobalInfo.apply(this, arguments);
      };
    }
    DataManager._pmjsGlobalCachePatched = true;
  }
}
