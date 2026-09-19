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
}

