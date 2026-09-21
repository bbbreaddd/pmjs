'use strict';

(function() {
  function loadStandardStylesheet() {
    if (typeof NativeHost === 'undefined' || !NativeHost.fs ||
        typeof NativeHost.fs.readText !== 'function') {
      return;
    }
    if (!globalThis.PMJS || !PMJS.fonts ||
        typeof PMJS.fonts.registerStylesheet !== 'function') {
      return;
    }

    try {
      var css = NativeHost.fs.readText('fonts/gamefont.css');
      if (css) {
        PMJS.fonts.registerStylesheet(css, 'fonts/gamefont.css');
      }
    } catch (_) {}
  }

  loadStandardStylesheet();

  if (typeof Graphics !== 'undefined') {
    Graphics.isFontLoaded = function(name) {
      if (globalThis.PMJS && PMJS.fonts &&
          typeof PMJS.fonts.isFamilyLoaded === 'function') {
        return PMJS.fonts.isFamilyLoaded(name);
      }
      return false;
    };
  }
})();
