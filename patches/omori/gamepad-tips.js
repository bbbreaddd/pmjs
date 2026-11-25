'use strict';

(function() {
  var manualPreference = null;
  var hasSavedPreference = false;

  function firstConnected(pads, preferredIndex) {
    if (!pads) return null;
    if (preferredIndex !== undefined && preferredIndex !== null &&
        pads[preferredIndex] && pads[preferredIndex].connected !== false) {
      return pads[preferredIndex];
    }
    for (var index = 0; index < pads.length; index++) {
      if (pads[index] && pads[index].connected !== false) return pads[index];
    }
    return null;
  }

  function activeGamepad(preferredIndex) {
    var pads = globalThis.navigator && typeof navigator.getGamepads === 'function'
      ? navigator.getGamepads() : null;
    var connected = firstConnected(pads, preferredIndex);
    if (connected) return connected;
    var snapshot = globalThis.__pmjsInputSnapshot && globalThis.__pmjsInputSnapshot.gamepads;
    return firstConnected(snapshot, preferredIndex);
  }

  function hasActivePadInput(gamepad) {
    var buttons = gamepad && gamepad.buttons;
    if (buttons) {
      for (var button = 0; button < buttons.length; button++) {
        if (buttons[button] && buttons[button].pressed) return true;
      }
    }
    var axes = gamepad && gamepad.axes;
    if (axes) {
      for (var axis = 0; axis < axes.length; axis++) {
        if (Math.abs(axes[axis]) > 0.5) return true;
      }
    }
    return false;
  }

  function setGamepadTips(enabled) {
    if (typeof ConfigManager === 'undefined') return;
    var next = !!enabled;
    if (ConfigManager.gamepadTips === next) return;
    ConfigManager.gamepadTips = next;
    var scene = globalThis.SceneManager && SceneManager._scene;
    if (scene && typeof scene.refreshCommandHints === 'function' && scene._commandHints) {
      scene.refreshCommandHints();
    }
  }

  function applyDefaultGamepadTips() {
    if (hasSavedPreference || manualPreference !== null) return;
    var pad = activeGamepad(globalThis.Input && Input._lastGamepad);
    if (pad) {
      if (globalThis.Input && Input._lastGamepad === undefined && pad.index !== undefined) {
        Input._lastGamepad = pad.index;
      }
      setGamepadTips(true);
    }
  }

  PMJS.plugins.onLoaded('Omori BASE', 'port.omori.gamepad-tips', function() {
    if (typeof ConfigManager !== 'undefined') {
      if (typeof ConfigManager.applyData === 'function') {
        var apply = ConfigManager.applyData;
        ConfigManager.applyData = function(config) {
          hasSavedPreference = !!(config && config.gamepadTips !== undefined);
          var result = apply.apply(this, arguments);
          applyDefaultGamepadTips();
          return result;
        };
      }
      if (typeof ConfigManager.restoreDefaultConfig === 'function') {
        var restore = ConfigManager.restoreDefaultConfig;
        ConfigManager.restoreDefaultConfig = function() {
          manualPreference = null;
          hasSavedPreference = false;
          var result = restore.apply(this, arguments);
          applyDefaultGamepadTips();
          return result;
        };
      }
    }

    if (typeof Bitmap !== 'undefined' && Bitmap.prototype &&
        typeof Bitmap.prototype.determineVendorRect === 'function') {
      var determineVendorRect = Bitmap.prototype.determineVendorRect;
      Bitmap.prototype.determineVendorRect = function() {
        var realPads = globalThis.navigator && typeof navigator.getGamepads === 'function'
          ? navigator.getGamepads() : null;
        var exposed = firstConnected(realPads, globalThis.Input && Input._lastGamepad);
        if (exposed) {
          if (globalThis.Input &&
              (Input._lastGamepad === undefined || Input._lastGamepad === null)) {
            Input._lastGamepad = exposed.index;
          }
          return determineVendorRect.apply(this, arguments);
        }
        var snapshotPad = activeGamepad(globalThis.Input && Input._lastGamepad);
        if (!snapshotPad || !globalThis.navigator || typeof navigator.getGamepads !== 'function') {
          return determineVendorRect.apply(this, arguments);
        }
        var synthetic = {
          id: snapshotPad.id || '',
          index: snapshotPad.index || 0,
          connected: true,
          mapping: snapshotPad.mapping || 'standard'
        };
        var fakePads = [];
        fakePads[synthetic.index] = synthetic;
        if (globalThis.Input) Input._lastGamepad = synthetic.index;
        var originalGetGamepads = navigator.getGamepads;
        navigator.getGamepads = function() { return fakePads; };
        try {
          return determineVendorRect.apply(this, arguments);
        } finally {
          navigator.getGamepads = originalGetGamepads;
        }
      };
    }
  });

  PMJS.phases.on('afterGuestPlugins', 'port.omori.gamepad-tips', function() {
    if (typeof Scene_OmoriTitleScreen !== 'undefined' && Scene_OmoriTitleScreen.prototype &&
        typeof Scene_OmoriTitleScreen.prototype.createCommandHints === 'function') {
      var createCommandHints = Scene_OmoriTitleScreen.prototype.createCommandHints;
      Scene_OmoriTitleScreen.prototype.createCommandHints = function() {
        applyDefaultGamepadTips();
        return createCommandHints.apply(this, arguments);
      };
    }

    if (typeof Window_OmoMenuOptionsGeneral !== 'undefined' && Window_OmoMenuOptionsGeneral.prototype &&
        typeof Window_OmoMenuOptionsGeneral.prototype.processOptionCommand === 'function') {
      var processOptionCommand = Window_OmoMenuOptionsGeneral.prototype.processOptionCommand;
      Window_OmoMenuOptionsGeneral.prototype.processOptionCommand = function() {
        var result = processOptionCommand.apply(this, arguments);
        if (typeof this.index === 'function' && this.index() === 2 &&
            typeof ConfigManager !== 'undefined') {
          manualPreference = !!ConfigManager.gamepadTips;
          hasSavedPreference = true;
        }
        return result;
      };
    }

    if (typeof Input !== 'undefined') {
      if (typeof Input._updateGamepadState === 'function') {
        var updateGamepadState = Input._updateGamepadState;
        Input._updateGamepadState = function(gamepad) {
          var result = updateGamepadState.apply(this, arguments);
          if (hasActivePadInput(gamepad)) {
            if (gamepad && gamepad.index !== undefined) Input._lastGamepad = gamepad.index;
            if (manualPreference !== false) setGamepadTips(true);
          }
          return result;
        };
      }
      if (typeof Input._onKeyDown === 'function') {
        var onKeyDown = Input._onKeyDown;
        Input._onKeyDown = function(event) {
          var result = onKeyDown.apply(this, arguments);
          if (event && Input.keyMapper && Input.keyMapper[event.keyCode] &&
              manualPreference !== true) {
            setGamepadTips(false);
          }
          return result;
        };
      }
    }

    if (typeof globalThis.addEventListener === 'function') {
      globalThis.addEventListener('gamepadconnected', function(event) {
        if (event && event.gamepad && event.gamepad.index !== undefined &&
            typeof Input !== 'undefined') {
          Input._lastGamepad = event.gamepad.index;
        }
        if (manualPreference !== false) setGamepadTips(true);
      });
      globalThis.addEventListener('gamepaddisconnected', function() {
        if (manualPreference === null &&
            !activeGamepad(typeof Input !== 'undefined' ? Input._lastGamepad : undefined)) {
          setGamepadTips(false);
        }
      });
    }
  });
})();
