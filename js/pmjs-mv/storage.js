var pmjsStorageDecodeIntrinsics = {
  fromCharCode: String.fromCharCode, charAt: String.prototype.charAt,
  charCodeAt: String.prototype.charCodeAt, indexOf: String.prototype.indexOf,
  replace: String.prototype.replace, pow: Math.pow,
  regexpReplace: RegExp.prototype[Symbol.replace], regexpExec: RegExp.prototype.exec,
  hasOwnProperty: Object.prototype.hasOwnProperty, string: String, isNaN: isNaN
};

function installNativeStorageManager() {
  if (!NativeHost.storage || !globalThis.StorageManager) return;
  if (StorageManager._pmjsLoadPatched && StorageManager._pmjsExistsPatched) return;
  StorageManager.isLocalMode = function() { return true; };
  // Filename selection remains guest-owned; stock and plugins resolve it through
  // the relocated directory.
  StorageManager.localFileDirectoryPath = function() { return '/save/'; };
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
  // plugin wrappers always run; reviewed decoding and physical reads coalesce.
  var readBurst = null;
  var clearScheduled = false;
  var lz = globalThis.LZString;
  var lzDescriptors = lz && Object.getOwnPropertyDescriptors(lz);
  var decodedMethods = lzDescriptors && ['decompressFromBase64', 'decompress', '_f', '_keyStr'];
  var reviewedDecoder = decodedMethods && decodedMethods.every(function(name) {
    return lzDescriptors[name] && 'value' in lzDescriptors[name];
  }) && lzDescriptors._f.value === pmjsStorageDecodeIntrinsics.fromCharCode &&
    lzDescriptors._keyStr.value === 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=' &&
    PMJS.methods.matchesSource(lzDescriptors.decompressFromBase64.value,
      ['126b1d999f2babac0c5091b56aff3690654715013c91ce438159f91dc314ca5a']) &&
    PMJS.methods.matchesSource(lzDescriptors.decompress.value,
      ['0fb41c72b7362f19b9ee6eb4d82af2eca53f24c6232d094964ec1d8589f5e7ce']);

  function canReuseDecodedText() {
    var native = pmjsStorageDecodeIntrinsics;
    return reviewedDecoder && globalThis.LZString === lz &&
      String.prototype.charAt === native.charAt && String.prototype.charCodeAt === native.charCodeAt &&
      String.prototype.indexOf === native.indexOf && String.prototype.replace === native.replace &&
      Math.pow === native.pow && RegExp.prototype[Symbol.replace] === native.regexpReplace &&
      RegExp.prototype.exec === native.regexpExec && decodedMethods.every(function(name) {
        var descriptor = Object.getOwnPropertyDescriptor(lz, name);
        return descriptor && 'value' in descriptor && descriptor.value === lzDescriptors[name].value;
      });
  }

  var compressedMethods = ['compressToBase64', 'compress', '_f', '_keyStr'];
  var reviewedEncoder = lzDescriptors && compressedMethods.every(function(name) {
    return lzDescriptors[name] && 'value' in lzDescriptors[name];
  }) && lzDescriptors._f.value === pmjsStorageDecodeIntrinsics.fromCharCode &&
    lzDescriptors._keyStr.value === 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=' &&
    PMJS.methods.matchesSource(lzDescriptors.compressToBase64.value,
      ['ede382b47dc153069ca756f999fbfe132731fbb4b00f3eb2109ab3c2662dc1b2']) &&
    PMJS.methods.matchesSource(lzDescriptors.compress.value,
      ['f273a1c3b45edf246193114d92383a97345253182da9a55962f564b4703c0662']);
  if (reviewedEncoder && NativeHost.compression && lzDescriptors.compressToBase64.writable) {
    var originalEncoder = lzDescriptors.compressToBase64.value;
    var nativeEncoder = function(input) {
      var native = pmjsStorageDecodeIntrinsics;
      var unchanged = globalThis.LZString === lz &&
        String === native.string && String.prototype.charAt === native.charAt &&
        String.prototype.charCodeAt === native.charCodeAt && Math.pow === native.pow &&
        Object.prototype.hasOwnProperty === native.hasOwnProperty && isNaN === native.isNaN &&
        compressedMethods.every(function(name) {
          var descriptor = Object.getOwnPropertyDescriptor(lz, name);
          return descriptor && 'value' in descriptor && descriptor.value ===
            (name === 'compressToBase64' ? nativeEncoder : lzDescriptors[name].value);
        });
      return typeof input === 'string' && unchanged
        ? NativeHost.compression.compressLZString(input)
        : originalEncoder.apply(this, arguments);
    };
    lz.compressToBase64 = nativeEncoder;
  }

  function currentReadBurst() {
    if (!PMJS.optimizations.isEnabled('storage.read-burst-coalesce')) {
      return null;
    }
    var storageGeneration = NativeHost.storage.generation();
    if (!readBurst || readBurst.generation !== storageGeneration) {
      readBurst = {
        generation: storageGeneration,
        loads: Object.create(null),
        decoded: Object.create(null),
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

  function normalizeStoragePath(filePath) {
    if (!filePath) return '';
    filePath = String(filePath).replace(/\\/g, '/');
    return filePath.indexOf('/save/') === 0 ? filePath.slice(6) : filePath;
  }

  function hasBurstEntry(cache, key) {
    return Object.prototype.hasOwnProperty.call(cache, key);
  }

  // Custom decoders remain observable; only reviewed immutable results coalesce.
  function pmjsReadDecompressed(storagePath) {
    var burst = currentReadBurst();
    var raw;
    if (burst && storagePath && hasBurstEntry(burst.loads, storagePath)) {
      raw = burst.loads[storagePath];
    } else {
      raw = NativeHost.storage.readText(storagePath);
      if (burst && storagePath) burst.loads[storagePath] = raw;
    }
    if (raw === null) return null;
    var reuse = burst && storagePath && typeof raw === 'string' && canReuseDecodedText();
    if (reuse && hasBurstEntry(burst.decoded, storagePath)) return burst.decoded[storagePath];
    var decoded = typeof raw === 'string' && canReuseDecodedText() && NativeHost.compression
      ? NativeHost.compression.decompressLZString(raw)
      : LZString.decompressFromBase64(raw);
    if (reuse && typeof decoded === 'string') burst.decoded[storagePath] = decoded;
    return decoded;
  }

  // Null content may recover from a backup; read/decompression errors propagate.
  function pmjsReadLocalSave(savefileId) {
    var storagePath = normalizeStoragePath(this.localFilePath(savefileId));
    var primary = pmjsReadDecompressed(storagePath);
    if (primary !== null) return primary;
    if (pmjsCachedStorageExists(storagePath + '.bak') &&
        !pmjsCachedStorageExists(storagePath + '.deleted')) {
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
      (pmjsCachedStorageExists(storagePath + '.bak') &&
        !pmjsCachedStorageExists(storagePath + '.deleted'));
  }

  // Keep rollback backups, but distinguish deliberate deletion from interrupted
  // writes across restarts. A successful save or restore revives the slot.
  if (typeof StorageManager.removeLocalFile === 'function') {
    var removeLocalFile = StorageManager.removeLocalFile;
    StorageManager.removeLocalFile = function(savefileId) {
      var storagePath = normalizeStoragePath(this.localFilePath(savefileId));
      NativeHost.storage.writeText(storagePath + '.deleted', '');
      return removeLocalFile.apply(this, arguments);
    };
  }
  ['saveToLocalFile', 'restoreBackup'].forEach(function(method) {
    if (typeof StorageManager[method] !== 'function') return;
    var original = StorageManager[method];
    StorageManager[method] = function(savefileId) {
      var result = original.apply(this, arguments);
      var storagePath = normalizeStoragePath(this.localFilePath(savefileId));
      if (NativeHost.storage.exists(storagePath)) {
        NativeHost.storage.remove(storagePath + '.deleted');
      }
      return result;
    };
  });

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
}
