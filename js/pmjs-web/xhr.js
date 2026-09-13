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
    if (typeof request['on' + type] === 'function') request['on' + type]({ target: request });
    request.dispatchEvent({ type: type, target: request });
  });
};
globalThis.XMLHttpRequest = XMLHttpRequest;

