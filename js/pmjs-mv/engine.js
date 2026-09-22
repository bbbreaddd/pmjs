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

NativeHost.runtime.loadScript('js/rpg_managers.js');
NativeHost.runtime.loadScript('js/rpg_objects.js');
NativeHost.runtime.loadScript('js/rpg_scenes.js');
NativeHost.runtime.loadScript('js/rpg_sprites.js');
NativeHost.runtime.loadScript('js/rpg_windows.js');
