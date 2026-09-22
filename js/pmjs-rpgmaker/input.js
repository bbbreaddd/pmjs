'use strict';

(function() {
  function installInputBridge() {
    if (typeof Input === 'undefined' || typeof Input.update !== 'function') return false;
    if (Input.update._pmjsNativeBridge) return true;
    var originalUpdate = Input.update;
    var previousKeys = null;
    var previousButtons = null;
    function copyMapper(mapper) {
      var copy = {};
      for (var code in mapper) copy[code] = mapper[code];
      return copy;
    }
    function actionHeld(input, action, keys) {
      if (keys.some(function(key) { return input.keyMapper[key] === action; })) return true;
      return (input._gamepadStates || []).some(function(buttons) {
        return buttons && buttons.some(function(pressed, button) {
          return pressed && input.gamepadMapper[button] === action;
        });
      });
    }
    function nativeInputUpdate() {
      if (globalThis.__pmjsInputSnapshot && this.keyMapper && this.gamepadMapper) {
        var keys = (globalThis.__pmjsInputSnapshot.keysDown || []).concat(
          globalThis.__pmjsInputSnapshot.keysPressed || []);
        if (previousKeys) {
          var keyCodes = Object.assign({}, previousKeys, this.keyMapper);
          var affected = Object.create(null);
          for (var code in keyCodes) {
            if (previousKeys[code] === this.keyMapper[code]) continue;
            if (previousKeys[code]) affected[previousKeys[code]] = true;
            if (this.keyMapper[code]) affected[this.keyMapper[code]] = true;
          }
          for (var action in affected) {
            this._currentState[action] = actionHeld(this, action, keys);
          }
        }
        if (previousButtons) {
          var changed = false;
          var buttonCodes = Object.assign({}, previousButtons, this.gamepadMapper);
          var affectedButtons = Object.create(null);
          for (var button in buttonCodes) {
            if (previousButtons[button] === this.gamepadMapper[button]) continue;
            changed = true;
            if (previousButtons[button]) affectedButtons[previousButtons[button]] = true;
            if (this.gamepadMapper[button]) affectedButtons[this.gamepadMapper[button]] = true;
          }
          for (var buttonAction in affectedButtons) {
            this._currentState[buttonAction] = actionHeld(this, buttonAction, keys);
          }
          if (changed) this._gamepadStates = [];
        }
        previousKeys = copyMapper(this.keyMapper);
        previousButtons = copyMapper(this.gamepadMapper);
      }
      try { return originalUpdate.apply(this, arguments); }
      finally {
        if (typeof globalThis.__pmjsFinishInputStep === 'function') {
          globalThis.__pmjsFinishInputStep();
        }
        if (NativeHost.input.consumePressed) NativeHost.input.consumePressed();
      }
    }
    nativeInputUpdate._pmjsNativeBridge = true;
    Input.update = nativeInputUpdate;
    Input._pmjsNativeBridgeInstalled = true;
    return true;
  }

  PMJS.phases.on('afterGuestPlugins', 'pmjs-rpgmaker.input', function() {
    if (!installInputBridge()) throw new Error('RPG Maker Input did not initialize');
  });
})();
