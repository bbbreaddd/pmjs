var storageValues = Object.create(null);
function webStoragePath(key) {
  return 'web-storage/' + encodeURIComponent(String(key));
}
globalThis.localStorage = {
  getItem: function(key) {
    if (NativeHost.storage) return NativeHost.storage.readText(webStoragePath(key));
    return Object.prototype.hasOwnProperty.call(storageValues, key) ? storageValues[key] : null;
  },
  setItem: function(key, value) {
    if (NativeHost.storage) NativeHost.storage.writeText(webStoragePath(key), String(value));
    else storageValues[key] = String(value);
  },
  removeItem: function(key) {
    if (NativeHost.storage) NativeHost.storage.remove(webStoragePath(key));
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
    } else {
      storageValues = Object.create(null);
    }
  }
};
globalThis.fetch = function(url) {
  if (url === '') return Promise.resolve({ ok: true });
  var target = String(url);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target) && !/^file:/i.test(target)) {
    return Promise.reject(new TypeError('network fetch is unavailable: ' + target));
  }
  var encoded = target.split('?')[0].replace(/^file:\/\/\/game\//, '')
    .replace(/^\.\//, '').replace(/%(?![0-9a-f]{2})/gi, '%25');
  var path = gameReadPath(decodeURIComponent(encoded));
  return new Promise(function(resolve) {
    pendingTasks.push(function() {
      var text = NativeHost.fs.readText(path);
      var status = text === null ? 404 : 200;
      var body = text === null ? '' : text;
      resolve({
        ok: status >= 200 && status < 300,
        status: status,
        statusText: status === 200 ? 'OK' : 'Not Found',
        url: target,
        headers: { get: function() { return null; } },
        text: function() { return Promise.resolve(body); },
        json: function() {
          try {
            return Promise.resolve(JSON.parse(body));
          } catch (parseError) {
            return Promise.reject(parseError);
          }
        },
        arrayBuffer: function() {
          if (typeof TextEncoder === 'function') return Promise.resolve(new TextEncoder().encode(body).buffer);
          var bytes = new Uint8Array(body.length);
          for (var index = 0; index < body.length; index++) bytes[index] = body.charCodeAt(index) & 255;
          return Promise.resolve(bytes.buffer);
        }
      });
    });
  });
};
