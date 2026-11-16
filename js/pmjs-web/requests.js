function requestArrayBuffer(bytes) {
  var view = ArrayBuffer.isView(bytes)
    ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    : new Uint8Array(bytes);
  return view.slice().buffer;
}

function requestMapFallbackPath(path) {
  return /\/maps\/Map\d+\.json$/i.test(path)
    ? path.replace(/\/maps\/Map(\d+)\.json$/i, '/maps/map$1.json') : null;
}

function localFetchResponse(target, bytes) {
  var status = bytes === null ? 404 : 200;
  var body = bytes === null ? new ArrayBuffer(0) : requestArrayBuffer(bytes);
  var text = function() { return new TextDecoder().decode(body); };
  return {
    ok: status >= 200 && status < 300, status: status,
    statusText: status === 200 ? 'OK' : 'Not Found', url: target,
    headers: { get: function() { return null; } },
    text: function() { return Promise.resolve(text()); },
    json: function() { return Promise.resolve().then(function() { return JSON.parse(text()); }); },
    arrayBuffer: function() { return Promise.resolve(body.slice(0)); }
  };
}

globalThis.fetch = function(url) {
  if (url === '') return Promise.resolve(localFetchResponse('', new Uint8Array(0)));
  return new Promise(function(resolve, reject) {
    var target = String(url);
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target) && !/^file:/i.test(target)) {
      reject(new TypeError('network fetch is unavailable: ' + target));
      return;
    }
    var encoded = target.replace(/^file:\/\/\/game\//, '').replace(/^\.\//, '');
    var path = gameReadPath(decodeResourceUrlPath(encoded));
    function deliver(bytes, error) {
      PMJS.tasks.enqueue(function() {
        if (error) { reject(error); return; }
        try {
          resolve(localFetchResponse(target, bytes));
        } catch (failure) { reject(failure); }
      }, { errorMode: 'event' });
    }
    PMJS.tasks.enqueue(function() {
      Promise.resolve().then(function() { return NativeHost.fs.readBytesAsync(path); }).then(
        function(bytes) { deliver(bytes, null); }, function(error) { deliver(null, error); });
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
  event._pmjsHandlerInvoked = true;
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
  var request = this, generation = this._requestGeneration;
  var binary = this.responseType === 'arraybuffer';
  var url = this._url;
  this._sent = true;
  function current() { return request._requestGeneration === generation; }
  function install(contents) {
    request.response = contents;
    if (!binary) request.responseText = contents;
  }
  function requestPath() {
    return gameReadPath(decodeResourceUrlPath(url.replace(/^file:\/\/\/game\//, '')));
  }
  if (!this._async) {
    var contents = null;
    try {
      var path = requestPath();
      contents = binary ? NativeHost.fs.readBytes(path) : NativeHost.fs.readText(path);
      var fallback = contents === null && requestMapFallbackPath(path);
      if (fallback) {
        contents = binary ? NativeHost.fs.readBytes(fallback) : NativeHost.fs.readText(fallback);
      }
      if (contents !== null && binary) contents = requestArrayBuffer(contents);
    } catch (_) { contents = null; }
    request._sent = false;
    request.status = contents === null ? 404 : 200;
    request.readyState = request.DONE;
    if (contents !== null) install(contents);
    if (!request._emit('readystatechange', generation)) return;
    if (!request._emit(contents === null ? 'error' : 'load', generation)) return;
    request._emit('loadend', generation);
    return;
  }
  if (!this._emit('loadstart', generation)) return;
  function notify(type, bytes) {
    return pmjsDispatchHostEvent(request, {
      type: type, target: request, lengthComputable: bytes !== undefined,
      loaded: bytes || 0, total: bytes || 0
    }, current);
  }
  function finish(bytes) {
    var contents = bytes === null ? null : binary ? requestArrayBuffer(bytes) : new TextDecoder().decode(bytes);
    var length = bytes === null ? 0 : bytes.byteLength;
    var chain = Promise.resolve();
    if (contents !== null) {
      [request.HEADERS_RECEIVED, request.LOADING].forEach(function(state) {
        chain = chain.then(function() {
          return PMJS.tasks.invoke(function() {
            if (!current()) return false;
            request.status = 200;
            request.readyState = state;
            if (state === request.LOADING && !binary) request.responseText = contents;
            return notify('readystatechange');
          }, 'event');
        });
      });
      chain = chain.then(function() { if (current()) return notify('progress', length); });
    }
    chain.then(function() {
      return PMJS.tasks.invoke(function() {
        if (!current()) return false;
        request._sent = false;
        request.status = contents === null ? 404 : 200;
        request.readyState = request.DONE;
        if (contents !== null) install(contents);
        return notify('readystatechange');
      }, 'event');
    }).then(function(valid) {
      if (valid) return notify(contents === null ? 'error' : 'load', length);
      return false;
    }).then(function(valid) {
      if (valid) return notify('loadend', length);
    }).catch(pmjsReportEventError);
  }
  PMJS.tasks.enqueue(function() {
    if (!current()) return;
    Promise.resolve().then(function() {
      var path = requestPath();
      return NativeHost.fs.readBytesAsync(path).then(function(bytes) {
        var fallback = current() && bytes === null && requestMapFallbackPath(path);
        if (fallback) {
          return NativeHost.fs.readBytesAsync(fallback);
        }
        return bytes;
      });
    }).then(finish, function() { finish(null); }).catch(pmjsReportEventError);
  }, { errorMode: 'event' });
};
globalThis.XMLHttpRequest = XMLHttpRequest;
