'use strict';

// Graphics capability shims: native host always has a GL surface.
if (typeof Graphics !== 'undefined') {
  Graphics.isWebGL = function() { return true; };
  Graphics.hasWebGL = function() { return true; };
  Graphics.canUseSaturationBlend = function() { return true; };
  Graphics.canUseDifferenceBlend = function() { return true; };
  if (typeof Graphics._isVideoVisible !== 'function') {
    Graphics._isVideoVisible = function() { return false; };
  }
  if (typeof Graphics.printError !== 'function') {
    Graphics.printError = function(name, message) {
      console.error('[pmjs] Graphics.printError ' + name + ': ' + message);
    };
  }
}

function pmjsWindowLayerInitializeWrap() {
  return function(guestInitialize) {
    var wrapped = function() {
      var result = guestInitialize.apply(this, arguments);
      // The native renderer uses scissor/mask directly and keeps voidFilter as the only
      // filter on the layer. Stock allocates a temp canvas/sprite; discard it.
      this._tempCanvas = null;
      this._renderSprite = null;
      if (typeof WindowLayer.voidFilter !== 'undefined') {
        this.filters = [WindowLayer.voidFilter];
      }
      return result;
    };
    wrapped._pmjsWindowLayer = true;
    return wrapped;
  };
}

(function pmjsRegisterWindowLayerHook() {
  var methods = globalThis.PMJS && globalThis.PMJS.methods;
  if (!methods || typeof methods.wrap !== 'function') return;
  methods.wrap({
    key: 'WindowLayer.initialize',
    id: 'pmjs.mv.window-layer',
    getTarget: function() {
      return (typeof WindowLayer !== 'undefined' &&
        WindowLayer.prototype) || null;
    },
    method: 'initialize',
    wrap: pmjsWindowLayerInitializeWrap()
  });
})();

NativeHost.runtime.loadScript('js/rpg_managers.js');
NativeHost.runtime.loadScript('js/rpg_objects.js');
NativeHost.runtime.loadScript('js/rpg_scenes.js');
NativeHost.runtime.loadScript('js/rpg_sprites.js');
NativeHost.runtime.loadScript('js/rpg_windows.js');
