function pmjsBitmapRequestImageWrap() {  return function(guestRequestImage) {
    var wrapped = function() {
      var previousImage = this._image;
      var result = guestRequestImage.apply(this, arguments);
      if (typeof NativeImage !== 'undefined' && previousImage &&
          previousImage !== this._image &&
          previousImage instanceof NativeImage) {
        try { previousImage.src = ''; } catch (_) {}
      }
      return result;
    };
    wrapped._pmjsNativeImageRelease = true;
    return wrapped;
  };
}

function pmjsBitmapClearImgInstanceWrap() {
  return function(guestClearImgInstance) {
    var wrapped = function() {
      try {
        if (this._image && this._image instanceof NativeImage) {
          try { this._image.src = ''; } catch (_) {}
        }
      } catch (_) {}
      return guestClearImgInstance.apply(this, arguments);
    };
    wrapped._pmjsNativeImageRelease = true;
    return wrapped;
  };
}

if (typeof ImageCache !== 'undefined') {
  var gameRequestedImageCachePixels = Number(ImageCache.limit);
  if (!Number.isFinite(gameRequestedImageCachePixels) ||
      gameRequestedImageCachePixels < 0) gameRequestedImageCachePixels = 0;
  var configuredImageCacheMaxPixels = Number(PMJS.config.imageCacheMaxPixels || 0);
  try {
    var environmentImageCacheMaxPixels = Number(
      NativeHost.runtime.env('PMJS_IMAGE_CACHE_MAX_PIXELS') || 0);
    if (Number.isSafeInteger(environmentImageCacheMaxPixels) &&
        environmentImageCacheMaxPixels > 0) {
      configuredImageCacheMaxPixels = environmentImageCacheMaxPixels;
    }
  } catch (_) {}
  if (!Number.isSafeInteger(configuredImageCacheMaxPixels) ||
      configuredImageCacheMaxPixels <= 0) configuredImageCacheMaxPixels = 0;
  var effectiveImageCachePixels = function() {
    if (!configuredImageCacheMaxPixels) return gameRequestedImageCachePixels;
    return Math.min(gameRequestedImageCachePixels, configuredImageCacheMaxPixels);
  };
  Object.defineProperty(ImageCache, 'limit', {
    configurable: true,
    enumerable: true,
    get: effectiveImageCachePixels,
    set: function(value) {
      value = Number(value);
      if (Number.isFinite(value) && value >= 0) gameRequestedImageCachePixels = value;
    }
  });
}

if (typeof ImageCache !== 'undefined' && ImageCache.prototype._truncateCache) {
  var pmjsImageCacheTruncateMethods = globalThis.PMJS && globalThis.PMJS.methods;
  if (pmjsImageCacheTruncateMethods &&
      typeof pmjsImageCacheTruncateMethods.own === 'function') {
    pmjsImageCacheTruncateMethods.own({
      key: 'ImageCache._truncateCache',
      id: 'pmjs.mv.image-cache-budget',
      getTarget: function() { return ImageCache.prototype || null; },
      method: '_truncateCache',
      replace: function(guestTruncate) {
        var wrapped = function() {
          try {
            var items = this._items;
            var sizeLeft = ImageCache.limit;
            var sorted = Object.keys(items).map(function(k){ return items[k]; }).sort(function(a,b){ return b.touch - a.touch; });
            var self = this;
            sorted.forEach(function(item){
              if (sizeLeft > 0 || self._mustBeHeld(item)) {
                var bmp = item.bitmap;
                sizeLeft -= bmp.width * bmp.height;
              } else {
                delete items[item.key];
              }
            });
            return;
          } catch (e) {
            PMJS.compat.hit('imageCache.truncateError', e && e.message || '');
          }
          return guestTruncate.apply(this, arguments);
        };
        wrapped._pmjsImageCacheBudget = true;
        return wrapped;
      }
    });
  }
}

// Pending images must be held by MV's ImageCache. Once a Bitmap becomes ready,
// coalesce cache reconsideration so a burst of async decodes causes one scan.
var pmjsImageCacheTrimPending = false;
function pmjsScheduleImageCacheTrim() {
  if (pmjsImageCacheTrimPending) return;
  pmjsImageCacheTrimPending = true;
  Promise.resolve().then(function() {
    pmjsImageCacheTrimPending = false;
    try {
      if (typeof ImageManager !== 'undefined' && ImageManager._imageCache &&
          typeof ImageManager._imageCache._truncateCache === 'function') {
        ImageManager._imageCache._truncateCache();
      }
    } catch (error) {
      PMJS.compat.hit('imageCache.completionTrimError', error && error.message || '');
    }
  });
}
PMJS.images.onLoadComplete(pmjsScheduleImageCacheTrim);

PMJS.mv = PMJS.mv || {};
PMJS.mv.bitmap = PMJS.mv.bitmap || {};
// Preserve the stock request and native ownership for file-backed plugin adapters.
PMJS.mv.bitmap.requestImageFile = pmjsBitmapRequestImageWrap()(Bitmap.prototype._requestImage);

(function pmjsRegisterBitmapImageHooks() {
  var methods = globalThis.PMJS && globalThis.PMJS.methods;
  if (!methods || typeof methods.wrap !== 'function') return;
  methods.wrap({
    key: 'Decrypter.decryptImg',
    id: 'pmjs.mv.prepared-decryption',
    getTarget: function() { return typeof Decrypter !== 'undefined' && Decrypter || null; },
    method: 'decryptImg',
    wrap: function(guestDecrypt) {
      var reviewedDecrypt = function(url, bitmap) {
          url = this.extToEncryptExt(url);

          var requestFile = new XMLHttpRequest();
          requestFile.open("GET", url);
          requestFile.responseType = "arraybuffer";
          requestFile.send();

          requestFile.onload = function () {
              if(this.status < Decrypter._xhrOk) {
                  var arrayBuffer = Decrypter.decryptArrayBuffer(requestFile.response);
                  bitmap._image.src = Decrypter.createBlobUrl(arrayBuffer);
                  bitmap._image.addEventListener('load', bitmap._loadListener = Bitmap.prototype._onLoad.bind(bitmap));
                  bitmap._image.addEventListener('error', bitmap._errorListener = bitmap._loader || Bitmap.prototype._onError.bind(bitmap));
              }
          };

          requestFile.onerror = function () {
              if (bitmap._loader) {
                  bitmap._loader();
              } else {
                  bitmap._onError();
              }
          };
      };
      function reviewedSource(fn) {
        return Function.prototype.toString.call(fn).replace(/\r\n/g, "\n")
          .split("\n").map(function(line) { return line.trim(); }).join("\n");
      }
      if (reviewedSource(guestDecrypt) !== reviewedSource(reviewedDecrypt)) return guestDecrypt;
      return function(url, bitmap) {
        var encodedPath = url.split('?')[0].replace(/%(?![0-9a-f]{2})/gi, '%25');
        var path = decodeURIComponent(encodedPath)
          .replace(/^file:\/\/\/game\//, '').replace(/^\.\//, '');
        if (!NativeHost.assets || typeof NativeHost.assets.hasDecrypted !== 'function' ||
            !NativeHost.assets.hasDecrypted(path)) return guestDecrypt.apply(this, arguments);
        var decrypter = this;
        var args = arguments;
        var image = bitmap._image;
        var guestOnLoad = Bitmap.prototype._onLoad;
        function detach() {
          image.removeEventListener('load', onLoad);
          image.removeEventListener('error', onError);
        }
        function onLoad() {
          detach();
          if (bitmap._image === image) return guestOnLoad.apply(bitmap, arguments);
        }
        function onError() {
          detach();
          if (bitmap._image === image) return guestDecrypt.apply(decrypter, args);
        }
        image.addEventListener('load', bitmap._loadListener = onLoad);
        image.addEventListener('error', bitmap._errorListener = onError);
        image.src = url;
      };
    }
  });
  methods.wrap({
    key: 'Bitmap._requestImage',
    id: 'pmjs.mv.native-image-release',
    getTarget: function() {
      return (typeof Bitmap !== 'undefined' && Bitmap.prototype) || null;
    },
    method: '_requestImage',
    wrap: pmjsBitmapRequestImageWrap()
  });
  methods.wrap({
    key: 'Bitmap._clearImgInstance',
    id: 'pmjs.mv.native-image-release',
    getTarget: function() {
      return (typeof Bitmap !== 'undefined' && Bitmap.prototype) || null;
    },
    method: '_clearImgInstance',
    wrap: pmjsBitmapClearImgInstanceWrap()
  });
  methods.wrap({
    key: 'Bitmap._onLoad',
    id: 'pmjs.mv.image-cache-trim',
    getTarget: function() {
      return (typeof Bitmap !== 'undefined' && Bitmap.prototype) || null;
    },
    method: '_onLoad',
    wrap: function(guestOnLoad) {
      var wrapped = function() {
        var result = guestOnLoad.apply(this, arguments);
        pmjsScheduleImageCacheTrim();
        return result;
      };
      wrapped._pmjsImageCacheTrim = true;
      return wrapped;
    }
  });
})();

PMJS.methods.wrap({
  key: 'Scene_Map.terminate',
  id: 'pmjs.mv.native-scene-resources',
  getTarget: function() {
    return typeof Scene_Map !== 'undefined' && Scene_Map.prototype || null;
  },
  method: 'terminate',
  wrap: function(guestTerminate) {
    return function() {
      var result = guestTerminate.apply(this, arguments);
      PMJS.pixi4.releaseSceneResources(this._spriteset);
      return result;
    };
  }
});
if (typeof SceneManager !== 'function' || typeof DataManager !== 'function' ||
    typeof Game_Map !== 'function' || typeof Scene_Boot !== 'function' ||
    typeof Spriteset_Map !== 'function' || typeof Window_Base !== 'function') {
  throw new Error('RPG Maker launch units did not initialize');
}
nativeBootPhase('rpg-launch-units-loaded');
