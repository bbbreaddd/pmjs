function installPluginCompatibilityDiagnostics() {
  if (typeof PluginManager === 'undefined' || PluginManager._pmjsDiagInstalled) return;
  if (!nativeCompatibilityStrict && !nativeCompatibilityVerbose) return;
  PluginManager._pmjsDiagInstalled = true;
  var originalSetup = PluginManager.setup;
  if (typeof originalSetup !== 'function') return;
  PluginManager.setup = function(plugins) {
    var result = originalSetup.apply(this, arguments);
    var expected = {
      Bitmap: ['getPixel', 'getAlphaPixel', 'adjustTone', 'rotateHue', 'blur', 'snap'],
      Graphics: ['isWebGL', 'canUseSaturationBlend', 'isFontLoaded'],
      Input: ['update', 'isPressed', 'isTriggered', 'isRepeated', 'isLongPressed'],
      TouchInput: ['update', 'isPressed', 'isTriggered', 'isCancelled'],
      ImageCache: ['releaseItem', '_truncateCache'],
      Tilemap: ['_compareChildOrder', '_sortChildren', 'update'],
      Sprite_Character: ['update', 'updatePosition', 'updateBitmap', 'updateFrame'],
      Window_Base: ['update', 'convertEscapeCharacters', 'drawTextEx'],
      SceneManager: ['update', 'renderScene', 'isCurrentSceneStarted', 'isFocus']
    };
    var expectedProperties = { Bitmap: ['paintOpacity'] };
    Object.keys(expected).forEach(function(className) {
      var constructor = globalThis[className];
      if (!constructor) {
        nativeCompatibilityHit('compat.missingClass', className);
        return;
      }
      var prototype = constructor.prototype || constructor;
      expected[className].forEach(function(method) {
        if (typeof prototype[method] !== 'function' &&
            typeof constructor[method] !== 'function') {
          nativeCompatibilityHit('compat.missingMethod', className + '.' + method);
        }
      });
      (expectedProperties[className] || []).forEach(function(property) {
        var owner = prototype;
        var descriptor = null;
        while (owner && !descriptor) {
          descriptor = Object.getOwnPropertyDescriptor(owner, property);
          owner = Object.getPrototypeOf(owner);
        }
        if (!descriptor && !(property in prototype) && !(property in constructor)) {
          nativeCompatibilityHit('compat.missingProperty', className + '.' + property);
        }
      });
    });
    return result;
  };
}
installPluginCompatibilityDiagnostics();
