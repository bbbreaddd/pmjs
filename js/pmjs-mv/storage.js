function installNativeStorageManager() {
  if (!NativeHost.storage || !globalThis.StorageManager) return;
  StorageManager.isLocalMode = function() { return true; };
  StorageManager.localFileDirectoryPath = function() { return '/save/'; };
  // MV save paths are rooted in host-owned storage.
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
  // Preserve the previous save as a backup before atomic replacement.
  if (typeof StorageManager.saveToLocalFile === 'function' &&
      !StorageManager._pmjsAtomicPatched) {
    var originalSaveToLocalFile = StorageManager.saveToLocalFile;
    StorageManager.saveToLocalFile = function(savefileId, json) {
      var path = this.localFilePath(savefileId);
      var storagePath = path.indexOf('/save/') === 0 ? path.slice(6) : path;
      var storageBackup = storagePath + '.bak';
      try {
        if (NativeHost.storage.exists(storagePath)) {
          try { NativeHost.storage.remove(storageBackup); } catch (_) {}
          try { NativeHost.storage.rename(storagePath, storageBackup); } catch (_) {}
        }
      } catch (_) {}
      return originalSaveToLocalFile.call(this, savefileId, json);
    };
    StorageManager._pmjsAtomicPatched = true;
  }
  // The host rename already creates the local backup; web-mode backups retain
  // the stock implementation.
  if (typeof StorageManager.backup === 'function' &&
      !StorageManager._pmjsBackupPatched) {
    var originalStorageBackup = StorageManager.backup;
    StorageManager.backup = function(savefileId) {
      var local = true;
      try {
        if (typeof StorageManager.isLocalMode === 'function') {
          local = !!StorageManager.isLocalMode();
        }
      } catch (_) {}
      if (local && StorageManager._pmjsAtomicPatched) return;
      return originalStorageBackup.apply(this, arguments);
    };
    StorageManager._pmjsBackupPatched = true;
  }
  if (typeof StorageManager.loadFromLocalFile === 'function' &&
      !StorageManager._pmjsLoadPatched) {
    var originalLoadFromLocalFile = StorageManager.loadFromLocalFile;
    StorageManager.loadFromLocalFile = function(savefileId) {
      try {
        return originalLoadFromLocalFile.call(this, savefileId);
      } catch (error) {
        var path = this.localFilePath(savefileId);
        var backup = path + '.bak';
        var storageBackup = backup.indexOf('/save/') === 0 ? backup.slice(6) : backup;
        try {
          if (NativeHost.storage.exists(storageBackup)) {
            return LZString.decompressFromBase64(
              NativeHost.storage.readText(storageBackup));
          }
        } catch (_) {}
        throw error;
      }
    };
    StorageManager._pmjsLoadPatched = true;
  }
  if (typeof StorageManager.remove === 'function' && !StorageManager._pmjsRemovePatched) {
    var originalStorageRemove = StorageManager.remove;
    StorageManager.remove = function(savefileId) {
      try {
        if (globalThis.DataManager) globalThis.DataManager._pmjsGlobalInfoCache = null;
      } catch (_) {}
      return originalStorageRemove.apply(this, arguments);
    };
    StorageManager._pmjsRemovePatched = true;
  }
}
installNativeStorageManager();
