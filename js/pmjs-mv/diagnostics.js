function inspectPluginCompatibility() {
  if (!PMJS.compat.audit) return;
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
      PMJS.compat.hit('compat.missingClass', className);
      return;
    }
    var prototype = constructor.prototype || constructor;
    expected[className].forEach(function(method) {
      if (typeof prototype[method] !== 'function' &&
          typeof constructor[method] !== 'function') {
        PMJS.compat.hit('compat.missingMethod', className + '.' + method);
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
        PMJS.compat.hit('compat.missingProperty', className + '.' + property);
      }
    });
  });
}
PMJS.phases.on('afterPlugins', 'pmjs-mv.diagnostics', inspectPluginCompatibility);
