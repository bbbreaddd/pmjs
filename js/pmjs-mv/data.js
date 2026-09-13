if (typeof Window_Base !== 'undefined' && Window_Base.prototype.update) {
  var originalWindowBaseUpdate = Window_Base.prototype.update;
  Window_Base.prototype.update = function() {
    if (!this.visible) return;
    return originalWindowBaseUpdate.apply(this, arguments);
  };
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
      if (this._pmjsGlobalInfoCache) return this._pmjsGlobalInfoCache;
      var info = originalLoadGlobalInfo.apply(this, arguments);
      this._pmjsGlobalInfoCache = info;
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
