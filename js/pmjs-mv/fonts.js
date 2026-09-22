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

  function graphicsTarget() {
    return (typeof Graphics !== 'undefined') ? Graphics : null;
  }

  PMJS.methods.wrap({
    key: 'Graphics.loadFont',
    getTarget: graphicsTarget,
    method: 'loadFont',
    id: 'pmjs.mv.font-registry',
    wrap: function(originalLoadFont) {
      return function(name, url) {
        if (globalThis.PMJS && PMJS.fonts &&
            typeof PMJS.fonts.registerFace === 'function') {
          PMJS.fonts.registerFace(name, url, { fromGame: true });
        }
        return originalLoadFont.apply(this, arguments);
      };
    }
  });

  PMJS.methods.wrap({
    key: 'Graphics.isFontLoaded',
    getTarget: graphicsTarget,
    method: 'isFontLoaded',
    id: 'pmjs.mv.font-query',
    wrap: function(originalIsFontLoaded) {
      return function(name) {
        if (globalThis.PMJS && PMJS.fonts &&
            typeof PMJS.fonts.hasFamily === 'function' &&
            typeof PMJS.fonts.isFamilyLoaded === 'function') {
          if (PMJS.fonts.hasFamily(name)) return PMJS.fonts.isFamilyLoaded(name);
        }
        return originalIsFontLoaded.apply(this, arguments);
      };
    }
  });

  loadStandardStylesheet();
})();
