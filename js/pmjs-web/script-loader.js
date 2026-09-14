'use strict';

(function() {
  var currentScriptStack = [];

  function currentExecutingScript() {
    return currentScriptStack.length > 0
      ? currentScriptStack[currentScriptStack.length - 1]
      : null;
  }

  if (globalThis.document) {
    Object.defineProperty(globalThis.document, 'currentScript', {
      configurable: true,
      enumerable: true,
      get: currentExecutingScript
    });
  }

  function resolveScriptVirtualSrc(path) {
    var normalized = typeof normalizePath === 'function' ? normalizePath(path) : String(path).replace(/\\/g, '/');
    if (normalized.charAt(0) === '/') normalized = normalized.slice(1);
    if (normalized.indexOf('game/') === 0) normalized = normalized.slice(5);
    return 'file:///game/' + normalized;
  }

  if (typeof NativeHost !== 'undefined' && NativeHost.runtime &&
      typeof NativeHost.runtime.loadScript === 'function') {
    var rawLoadScript = NativeHost.runtime.loadScript;
    NativeHost.runtime.loadScript = function(path) {
      var script = {
        src: resolveScriptVirtualSrc(path)
      };
      currentScriptStack.push(script);
      try {
        return rawLoadScript.call(NativeHost.runtime, path);
      } finally {
        currentScriptStack.pop();
      }
    };
  }
})();
