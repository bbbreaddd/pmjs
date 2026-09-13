// JavaScript cache eviction must also release the corresponding native image.
if (typeof Bitmap !== 'undefined' && Bitmap.prototype._clearImgInstance) {
  var originalClearImgInstance = Bitmap.prototype._clearImgInstance;
  Bitmap.prototype._clearImgInstance = function() {
    try {
      if (this._image && this._image instanceof NativeImage) {
        try { this._image.src = ''; } catch (_) {}
      }
    } catch (_) {}
    nativeCompatibilityHit('bitmap._clearImgInstance');
    return originalClearImgInstance.apply(this, arguments);
  };
}
if (typeof ImageCache !== 'undefined' && ImageCache.prototype._truncateCache) {
  var originalImageCacheTruncate = ImageCache.prototype._truncateCache;
  ImageCache.prototype._truncateCache = function() {
    // Keep recently touched entries within the limit and never evict held items.
    try {
      var items = this._items;
      var sizeLeft = ImageCache.limit;
      var sorted = Object.keys(items).map(function(k){ return items[k]; }).sort(function(a,b){ return b.touch - a.touch; });
      var self = this;
      sorted.forEach(function(item){
        if (sizeLeft > 0 || self._mustBeHeld(item)) {
          var bmp = item.bitmap;
          sizeLeft -= bmp.width * bmp.height * 4;
        } else {
          delete items[item.key];
          // Clearing the source starts the native release grace period.
          try { if (item.bitmap && item.bitmap._image instanceof NativeImage) item.bitmap._image.src = ''; } catch (_) {}
        }
      });
      return;
    } catch (e) {
      nativeCompatibilityHit('imageCache.truncateError', e && e.message || '');
    }
    return originalImageCacheTruncate.apply(this, arguments);
  };
}
// Window contents are canvas-backed and owned by their window. Release them
// with the scene instead of waiting for finalization; shared image-backed
// bitmaps are left untouched.
function pmjsReleaseWindowContentsBitmap(bitmap) {
  try {
    if (!bitmap || typeof NativeHost === 'undefined' || !NativeHost.canvas) return false;
    if (typeof NativeImage !== 'undefined' && bitmap._image instanceof NativeImage) return false;
    var element = bitmap._canvas;
    var nativeCanvas = element && element._nativeCanvas;
    if (!nativeCanvas || typeof nativeCanvas.handle !== 'number') return false;
    if (typeof releaseNativeResource === 'function') {
      releaseNativeResource(nativeCanvas, 'canvas');
    } else {
      NativeHost.canvas.release(nativeCanvas.handle);
    }
    try { element._nativeCanvas = null; } catch (_) {}
    return true;
  } catch (_) { return false; }
}
function pmjsReleaseSceneWindowBitmaps(root, seen, out) {
  var released = 0;
  try {
    if (!root || typeof Bitmap === 'undefined') return 0;
    seen = seen || [];
    if (seen.indexOf(root) >= 0) return 0;
    seen.push(root);
    if (root.contents instanceof Bitmap &&
        pmjsReleaseWindowContentsBitmap(root.contents)) {
      released++;
      if (out) {
        var owner = 'unknown';
        try { owner = (root.constructor && root.constructor.name) || 'unknown'; } catch (_) {}
        out.push({ w: root.contents.width, h: root.contents.height, owner: owner });
      }
    }
    // Sprite-owned canvas bitmaps are not walked because terminating and
    // incoming scenes can share them. Only window-exclusive contents are safe.
    var children = root.children;
    if (children && typeof children.length === 'number') {
      for (var i = 0; i < children.length; i++) {
        released += pmjsReleaseSceneWindowBitmaps(children[i], seen, out);
      }
    }
  } catch (_) {}
  return released;
}
if (typeof Scene_Base !== 'undefined' && Scene_Base.prototype &&
    !Scene_Base.prototype._pmjsTeardownPatched) {
  var originalSceneBaseTerminate = Scene_Base.prototype.terminate;
  Scene_Base.prototype.terminate = function() {
    // Original first: some scenes snapshot the stage on terminate and need
    // the windows' canvases alive for that.
    var result = originalSceneBaseTerminate.apply(this, arguments);
    try {
      var released = pmjsReleaseSceneWindowBitmaps(this, null, null);
      if (released > 0) {
        try {
          globalThis.__pmjsTeardownReleased =
            (globalThis.__pmjsTeardownReleased || 0) + released;
        } catch (_) {}
        nativeCompatibilityHit('scene.teardown', 'released=' + released);
      }
    } catch (_) {}
    return result;
  };
  Scene_Base.prototype._pmjsTeardownPatched = true;
}
if (typeof SceneManager !== 'function' || typeof DataManager !== 'function' ||
    typeof Game_Map !== 'function' || typeof Scene_Boot !== 'function' ||
    typeof Spriteset_Map !== 'function' || typeof Window_Base !== 'function') {
  throw new Error('RPG Maker launch units did not initialize');
}
nativeBootPhase('rpg-launch-units-loaded');
