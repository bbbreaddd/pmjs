// Graphics capability shims: native host always has a GL surface.
if (typeof Graphics !== 'undefined') {
  Graphics.isWebGL = function() { return true; };
  Graphics.hasWebGL = function() { return true; };
  Graphics.canUseSaturationBlend = function() { return true; };
  Graphics.canUseDifferenceBlend = function() { return true; };
  if (typeof Graphics._isVideoVisible !== 'function') {
    Graphics._isVideoVisible = function() { return false; };
  }
  // Stock loading spinner is DOM-specific; native readiness is gated via
  // image cache. Keep it as a no-op so Scene_Boot does not stall.
  if (typeof Graphics.isFontLoaded === 'function') {
    var originalIsFontLoaded = Graphics.isFontLoaded;
    Graphics.isFontLoaded = function(name) {
      if (name) return true;
      try { return originalIsFontLoaded.call(this, name); } catch (_) { return true; }
    };
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
Input.update = function() {
  for (var index = 0; index < nativeInputActions.length; index++) {
    var action = nativeInputActions[index];
    this._currentState[action] = NativeHost.input.down(action);
  }
  // Poll any plugin-registered keyMapper actions so custom bindings are not
  // silently dropped by the fixed action list.
  if (this.keyMapper) {
    for (var code in this.keyMapper) {
      var mapped = this.keyMapper[code];
      if (mapped && this._currentState[mapped] === undefined) {
        this._currentState[mapped] = NativeHost.input.down(mapped);
      }
    }
  }
  if (this.gamepadMapper) {
    for (var button in this.gamepadMapper) {
      var buttonAction = this.gamepadMapper[button];
      if (buttonAction && this._currentState[buttonAction] === undefined) {
        this._currentState[buttonAction] = NativeHost.input.down(buttonAction);
      }
    }
  }
  originalInputUpdate.call(this);
};

// Touch host bridge: synthesize TouchInput state from the same logical input
// surface so menus and message windows remain touch-capable without DOM.
if (typeof TouchInput !== 'undefined' && typeof TouchInput.update === 'function') {
  var originalTouchUpdate = TouchInput.update;
  var touchInjected = false;
  // Native host does not yet expose absolute touch coordinates; keep pressure
  // state in sync with the generic 'ok' action so press/click still triggers
  // TouchInput._onTrigger/_onRelease paths for plugins that poll isPressed.
  TouchInput.update = function() {
    var pressed = false;
    try { pressed = NativeHost.input.down('ok'); } catch (_) {}
    if (pressed && !touchInjected) {
      if (!this._screenPressed) {
        this._screenPressed = true;
        this._pressedTime = 0;
        if (typeof this._onTrigger === 'function') this._onTrigger(0, 0);
      }
      touchInjected = true;
    } else if (!pressed && touchInjected) {
      if (this._screenPressed) {
        this._screenPressed = false;
        if (typeof this._onRelease === 'function') this._onRelease(0, 0);
      }
      touchInjected = false;
    }
    return originalTouchUpdate.call(this);
  };
}

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
