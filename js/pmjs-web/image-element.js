var NativeImage = (function() {
function NativeImage() {
  GenericElement.call(this, 'img');
  this.width = 0;
  this.height = 0;
  this.naturalWidth = 0;
  this.naturalHeight = 0;
  this.complete = true;
  this._src = '';
  this._nativeImage = null;
  this._nativeCanvas = null;
  this._pmjsCanvasOwner = null;
  this._loadGeneration = 0;
  this._pmjsPreparedTileSet = PMJS.images.preparedTileSet || "";
  this._pmjsLoadFailed = false;
  this._pmjsLoadError = null;
  if (!Object.prototype.hasOwnProperty.call(PMJS.images, 'pendingLoads')) {
    Object.defineProperty(PMJS.images, 'pendingLoads', {
      get: function() { return pendingNativeImageLoads; }
    });
  }
}

var pendingNativeImageLoads = 0;

NativeImage.prototype = Object.create(GenericElement.prototype);
NativeImage.prototype.constructor = NativeImage;
NativeImage.prototype._attributeChanged = function(name, value) {
  if (name !== 'src') return;
  this.src = value === null ? '' : value;
  if (value === null) delete this._attributes.src;
};
function loadSource(url, encryption) {
    if (this._pmjsCanvasOwner) {
      this._pmjsCanvasOwner._releaseNativeCanvas();
      this._pmjsCanvasOwner = null;
    } else if (this._nativeCanvas) {
      releaseNativeResource(this._nativeCanvas, 'canvas');
    }
    this._nativeCanvas = null;
    this._src = String(url);
    this._attributes.src = this._src;
    var source = this._src;
    var generation = ++this._loadGeneration;
    this._pmjsLoadFailed = false;
    this._pmjsLoadError = null;
    if (!this._src) {
      releaseNativeResource(this._nativeImage, 'image');
      this._nativeImage = null;
      this.width = this.height = this.naturalWidth = this.naturalHeight = 0;
      this.complete = true;
      return;
    }
    var objectUrl = typeof globalThis.pmjsIsObjectURL === 'function' &&
      globalThis.pmjsIsObjectURL(source);
    var image = this;
    var preparedTileSet = this._pmjsPreparedTileSet;
    image.complete = false;
    PMJS.tasks.enqueue(function() {
      if (generation !== image._loadGeneration) return;
      pendingNativeImageLoads++;
      function current() { return generation === image._loadGeneration; }
      var loading = Promise.resolve().then(function() {
        if (objectUrl) {
          var blob = typeof globalThis.pmjsResolveObjectURL === 'function'
            ? globalThis.pmjsResolveObjectURL(source) : null;
          if (!blob) throw new Error('object URL is unavailable');
          return blob.arrayBuffer().then(function(buffer) {
            if (!current() || PMJS.tasks.stopped) return null;
            return NativeHost.images.loadBytesAsync(buffer, PMJS.images.shouldRetainPixels(source));
          });
        }
        var path = decodeResourceUrlPath(source)
          .replace(/^file:\/\/\/game\//, '')
          .replace(/^\.\//, '');
        if (encryption) {
          return NativeHost.images.loadEncryptedAsync(path, encryption.key,
            PMJS.images.shouldRetainPixels(encryption.logicalPath));
        }
        var prefix = 'generated-assets:/';
        var generated = path.indexOf(prefix) === 0;
        var loader = generated ? NativeHost.assets : NativeHost.images;
        return (generated ? loader.loadImageAsync : loader.loadAsync).call(loader,
          generated ? path.slice(prefix.length) : path,
          PMJS.images.shouldRetainPixels(path), preparedTileSet);
      });
      function deliver(result, error) {
        var loaded = result ? trackNativeResource(result, 'image') : null;
        function discardLoaded() {
          try { releaseNativeResource(loaded, 'image'); }
          finally { pendingNativeImageLoads--; }
        }
        PMJS.tasks.enqueue(function() {
          if (!current()) {
            discardLoaded();
            return;
          }
          try {
            releaseNativeResource(image._nativeImage, 'image');
            image._nativeImage = loaded;
            image.width = image.naturalWidth = loaded ? loaded.width : 0;
            image.height = image.naturalHeight = loaded ? loaded.height : 0;
            image.complete = true;
            image._pmjsLoadFailed = !loaded;
            image._pmjsLoadError = error || null;
            if (!loaded && !objectUrl && typeof NativeHost.images.fallbackImage === 'function') {
              image._nativeImage = trackNativeResource(NativeHost.images.fallbackImage(), 'image');
            }
            return pmjsDispatchHostEvent(image, { type: loaded ? 'load' : 'error', target: image }, current)
              .then(function(valid) {
                if (valid && loaded) PMJS.images.loadCompleted(image);
              }).finally(function() { pendingNativeImageLoads--; }).catch(pmjsReportEventError);
          } catch (failure) {
            pendingNativeImageLoads--;
            throw failure;
          }
        }, { errorMode: 'event', discard: discardLoaded });
      }
      loading.then(function(result) { deliver(result, null); }, function(error) { deliver(null, error); });
    }, { errorMode: 'event' });
}
Object.defineProperty(NativeImage.prototype, 'src', {
  get: function() { return this._src; },
  set: function(url) { loadSource.call(this, url, null); }
});
PMJS.images.loadEncrypted = function(image, url, key, logicalPath) {
  if (!image || typeof url !== 'string' || !url || Object.getPrototypeOf(image) !== NativeImage.prototype ||
      Object.prototype.hasOwnProperty.call(image, 'src') || typeof NativeHost.images.loadEncryptedAsync !== 'function') return false;
  loadSource.call(image, url, { key: key, logicalPath: logicalPath });
  return true;
};

return NativeImage;
})();

function nativeImageFromResource(resource) {
  if (!resource) return null;
  var image = new NativeImage();
  image._nativeImage = trackNativeResource(resource, 'image');
  image._pmjsOwnedTextureSource = true;
  image.width = image.naturalWidth = Number(resource.width) || 0;
  image.height = image.naturalHeight = Number(resource.height) || 0;
  image.complete = true;
  return image;
}
