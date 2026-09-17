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
          if (typeof TextEncoder === 'function') {
            return Promise.resolve(new TextEncoder().encode(body).buffer);
          }
          var bytes = new Uint8Array(body.length);
          for (var index = 0; index < body.length; index++) {
            bytes[index] = body.charCodeAt(index) & 255;
          }
          return Promise.resolve(bytes.buffer);
        }
      });
    });
  });
};

function XMLHttpRequest() {
  EventTarget.call(this);
  this.status = 0;
  this.readyState = 0;
  this.responseText = '';
  this.response = null;
  this.responseType = '';
  this.onload = null;
  this.onerror = null;
  this.onreadystatechange = null;
}

XMLHttpRequest.prototype = Object.create(EventTarget.prototype);
XMLHttpRequest.prototype.constructor = XMLHttpRequest;
XMLHttpRequest.prototype.open = function(method, url) {
  this._method = String(method).toUpperCase();
  this._url = String(url).replace(/^\.\//, '');
};
XMLHttpRequest.prototype.overrideMimeType = function() {};
XMLHttpRequest.prototype.send = function() {
  if (this._method !== 'GET') throw new Error('XMLHttpRequest only supports GET');
  var encodedPath = this._url.split('?')[0].replace(/%(?![0-9a-f]{2})/gi, '%25');
  var resolved = gamePath(decodeURIComponent(encodedPath));
  var binary = this.responseType === 'arraybuffer';
  var contents = binary ? NativeHost.fs.readBytes(resolved) :
    NativeHost.fs.readText(resolved);
  if (contents === null && /\/maps\/Map\d+\.json$/i.test(resolved)) {
    contents = NativeHost.fs.readText(
      resolved.replace(/\/maps\/Map(\d+)\.json$/i, '/maps/map$1.json'));
  }
  var request = this;
  pendingTasks.push(function() {
    request.status = contents === null ? 404 : 200;
    request.readyState = 4;
    if (contents !== null) {
      request.response = contents;
      if (!binary) request.responseText = contents;
    }
    if (typeof request.onreadystatechange === 'function') request.onreadystatechange();
    var type = contents === null ? 'error' : 'load';
    if (typeof request['on' + type] === 'function') {
      request['on' + type]({ target: request });
    }
    request.dispatchEvent({ type: type, target: request });
  });
};
globalThis.XMLHttpRequest = XMLHttpRequest;
