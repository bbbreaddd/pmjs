function installNativeStorageManager() {
  if (!NativeHost.storage || !globalThis.StorageManager) return;
  // First install wins: later reinstalls (e.g. after plugins load) are no-ops.
  if (StorageManager._pmjsLoadPatched && StorageManager._pmjsExistsPatched) return;
  StorageManager.isLocalMode = function() { return true; };
  StorageManager.localFileDirectoryPath = function() { return '/save/'; };
  if (typeof StorageManager.localFilePath === 'function') {
    StorageManager.localFilePath = function(savefileId) {
      if (savefileId < 0) return '/save/config.rpgsave';
      if (savefileId === 0) return '/save/global.rpgsave';
      return '/save/file' + savefileId + '.rpgsave';
    };
  }
  if (typeof StorageManager.webStorageKey !== 'function') {
    StorageManager.webStorageKey = function(savefileId) {
      return 'RPG File' + savefileId;
    };
  }

  if (typeof PMJS !== 'undefined' && PMJS.optimizations &&
      typeof PMJS.optimizations.register === 'function') {
    PMJS.optimizations.register({
      id: 'storage.read-burst-coalesce',
      owner: 'pmjs-mv',
      fallback: 'Direct disk reads and decompressions for every StorageManager query'
    });
  }

  // Coalesces immutable reads within a synchronous turn, until the next
  // microtask checkpoint. Lives underneath the plugin-observable surface, so
  // plugin wrappers always run; only physical reads underneath coalesce.
  var readBurst = null;
  var clearScheduled = false;
  var storageGeneration = 0;

  function currentReadBurst() {
    if (typeof pmjsOptimizationEnabled === 'function' &&
        !pmjsOptimizationEnabled('storage.read-burst-coalesce')) {
      return null;
    }
    if (!readBurst || readBurst.generation !== storageGeneration) {
      readBurst = {
        generation: storageGeneration,
        loads: Object.create(null),
        exists: Object.create(null)
      };
    }
    if (!clearScheduled) {
      clearScheduled = true;
      var schedule = typeof queueMicrotask === 'function'
        ? queueMicrotask
        : (typeof Promise === 'function'
            ? function(fn) { Promise.resolve().then(fn); }
            : function(fn) { setTimeout(fn, 0); });
      schedule(function() {
        readBurst = null;
        clearScheduled = false;
      });
    }
    return readBurst;
  }

  function invalidateStorageBurst() {
    storageGeneration++;
    readBurst = null;
  }
  globalThis.pmjsInvalidateStorageBurst = invalidateStorageBurst;

  if (!NativeHost.storage._pmjsInvalidationHooked) {
    var rawStorage = NativeHost.storage;
    if (typeof rawStorage.writeText === 'function') {
      var origWriteText = rawStorage.writeText;
      rawStorage.writeText = function() {
        invalidateStorageBurst();
        return origWriteText.apply(this, arguments);
      };
    }
    if (typeof rawStorage.remove === 'function') {
      var origRemove = rawStorage.remove;
      rawStorage.remove = function() {
        invalidateStorageBurst();
        return origRemove.apply(this, arguments);
      };
    }
    if (typeof rawStorage.rename === 'function') {
      var origRename = rawStorage.rename;
      rawStorage.rename = function() {
        invalidateStorageBurst();
        return origRename.apply(this, arguments);
      };
    }
    rawStorage._pmjsInvalidationHooked = true;
  }

  function normalizeStoragePath(filePath) {
    if (!filePath) return '';
    return filePath.indexOf('/save/') === 0 ? filePath.slice(6) : filePath;
  }

  function hasBurstEntry(cache, key) {
    return Object.prototype.hasOwnProperty.call(cache, key);
  }

  // Keyed by storage path, not savefileId. Missing files decompress a null
  // payload, matching stock.
  function pmjsReadDecompressed(storagePath) {
    var burst = currentReadBurst();
    if (burst && storagePath && hasBurstEntry(burst.loads, storagePath)) {
      return burst.loads[storagePath];
    }
    var raw = NativeHost.storage.readText(storagePath);
    var data = raw === null ? null : LZString.decompressFromBase64(raw);
    if (burst && storagePath) {
      burst.loads[storagePath] = data;
    }
    return data;
  }

  // A missing primary can remain after an interrupted older save.
  function pmjsReadLocalSave(savefileId) {
    var storagePath = normalizeStoragePath(this.localFilePath(savefileId));
    try {
      var primary = pmjsReadDecompressed(storagePath);
      if (primary !== null) return primary;
    } catch (error) {
      if (!pmjsCachedStorageExists(storagePath + '.bak')) throw error;
    }
    if (pmjsCachedStorageExists(storagePath + '.bak')) {
      return pmjsReadDecompressed(storagePath + '.bak');
    }
    return null;
  }

  function pmjsCachedStorageExists(storagePath) {
    var burst = currentReadBurst();
    if (burst && storagePath && hasBurstEntry(burst.exists, storagePath)) {
      return burst.exists[storagePath];
    }
    var result = NativeHost.storage.exists(storagePath);
    if (burst && storagePath) {
      burst.exists[storagePath] = result;
    }
    return result;
  }

  function pmjsLocalSaveExists(savefileId) {
    var storagePath = normalizeStoragePath(this.localFilePath(savefileId));
    return pmjsCachedStorageExists(storagePath) ||
      pmjsCachedStorageExists(storagePath + '.bak');
  }

  if (typeof StorageManager.loadFromLocalFile === 'function' &&
      !StorageManager._pmjsLoadPatched) {
    StorageManager.loadFromLocalFile = function(savefileId) {
      return pmjsReadLocalSave.call(this, savefileId);
    };
    StorageManager._pmjsLoadPatched = true;
  }
  if (typeof StorageManager.localFileExists === 'function' &&
      !StorageManager._pmjsExistsPatched) {
    StorageManager.localFileExists = function(savefileId) {
      return pmjsLocalSaveExists.call(this, savefileId);
    };
    StorageManager._pmjsExistsPatched = true;
  }
  if (typeof StorageManager.remove === 'function' && !StorageManager._pmjsRemovePatched) {
    var originalStorageRemove = StorageManager.remove;
    StorageManager.remove = function(savefileId) {
      invalidateStorageBurst();
      return originalStorageRemove.apply(this, arguments);
    };
    StorageManager._pmjsRemovePatched = true;
  }
}
installNativeStorageManager();
