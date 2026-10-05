'use strict';

(function() {
  if (typeof Utils === 'undefined') return;
  if (PMJS.web && PMJS.web.usePhysicalViewport) PMJS.web.usePhysicalViewport();
  // Native windows need the desktop fitting default without claiming the NW environment.
  if (typeof Graphics !== 'undefined') {
    Graphics._defaultStretchMode = function() { return true; };
  }

  Utils.canUseWebGL = function() {
    return !!(NativeHost.render && NativeHost.scene);
  };
  Utils.canUseWebAudioAPI = function() {
    return !!NativeHost.media;
  };
  Utils.canUseCssFontLoading = function() {
    return !!(globalThis.PMJS && PMJS.fonts);
  };
  Utils.canUseIndexedDB = function() {
    return !!NativeHost.storage;
  };
  Utils.canPlayOgg = function() {
    return !!NativeHost.media;
  };
  Utils.canPlayWebm = function() {
    return !!NativeHost.media;
  };

  if (PMJS.methods && typeof Bitmap !== 'undefined') {
    PMJS.methods.wrap({
      key: 'Bitmap._startDecrypting',
      id: 'pmjs.mz.prepared-decryption',
      getTarget: function() { return Bitmap.prototype; },
      method: '_startDecrypting',
      wrap: function(guestDecrypt) {
        return function() {
          var path = decodeURIComponent(this._url.split('?')[0])
            .replace(/^file:\/\/\/game\//, '').replace(/^\.\//, '');
          if (!NativeHost.assets || typeof NativeHost.assets.hasDecrypted !== 'function' ||
              !NativeHost.assets.hasDecrypted(path)) return guestDecrypt.apply(this, arguments);
          var bitmap = this;
          var image = this._image;
          var onError = image.onerror;
          var onLoad = image.onload;
          function restore() { image.onerror = onError; image.onload = onLoad; }
          image.onload = function() {
            restore();
            if (bitmap._image === image && onLoad) return onLoad.apply(this, arguments);
          };
          image.onerror = function() {
            restore();
            if (bitmap._image !== image) return;
            guestDecrypt.call(bitmap);
          };
          image.src = this._url;
        };
      }
    });
  }

  if (typeof StorageManager !== 'undefined') {
    StorageManager.isLocalMode = function() {
      return true;
    };
    StorageManager.fileDirectoryPath = function() {
      return '/save/';
    };
  }
})();
