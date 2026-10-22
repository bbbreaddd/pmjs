var storageValues = Object.create(null);
function webStoragePath(key) {
  return 'web-storage-v2/k-' + encodeURIComponent(String(key));
}
function legacyWebStoragePath(key) {
  key = String(key);
  return key === '' || key === '.' || key === '..' ? null : 'web-storage/' + encodeURIComponent(key);
}
function readWebStorage(key) {
  var value = NativeHost.storage.readText(webStoragePath(key));
  var legacy = legacyWebStoragePath(key);
  return value === null && legacy ? NativeHost.storage.readText(legacy) : value;
}
globalThis.localStorage = {
  getItem: function(key) {
    if (NativeHost.storage) return readWebStorage(key);
    return Object.prototype.hasOwnProperty.call(storageValues, key) ? storageValues[key] : null;
  },
  setItem: function(key, value) {
    if (NativeHost.storage) {
      NativeHost.storage.writeText(webStoragePath(key), String(value));
      var legacy = legacyWebStoragePath(key);
      if (legacy) NativeHost.storage.remove(legacy);
    }
    else storageValues[key] = String(value);
  },
  removeItem: function(key) {
    if (NativeHost.storage) {
      NativeHost.storage.remove(webStoragePath(key));
      var legacy = legacyWebStoragePath(key);
      if (legacy) NativeHost.storage.remove(legacy);
    }
    else delete storageValues[key];
  },
  clear: function() {
    if (NativeHost.storage) {
      var entries = NativeHost.storage.readDirectory('web-storage');
      if (entries) {
        for (var index = 0; index < entries.length; index++) {
          NativeHost.storage.remove('web-storage/' + entries[index]);
        }
      }
      entries = NativeHost.storage.readDirectory('web-storage-v2');
      if (entries) {
        for (var nextIndex = 0; nextIndex < entries.length; nextIndex++) {
          NativeHost.storage.remove('web-storage-v2/' + entries[nextIndex]);
        }
      }
    } else {
      storageValues = Object.create(null);
    }
  }
};

// Session data belongs to this guest instance and is discarded on restart.
var sessionValues = Object.create(null);
globalThis.sessionStorage = {
  get length() { return Object.keys(sessionValues).length; },
  key: function(index) {
    var keys = Object.keys(sessionValues), key = keys[Number(index) >>> 0];
    return key === undefined ? null : key;
  },
  getItem: function(key) {
    key = String(key);
    return Object.prototype.hasOwnProperty.call(sessionValues, key) ? sessionValues[key] : null;
  },
  setItem: function(key, value) { sessionValues[String(key)] = String(value); },
  removeItem: function(key) { delete sessionValues[String(key)]; },
  clear: function() { sessionValues = Object.create(null); }
};
