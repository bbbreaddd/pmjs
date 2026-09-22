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
      nativeCompatibilityHit('bitmap._clearImgInstance');
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
  var configuredImageCacheMaxPixels = Number(pmjsGameConfig.imageCacheMaxPixels || 0);
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
            nativeCompatibilityHit('imageCache.truncateError', e && e.message || '');
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
      nativeCompatibilityHit('imageCache.completionTrimError', error && error.message || '');
    }
  });
}
globalThis.__pmjsImageLoadCompleted = pmjsScheduleImageCacheTrim;

(function pmjsRegisterBitmapImageHooks() {
  var methods = globalThis.PMJS && globalThis.PMJS.methods;
  if (!methods || typeof methods.wrap !== 'function') return;
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

// MV removes an outgoing map spriteset without destroying its Pixi tree.
// Release host-owned retained geometry deterministically; JavaScript display
// objects and shared textures remain intact for the engine's normal teardown.
function pmjsReleaseNativeSceneResources(root, seen) {
  if (!root) return 0;
  seen = seen || [];
  if (seen.indexOf(root) >= 0) return 0;
  seen.push(root);
  var released = 0;
  if (root._pmjsNativeLayer) {
    NativeHost.render.releaseTileLayer(root._pmjsNativeLayer);
    root._pmjsNativeLayer = 0;
    released++;
  }
  if (root.__pmjsNativeMesh) {
    NativeHost.render.releaseMesh(root.__pmjsNativeMesh);
    root.__pmjsNativeMesh = 0;
    released++;
  }
  var children = root.children;
  if (children && typeof children.length === 'number') {
    for (var index = 0; index < children.length; index++) {
      released += pmjsReleaseNativeSceneResources(children[index], seen);
    }
  }
  return released;
}
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
      pmjsReleaseNativeSceneResources(this._spriteset);
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
