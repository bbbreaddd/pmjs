'use strict';

globalThis.window = globalThis;
globalThis.self = globalThis;
globalThis.top = globalThis;
globalThis.parent = globalThis;
globalThis.focus = function() {};
var nativeWindowState = { focused: true, visible: true };
globalThis.__pmjsUpdateWindowState = function(state) {
  if (!state || typeof state !== 'object') return;
  var wasFocused = nativeWindowState.focused;
  var wasVisible = nativeWindowState.visible;
  nativeWindowState.focused = state.focused !== false;
  nativeWindowState.visible = state.visible !== false;
  if (wasFocused && !nativeWindowState.focused) {
    pendingKeyReleases.length = 0;
    pendingPadReleases.length = 0;
    for (var padIndex = 0; padIndex < nativeGamepads.length; padIndex++) {
      var pad = nativeGamepads[padIndex];
      if (!pad) continue;
      for (var buttonIndex = 0; buttonIndex < pad.buttons.length; buttonIndex++) pad.buttons[buttonIndex]._value = 0;
      pad.axes = [0, 0, 0, 0];
    }
  }
  if (wasFocused !== nativeWindowState.focused &&
      typeof globalThis.dispatchEvent === 'function') {
    globalThis.dispatchEvent({
      type: nativeWindowState.focused ? 'focus' : 'blur', target: globalThis
    });
  }
  if (wasVisible !== nativeWindowState.visible && globalThis.document &&
      typeof globalThis.document.dispatchEvent === 'function') {
    globalThis.document.dispatchEvent({ type: 'visibilitychange', target: document });
  }
};
var pmjsGameConfig = globalThis.PMJS_GAME_CONFIG || {};
var nativeLogicalWidth = (globalThis.__pmjsGameInfo && Number(globalThis.__pmjsGameInfo.width)) ||
  Number(NativeHost.runtime.env('PMJS_GAME_WIDTH') || 640);
var nativeLogicalHeight = (globalThis.__pmjsGameInfo && Number(globalThis.__pmjsGameInfo.height)) ||
  Number(NativeHost.runtime.env('PMJS_GAME_HEIGHT') || 480);
function normalizeLogicalDimension(value) {
  var number = Number(value);
  if (!Number.isFinite(number) || number < 1 || number > 16384) {
    throw new RangeError('logical viewport dimensions must be between 1 and 16384');
  }
  return Math.floor(number);
}
globalThis.__pmjsCommitLogicalSize = function(width, height) {
  nativeLogicalWidth = normalizeLogicalDimension(width);
  nativeLogicalHeight = normalizeLogicalDimension(height);
  if (globalThis.__pmjsGameInfo) {
    globalThis.__pmjsGameInfo.width = nativeLogicalWidth;
    globalThis.__pmjsGameInfo.height = nativeLogicalHeight;
  }
};
globalThis.__pmjsSetWindowTitle = function(value) {
  var title = String(value);
  if (globalThis.__pmjsGameInfo) globalThis.__pmjsGameInfo.title = title;
  if (typeof NativeHost.runtime.setWindowTitle === 'function') {
    NativeHost.runtime.setWindowTitle(title);
  }
};
var nativeDisplayWidth = (globalThis.__pmjsGameInfo && Number(globalThis.__pmjsGameInfo.displayWidth)) ||
  (typeof NativeHost !== 'undefined' && NativeHost.runtime &&
   typeof NativeHost.runtime.displaySize === 'function' &&
   Number(NativeHost.runtime.displaySize().width)) ||
  Number(NativeHost.runtime.env('PMJS_SCREEN_WIDTH') || 640);
var nativeDisplayHeight = (globalThis.__pmjsGameInfo && Number(globalThis.__pmjsGameInfo.displayHeight)) ||
  (typeof NativeHost !== 'undefined' && NativeHost.runtime &&
   typeof NativeHost.runtime.displaySize === 'function' &&
   Number(NativeHost.runtime.displaySize().height)) ||
  Number(NativeHost.runtime.env('PMJS_SCREEN_HEIGHT') || 480);
var nativeWindowSize = typeof NativeHost.runtime.windowSize === 'function'
  ? NativeHost.runtime.windowSize()
  : { width: nativeDisplayWidth, height: nativeDisplayHeight };
var nativeWindowWidth = Number(nativeWindowSize.width) || nativeDisplayWidth;
var nativeWindowHeight = Number(nativeWindowSize.height) || nativeDisplayHeight;
var nativePlatform = typeof NativeHost.runtime.platform === 'function'
  ? NativeHost.runtime.platform() : { platform: 'linux', arch: 'unknown' };
globalThis.screen = {
  get width() {
    return nativeDisplayWidth;
  },
  get height() {
    return nativeDisplayHeight;
  },
  get availWidth() {
    return nativeDisplayWidth;
  },
  get availHeight() {
    return nativeDisplayHeight;
  }
};
Object.defineProperty(globalThis, 'innerWidth', {
  configurable: true,
  enumerable: true,
  get: function() {
    return nativeLogicalWidth;
  }
});
Object.defineProperty(globalThis, 'innerHeight', {
  configurable: true,
  enumerable: true,
  get: function() {
    return nativeLogicalHeight;
  }
});
globalThis.moveBy = function() {};
globalThis.moveTo = function() {};
globalThis.resizeBy = function() {};
globalThis.scrollBy = function() {};
globalThis.scrollTo = function() {};

var legacyRegExpResult = null;
var legacyRegExpInput = '';
var originalRegExpExec = RegExp.prototype.exec;
var originalStringSplit = String.prototype.split;
if (NativeHost.runtime.env('PMJS_RUNTIME') !== 'node-v8-native-addon') {
  String.prototype.split = function(separator, limit) {
    if (limit === undefined && separator instanceof RegExp &&
        separator.source === '[\\r\\n]+' && separator.flags === '') {
      return NativeHost.runtime.splitLines(String(this));
    }
    return originalStringSplit.call(this, separator, limit);
  };
  RegExp.prototype.exec = function(input) {
    var result = originalRegExpExec.call(this, input);
    if (result) {
      legacyRegExpInput = String(input);
      legacyRegExpResult = result;
    }
    return result;
  };
  for (var captureIndex = 1; captureIndex < 10; captureIndex++) {
    (function(index) {
      Object.defineProperty(RegExp, '$' + index, {
        configurable: true,
        get: function() {
          var value = legacyRegExpResult && legacyRegExpResult[index];
          return value === undefined ? '' : value;
        }
      });
    })(captureIndex);
  }
  Object.defineProperty(RegExp, 'lastMatch', {
    configurable: true,
    get: function() { return legacyRegExpResult ? legacyRegExpResult[0] : ''; }
  });
  Object.defineProperty(RegExp, 'input', {
    configurable: true,
    get: function() { return legacyRegExpInput; }
  });
}
function GamepadButton() { this._value = 0; }
Object.defineProperties(GamepadButton.prototype, {
  pressed: { get: function() { return this._value > 0.5; } },
  touched: { get: function() { return this._value > 0; } },
  value: { get: function() { return this._value; } }
});
globalThis.GamepadButton = GamepadButton;
var nativeGamepads = [];
var pendingKeyReleases = [];
var pendingPadReleases = [];
function dispatchNativeKey(source) {
  if (!globalThis.document || typeof document.dispatchEvent !== 'function') return;
  var event = { type: source.down ? 'keydown' : 'keyup',
    keyCode: source.keyCode, which: source.keyCode,
    code: source.code || '', key: source.key || '', repeat: !!source.repeat,
    altKey: !!source.alt, ctrlKey: !!source.ctrl, shiftKey: !!source.shift,
    metaKey: !!source.meta,
    getModifierState: function(name) { return name === 'CapsLock' && !!source.capsLock; },
    preventDefault: function() { this.defaultPrevented = true; } };
  document.dispatchEvent(event);
}
globalThis.navigator = {
  userAgent: 'pmjs native runtime',
  platform: nativePlatform.platform === 'linux'
    ? 'Linux ' + (nativePlatform.arch === 'x64' ? 'x86_64' : nativePlatform.arch)
    : nativePlatform.platform + ' ' + nativePlatform.arch,
  language: 'en-US',
  isCocoonJS: false,
  plugins: { namedItem: function() { return null; } },
  getGamepads: function() { return nativeGamepads.slice(); }
};
globalThis.__pmjsReceiveInput = function(state) {
  if (!state) return;
  globalThis.__pmjsInputSnapshot = state;
  var pads = state.gamepads || [];
  for (var index = 0; index < nativeGamepads.length; index++) {
    var oldPad = nativeGamepads[index];
    if (oldPad && (!pads[index] || pads[index].connected === false ||
        pads[index].instance !== oldPad._instance)) {
      oldPad.connected = false;
      for (var cleared = 0; cleared < oldPad.buttons.length; cleared++) oldPad.buttons[cleared]._value = 0;
      oldPad.axes = [0, 0, 0, 0];
      if (globalThis.Input && typeof Input._updateGamepadState === 'function') {
        Input._updateGamepadState(oldPad);
      }
      nativeGamepads[index] = null;
    }
  }
  for (var i = 0; i < pads.length; i++) {
    var sourcePad = pads[i];
    if (!sourcePad || sourcePad.connected === false) {
      nativeGamepads[i] = null;
      continue;
    }
    var pad = nativeGamepads[i];
    if (!pad || pad._instance !== sourcePad.instance) {
      pad = { id: sourcePad.id, index: i, connected: true, mapping: 'standard',
        timestamp: 0, buttons: [], axes: [0, 0, 0, 0], _instance: sourcePad.instance };
      for (var button = 0; button < 17; button++) pad.buttons.push(new GamepadButton());
      nativeGamepads[i] = pad;
    }
    pad.timestamp = Date.now();
    pad.axes = (sourcePad.axes || [0, 0, 0, 0]).slice();
    for (var j = 0; j < 17; j++) {
      var held = sourcePad.buttonsDown.indexOf(j) >= 0;
      var edge = sourcePad.buttonsPressed.indexOf(j) >= 0;
      pad.buttons[j]._value = held || edge ? 1 : 0;
      if (edge && !held) pendingPadReleases.push({ pad: pad, button: j });
    }
  }
  nativeGamepads.length = pads.length;
  var events = state.keyEvents || [];
  var pressed = state.keysPressed || [];
  var heldKeys = state.keysDown || [];
  for (var k = 0; k < events.length; k++) {
    var source = events[k];
    if (!source.down && pressed.indexOf(source.keyCode) >= 0 &&
        heldKeys.indexOf(source.keyCode) < 0) pendingKeyReleases.push(source);
    else dispatchNativeKey(source);
  }
};
globalThis.__pmjsFinishInputStep = function() {
  for (var i = 0; i < pendingKeyReleases.length; i++) dispatchNativeKey(pendingKeyReleases[i]);
  pendingKeyReleases.length = 0;
  for (var j = 0; j < pendingPadReleases.length; j++) {
    var release = pendingPadReleases[j];
    release.pad.buttons[release.button]._value = 0;
  }
  pendingPadReleases.length = 0;
};
globalThis.nw = { App: { argv: [] } };
globalThis.location = {
  href: 'file:///game/index.html',
  origin: 'file://',
  protocol: 'file:',
  pathname: '/game/index.html',
  search: ''
};
globalThis.performance = {
  now: function() { return NativeHost.runtime.now(); }
};
var nativeBootStarted = performance.now();
function nativeBootPhase(name) {
  if (NativeHost.runtime.env('PMJS_BOOT_DIAGNOSTICS') === '1') {
    console.log('[pmjs-boot] phase=' + name + ' elapsed_ms=' +
      Math.round(performance.now() - nativeBootStarted));
  }
}
function encodeUtf8(text) {
  var value = String(text);
  var bytes = [];
  for (var index = 0; index < value.length; index++) {
    var codePoint = value.charCodeAt(index);
    if (codePoint >= 0xd800 && codePoint <= 0xdbff) {
      var low = index + 1 < value.length ? value.charCodeAt(index + 1) : 0;
      if (low >= 0xdc00 && low <= 0xdfff) {
        codePoint = 0x10000 + ((codePoint - 0xd800) << 10) + low - 0xdc00;
        index++;
      } else {
        codePoint = 0xfffd;
      }
    } else if (codePoint >= 0xdc00 && codePoint <= 0xdfff) {
      codePoint = 0xfffd;
    }
    if (codePoint <= 0x7f) bytes.push(codePoint);
    else if (codePoint <= 0x7ff) {
      bytes.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
    } else if (codePoint <= 0xffff) {
      bytes.push(0xe0 | (codePoint >> 12), 0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f));
    } else {
      bytes.push(0xf0 | (codePoint >> 18), 0x80 | ((codePoint >> 12) & 0x3f),
        0x80 | ((codePoint >> 6) & 0x3f), 0x80 | (codePoint & 0x3f));
    }
  }
  return new Uint8Array(bytes);
}
if (typeof globalThis.TextEncoder !== 'function') {
  globalThis.TextEncoder = function TextEncoder() {};
  globalThis.TextEncoder.prototype.encode = function(input) {
    return encodeUtf8(input === undefined ? '' : input);
  };
}
