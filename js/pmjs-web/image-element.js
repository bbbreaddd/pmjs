var NativeImage = (function() {
function NativeImage() {
  EventTarget.call(this);
  this.width = 0;
  this.height = 0;
  this.naturalWidth = 0;
  this.naturalHeight = 0;
  this.complete = false;
  this._src = '';
  this._nativeImage = null;
  this._nativeCanvas = null;
  this._pmjsCanvasOwner = null;
  this._loadGeneration = 0;
  this._pmjsPreparedTileSet = PMJS.images.preparedTileSet || "";
  this._pmjsLoadFailed = false;
  this._pmjsLoadError = null;
}

var pendingNativeImageLoads = 0;

NativeImage.prototype = Object.create(EventTarget.prototype);
NativeImage.prototype.constructor = NativeImage;
Object.defineProperty(NativeImage.prototype, 'src', {
  get: function() { return this._src; },
  set: function(url) {
    if (this._pmjsCanvasOwner) {
      this._pmjsCanvasOwner._releaseNativeCanvas();
      this._pmjsCanvasOwner = null;
    } else if (this._nativeCanvas) {
      releaseNativeResource(this._nativeCanvas, 'canvas');
    }
    this._nativeCanvas = null;
    this._src = String(url);
    var source = this._src;
    var generation = ++this._loadGeneration;
    if (!this._src) {
      releaseNativeResource(this._nativeImage, 'image');
      this._nativeImage = null;
      this.width = this.height = this.naturalWidth = this.naturalHeight = 0;
      this.complete = false;
      return;
    }
    var objectUrl = typeof globalThis.pmjsIsObjectURL === 'function' &&
      globalThis.pmjsIsObjectURL(source);
    var encodedPath = source.split('?')[0].replace(/%(?![0-9a-f]{2})/gi, '%25');
    var path = decodeURIComponent(encodedPath)
      .replace(/^file:\/\/\/game\//, '')
      .replace(/^\.\//, '');
    var image = this;
    var preparedTileSet = this._pmjsPreparedTileSet;
    image.complete = false;
    image._pmjsLoadFailed = false;
    image._pmjsLoadError = null;
    PMJS.tasks.enqueue(function() {
      if (objectUrl) {
        pendingNativeImageLoads++;
        var objectBlob = typeof globalThis.pmjsResolveObjectURL === 'function'
          ? globalThis.pmjsResolveObjectURL(source) : null;
        var objectLoad = objectBlob
          ? objectBlob.arrayBuffer().then(function(buffer) {
              var retain = PMJS.images.shouldRetainPixels(source);
              return NativeHost.images.loadBytesAsync(buffer, retain);
            })
          : Promise.reject(new Error('object URL is unavailable'));
        objectLoad.then(function(result) {
          var loaded = trackNativeResource(result, 'image');
          if (generation !== image._loadGeneration) {
            releaseNativeResource(loaded, 'image');
            return;
          }
          releaseNativeResource(image._nativeImage, 'image');
          image._nativeImage = loaded;
          image.width = image.naturalWidth = loaded.width;
          image.height = image.naturalHeight = loaded.height;
          image.complete = true;
          image.dispatchEvent({ type: 'load', target: image });
          PMJS.images.loadCompleted(image);
        }, function(error) {
          if (generation !== image._loadGeneration) return;
          releaseNativeResource(image._nativeImage, 'image');
          image._nativeImage = null;
          image.width = image.naturalWidth = 0;
          image.height = image.naturalHeight = 0;
          image.complete = true;
          image._pmjsLoadFailed = true;
          image._pmjsLoadError = error;
          image.dispatchEvent({ type: 'error', target: image });
        }).then(function() { pendingNativeImageLoads--; }, function(error) {
          pendingNativeImageLoads--;
          console.error(error && error.stack || error);
        });
        return;
      }
      var generatedPrefix = 'generated-assets:/';
      var generated = path.indexOf(generatedPrefix) === 0;
      var relativePath = generated ? path.slice(generatedPrefix.length) : path;
      var loader = generated ? NativeHost.assets : NativeHost.images;
      var load = generated ? loader.loadImage : loader.load;
      var loadAsync = generated ? loader.loadImageAsync : loader.loadAsync;
      var retainCpuPixels = PMJS.images.shouldRetainPixels(path);

      pendingNativeImageLoads++;
      new Promise(function(resolve) {
        resolve(typeof loadAsync === 'function'
          ? loadAsync.call(loader, relativePath, retainCpuPixels, preparedTileSet)
          : load.call(loader, relativePath, retainCpuPixels, preparedTileSet));
      }).then(function(result) {
        var loaded = trackNativeResource(result, 'image');
        if (generation !== image._loadGeneration) {
          releaseNativeResource(loaded, 'image');
          return;
        }
        releaseNativeResource(image._nativeImage, 'image');
        image._nativeImage = loaded;
        image.width = image.naturalWidth = image._nativeImage.width;
        image.height = image.naturalHeight = image._nativeImage.height;
        image.complete = true;
        image._pmjsLoadFailed = false;
        image._pmjsLoadError = null;
        image.dispatchEvent({ type: 'load', target: image });
        PMJS.images.loadCompleted(image);
      }, function(error) {
        if (generation !== image._loadGeneration) return;
        console.warn('[pmjs] image load failed, rendering fallback checkerboard: ' + path +
          (error ? ' (' + (error.message || error) + ')' : ''));
        releaseNativeResource(image._nativeImage, 'image');
        image._nativeImage = null;
        try {
          if (typeof NativeHost !== 'undefined' && NativeHost.images &&
              typeof NativeHost.images.fallbackImage === 'function') {
            image._nativeImage = trackNativeResource(NativeHost.images.fallbackImage(), 'image');
          }
        } catch (_) {}
        // Keep dimensions at 0: preserve genuine browser failure semantics so
        // RPG Maker sprite frame math (naturalWidth / columns) is not corrupted.
        image.width = image.naturalWidth = 0;
        image.height = image.naturalHeight = 0;
        image.complete = true;
        image._pmjsLoadFailed = true;
        image._pmjsLoadError = error;
        image.dispatchEvent({ type: 'error', target: image });
      }).then(function() { pendingNativeImageLoads--; },
        function(err) {
          pendingNativeImageLoads--;
          console.error(err && err.stack || err);
        });
    });
  }
});

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
