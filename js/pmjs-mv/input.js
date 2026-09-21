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

var originalInputUpdate = Input.update;
var nativeInputActions = ['left', 'right', 'up', 'down', 'ok', 'escape',
  'shift', 'control', 'tab', 'pageup', 'pagedown', 'debug'];
// Keep native edge latches until this simulation step consumes them.
function pmjsPollNativeAction(action) {
  var held = NativeHost.input.down(action);
  var edge = false;
  try {
    if (NativeHost.input.pressed) edge = NativeHost.input.pressed(action);
  } catch (_) {}
  return held || edge;
}
Input.update = function() {
  for (var index = 0; index < nativeInputActions.length; index++) {
    var action = nativeInputActions[index];
    this._currentState[action] = pmjsPollNativeAction(action);
  }
  if (this.keyMapper) {
    for (var code in this.keyMapper) {
      var mapped = this.keyMapper[code];
      if (mapped && this._currentState[mapped] === undefined) {
        if (typeof nativeCompatibilityHit === 'function') {
          nativeCompatibilityHit('input.customAction', 'keyMapper:' + mapped);
        }
        this._currentState[mapped] = false;
      }
    }
  }
  if (this.gamepadMapper) {
    for (var button in this.gamepadMapper) {
      var buttonAction = this.gamepadMapper[button];
      if (buttonAction && this._currentState[buttonAction] === undefined) {
        if (typeof nativeCompatibilityHit === 'function') {
          nativeCompatibilityHit('input.customAction', 'gamepadMapper:' + buttonAction);
        }
        this._currentState[buttonAction] = false;
      }
    }
  }
  originalInputUpdate.call(this);
  try {
    if (NativeHost.input.consumePressed) NativeHost.input.consumePressed();
  } catch (_) {}
};

if (typeof WindowLayer !== 'undefined' &&
    WindowLayer.prototype && !WindowLayer.prototype._pmjsPatched) {
  var originalWindowLayerInitialize = WindowLayer.prototype.initialize;
  WindowLayer.prototype.initialize = function() {
    originalWindowLayerInitialize.call(this);
    // The native renderer uses scissor/mask directly and keeps voidFilter as the only
    // filter on the layer. Stock allocates a temp canvas/sprite; discard it.
    this._tempCanvas = null;
    this._renderSprite = null;
    if (typeof WindowLayer.voidFilter !== 'undefined') {
      this.filters = [WindowLayer.voidFilter];
    }
  };
  WindowLayer.prototype._pmjsPatched = true;
}

NativeHost.runtime.loadScript('js/rpg_managers.js');
NativeHost.runtime.loadScript('js/rpg_objects.js');
NativeHost.runtime.loadScript('js/rpg_scenes.js');
NativeHost.runtime.loadScript('js/rpg_sprites.js');
NativeHost.runtime.loadScript('js/rpg_windows.js');
