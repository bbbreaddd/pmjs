'use strict';

(function() {
  if (typeof Utils === 'undefined') return;

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
})();
