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
var nativeLogicalWidth = Number(NativeHost.runtime.env('PMJS_GAME_WIDTH') || 640);
var nativeLogicalHeight = Number(NativeHost.runtime.env('PMJS_GAME_HEIGHT') || 480);
var nativePlatform = typeof NativeHost.runtime.platform === 'function'
  ? NativeHost.runtime.platform() : { platform: 'linux', arch: 'unknown' };
globalThis.screen = { width: nativeLogicalWidth, height: nativeLogicalHeight };
globalThis.innerWidth = nativeLogicalWidth;
globalThis.innerHeight = nativeLogicalHeight;
globalThis.moveBy = function() {};
globalThis.moveTo = function() {};
globalThis.resizeBy = function() {};

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
globalThis.navigator = {
  userAgent: 'pmjs native runtime',
  platform: nativePlatform.platform === 'linux'
    ? 'Linux ' + (nativePlatform.arch === 'x64' ? 'x86_64' : nativePlatform.arch)
    : nativePlatform.platform + ' ' + nativePlatform.arch,
  language: 'en-US',
  isCocoonJS: false,
  plugins: { namedItem: function() { return null; } },
  getGamepads: function() { return []; }
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
