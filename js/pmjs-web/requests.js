function requestArrayBuffer(bytes) {
  var view = ArrayBuffer.isView(bytes)
    ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    : new Uint8Array(bytes);
  return view.slice().buffer;
}

globalThis.fetch = function(url) {
  if (url === '') return Promise.resolve({ ok: true });
  return new Promise(function(resolve, reject) {
    var target = String(url);
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target) && !/^file:/i.test(target)) {
      reject(new TypeError('network fetch is unavailable: ' + target));
      return;
    }
    var encoded = target.split('?')[0].replace(/^file:\/\/\/game\//, '')
      .replace(/^\.\//, '').replace(/%(?![0-9a-f]{2})/gi, '%25');
    var path = gameReadPath(decodeURIComponent(encoded));
    PMJS.tasks.enqueue(function() {
      try {
        var bytes = NativeHost.fs.readBytes(path);
        var status = bytes === null ? 404 : 200;
        var body = bytes === null ? new ArrayBuffer(0) : requestArrayBuffer(bytes);
        var text = function() { return new TextDecoder().decode(body); };
        resolve({
          ok: status >= 200 && status < 300, status: status,
          statusText: status === 200 ? 'OK' : 'Not Found', url: target,
          headers: { get: function() { return null; } },
          text: function() { return Promise.resolve(text()); },
          json: function() { return Promise.resolve().then(function() { return JSON.parse(text()); }); },
          arrayBuffer: function() { return Promise.resolve(body.slice(0)); }
        });
      } catch (error) { reject(error); }
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
  this._requestGeneration = 0;
  this._sent = false;
  this._async = true;
}

XMLHttpRequest.prototype = Object.create(EventTarget.prototype);
XMLHttpRequest.prototype.constructor = XMLHttpRequest;
XMLHttpRequest.prototype.open = function(method, url, async) {
  this._async = async !== false;
  this._sent = false;
  this._method = String(method).toUpperCase();
  this._url = String(url).replace(/^\.\//, '');
  this._requestGeneration++;
  this.status = 0;
  this.responseText = '';
  this.response = null;
  this.readyState = 1;
  pmjsInvokeEventHandler(this, this.onreadystatechange,
    { type: 'readystatechange', target: this });
  this.dispatchEvent({ type: 'readystatechange', target: this });
};
XMLHttpRequest.prototype.overrideMimeType = function() {};
['UNSENT', 'OPENED', 'HEADERS_RECEIVED', 'LOADING', 'DONE'].forEach(function(name, value) {
  Object.defineProperty(XMLHttpRequest, name, { value: value, enumerable: true });
  Object.defineProperty(XMLHttpRequest.prototype, name, { value: value, enumerable: true });
});

XMLHttpRequest.prototype._emit = function(type, generation) {
  var event = { type: type, target: this };
  pmjsInvokeEventHandler(this, this['on' + type], event);
  if (this._requestGeneration !== generation) return false;
  this.dispatchEvent(event);
  return this._requestGeneration === generation;
};

XMLHttpRequest.prototype.abort = function() {
  var active = this._sent;
  var generation = active ? ++this._requestGeneration : this._requestGeneration;
  this._sent = false;
  this.status = 0;
  this.response = null;
  this.responseText = '';
  if (active) {
    this.readyState = this.DONE;
    if (!this._emit('readystatechange', generation)) return;
    if (!this._emit('abort', generation)) return;
    if (!this._emit('loadend', generation)) return;
  }
  if (active || this.readyState === this.DONE) this.readyState = this.UNSENT;
};

XMLHttpRequest.prototype.send = function() {
  if (this.readyState !== this.OPENED || this._sent) {
    var invalidState = new Error('XMLHttpRequest is not open or has already been sent');
    invalidState.name = 'InvalidStateError';
    throw invalidState;
  }
  if (this._method !== 'GET') throw new Error('XMLHttpRequest only supports GET');
  var request = this;
  var generation = this._requestGeneration;
  var binary = this.responseType === 'arraybuffer';
  this._sent = true;
  function complete() {
    if (request._requestGeneration !== generation) return;
    var contents = null;
    try {
      var encodedPath = request._url.split('?')[0].replace(/%(?![0-9a-f]{2})/gi, '%25');
      var resolved = gamePath(decodeURIComponent(encodedPath));
      contents = binary ? NativeHost.fs.readBytes(resolved) : NativeHost.fs.readText(resolved);
      if (contents === null && /\/maps\/Map\d+\.json$/i.test(resolved)) {
        var alternate = resolved.replace(/\/maps\/Map(\d+)\.json$/i, '/maps/map$1.json');
        contents = binary ? NativeHost.fs.readBytes(alternate) : NativeHost.fs.readText(alternate);
      }
      if (contents !== null && binary) contents = requestArrayBuffer(contents);
    } catch (_) {
      contents = null;
    }
    request._sent = false;
    request.status = contents === null ? 404 : 200;
    request.readyState = request.DONE;
    if (contents !== null) {
      request.response = contents;
      if (!binary) request.responseText = contents;
    }
    if (!request._emit('readystatechange', generation)) return;
    if (!request._emit(contents === null ? 'error' : 'load', generation)) return;
    request._emit('loadend', generation);
  }
  if (this._async) PMJS.tasks.enqueue(complete);
  else complete();
};
globalThis.XMLHttpRequest = XMLHttpRequest;
