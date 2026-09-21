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

  function installGraphicsFontHooks() {
    if (typeof Graphics === 'undefined') return;

    if (typeof Graphics.loadFont === 'function' &&
        !Graphics.loadFont._pmjsFontRegistryWrapper) {
      var originalLoadFont = Graphics.loadFont;
      var wrappedLoadFont = function(name, url) {
        if (globalThis.PMJS && PMJS.fonts &&
            typeof PMJS.fonts.registerFace === 'function') {
          PMJS.fonts.registerFace(name, url, { fromGame: true });
        }
        return originalLoadFont.apply(this, arguments);
      };
      wrappedLoadFont._pmjsFontRegistryWrapper = true;
      Graphics.loadFont = wrappedLoadFont;
    }

    if (typeof Graphics.isFontLoaded !== 'function' ||
        !Graphics.isFontLoaded._pmjsFontRegistryWrapper) {
      var originalIsFontLoaded = typeof Graphics.isFontLoaded === 'function'
        ? Graphics.isFontLoaded : null;
      var wrappedIsFontLoaded = function(name) {
        if (globalThis.PMJS && PMJS.fonts &&
            typeof PMJS.fonts.hasFamily === 'function' &&
            typeof PMJS.fonts.isFamilyLoaded === 'function') {
          if (PMJS.fonts.hasFamily(name)) return PMJS.fonts.isFamilyLoaded(name);
        }
        if (originalIsFontLoaded) {
          return originalIsFontLoaded.apply(this, arguments);
        }
        return false;
      };
      wrappedIsFontLoaded._pmjsFontRegistryWrapper = true;
      Graphics.isFontLoaded = wrappedIsFontLoaded;
    }
  }

  loadStandardStylesheet();
  installGraphicsFontHooks();
  if (typeof pmjsRegisterHook === 'function') {
    pmjsRegisterHook('afterPlugins', installGraphicsFontHooks);
  }
})();
