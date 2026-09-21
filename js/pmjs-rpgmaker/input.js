'use strict';

(function() {
  var nativeInputActions = ['left', 'right', 'up', 'down', 'ok', 'escape',
    'shift', 'control', 'tab', 'pageup', 'pagedown', 'debug'];

  function pollNativeAction(action) {
    var held = NativeHost.input.down(action);
    var edge = false;
    try {
      if (NativeHost.input.pressed) edge = NativeHost.input.pressed(action);
    } catch (_) {}
    return held || edge;
  }

  function exposeUnknownMappedActions(input) {
    if (input.keyMapper) {
      for (var code in input.keyMapper) {
        var mapped = input.keyMapper[code];
        if (mapped && input._currentState[mapped] === undefined) {
          if (typeof nativeCompatibilityHit === 'function') {
            nativeCompatibilityHit('input.customAction', 'keyMapper:' + mapped);
          }
          input._currentState[mapped] = false;
        }
      }
    }
    if (input.gamepadMapper) {
      for (var button in input.gamepadMapper) {
        var buttonAction = input.gamepadMapper[button];
        if (buttonAction && input._currentState[buttonAction] === undefined) {
          if (typeof nativeCompatibilityHit === 'function') {
            nativeCompatibilityHit('input.customAction',
              'gamepadMapper:' + buttonAction);
          }
          input._currentState[buttonAction] = false;
        }
      }
    }
  }

  function installInputBridge() {
    if (typeof Input === 'undefined' || typeof Input.update !== 'function') {
      return false;
    }
    if (Input._pmjsNativeBridgeInstalled) return true;

    var originalUpdate = Input.update;
    Input.update = function() {
      for (var index = 0; index < nativeInputActions.length; index++) {
        var action = nativeInputActions[index];
        this._currentState[action] = pollNativeAction(action);
      }
      exposeUnknownMappedActions(this);
      originalUpdate.call(this);
      try {
        if (NativeHost.input.consumePressed) NativeHost.input.consumePressed();
      } catch (_) {}
    };
    Input._pmjsNativeBridgeInstalled = true;
    return true;
  }

  globalThis.pmjsInstallRpgMakerInputBridge = installInputBridge;
  if (!installInputBridge()) {
    throw new Error('RPG Maker Input did not initialize');
  }
})();
