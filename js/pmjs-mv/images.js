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
PMJS.mv.imageCache = { maxIdleMs: 60000, checks: 0, expired: 0 };
if (typeof setInterval === 'function' && typeof ImageCache !== 'undefined') {
  setInterval(function() {
    var cache = typeof ImageManager !== 'undefined' && ImageManager._imageCache;
    if (!cache || !cache._items || typeof cache._mustBeHeld !== 'function') return;
    var policy = PMJS.mv.imageCache, now = Date.now();
    policy.checks++;
    Object.keys(cache._items).forEach(function(key) {
      var item = cache._items[key];
      var touched = Number(item && item.touch);
      if (!item || !Number.isFinite(touched) || now - touched <= policy.maxIdleMs || cache._mustBeHeld(item)) return;
      // Only release cache ownership. Scene and plugin references keep their Bitmap alive.
      delete cache._items[key];
      policy.expired++;
    });
  }, 1000);
}
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
      // Reviewed MV 1.6.1 decryptor; only its exact LF/CRLF forms qualify.
      var reviewed = `function(url, bitmap) {
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
}`;
      if (!methods.matchesSource(guestDecrypt, reviewed)) return guestDecrypt;
      var decrypter = globalThis.Decrypter;
      var cryptoMethods = {};
      function dataValue(target, name) {
        var property = Object.getOwnPropertyDescriptor(target, name);
        return property && property.value;
      }
      var cryptoSources = {"decryptArrayBuffer":["3e774a17ba324fbec404643033bf9c075811bdcd2266027dcf37cfe9f77d0c2e","e1d46dc20a7d1f9d300a42ad2efd82ca4bdd463ea0c24890c27fe3b6c127b6ce"],"cutArrayHeader":["515aeca6b56fce9e8357c508ae750007e2f5ede175668d90c812eb1c9410bc67","c01601872a02946c9e72f80773dee3c4c35b769e6e53b20298fce1e4f4aeebb1"],"readEncryptionkey":["dcf34c488f57d4eb1f571dc6794c8ff0304c9e76bacce83208b41244379fb215","5e2f149cbfbb0be175c26a5fd68b4b230870694f1be9ad9719373e9fdb344b1a"],"extToEncryptExt":["ae288edb3656708f7438438a52a0470892aac14ae88ba598c2b3831b72541673","f47e9efa8040298cdd3128d2cf22741d96bca96d38f8b0236f77e5a3b1ff2d62"],"createBlobUrl":["b7bde46429de4db97df024d08935177eda61bbbd9717a404df170b46c1f8df6a","9622d746217b05f094d6f82f56c06756d160d8fc41338f8ed181affc15a3ecf3"]};
      var supported = Object.keys(cryptoSources).every(function(name) {
        cryptoMethods[name] = dataValue(decrypter, name);
        return methods.matchesSource(cryptoMethods[name], cryptoSources[name]);
      });
      function nativeKey(target) {
        if (!supported || target !== decrypter || target !== globalThis.Decrypter || !globalThis.$dataSystem) return null;
        var header = ['SIGNATURE','VER','REMAIN'].map(function(name) { return dataValue(target, name); });
        if (dataValue(target, '_headerlength') !== 16 || dataValue(target, '_xhrOk') !== 400 ||
            !header.every(function(value) { return typeof value === 'string'; }) || header.join('') !== '5250474d560000000003010000000000' ||
            !Object.keys(cryptoMethods).every(function(name) { return dataValue(target, name) === cryptoMethods[name]; })) return null;
        var cached = Object.getOwnPropertyDescriptor(target, '_encryptionKey');
        if (cached && (!('value' in cached) || !cached.writable)) return null;
        var property = Object.getOwnPropertyDescriptor($dataSystem, 'encryptionKey');
        return property && typeof property.value === 'string' && /^[a-f0-9]{32}$/i.test(property.value) ? property.value : null;
      }
      return function(url, bitmap) {
        var path = decodeResourceUrlPath(url)
          .replace(/^file:\/\/\/game\//, '').replace(/^\.\//, '');
        var prepared = NativeHost.assets && typeof NativeHost.assets.hasDecrypted === 'function' &&
          NativeHost.assets.hasDecrypted(path);
        var key = !prepared && typeof url === 'string' && /\.png$/.test(url) && nativeKey(this);
        if (!prepared && (!key || !PMJS.images.loadEncrypted ||
            !(bitmap._image instanceof NativeImage) || typeof NativeHost.images.loadEncryptedAsync !== 'function'))
          return guestDecrypt.apply(this, arguments);
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
          if (bitmap._image !== image) return;
          if (key) {
            if (nativeKey(decrypter) !== key) return guestDecrypt.apply(decrypter, args);
            decrypter.readEncryptionkey();
          }
          return guestOnLoad.apply(bitmap, arguments);
        }
        function onError() {
          detach();
          if (bitmap._image === image) return guestDecrypt.apply(decrypter, args);
        }
        image.addEventListener('load', bitmap._loadListener = onLoad);
        image.addEventListener('error', bitmap._errorListener = onError);
        if (key) {
          if (!PMJS.images.loadEncrypted(image, decrypter.extToEncryptExt(url), key, path)) {
            detach();
            return guestDecrypt.apply(this, arguments);
          }
        }
        else image.src = url;
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
