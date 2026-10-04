'use strict';

(function() {
  if (typeof Utils === 'undefined') return;
  if (PMJS.web && PMJS.web.usePhysicalViewport) PMJS.web.usePhysicalViewport();

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

  if (typeof StorageManager !== 'undefined') {
    StorageManager.isLocalMode = function() {
      return true;
    };
    StorageManager.fileDirectoryPath = function() {
      return '/save/';
    };
  }
})();
