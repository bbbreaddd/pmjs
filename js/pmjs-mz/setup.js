'use strict';

(function() {
  var registry = Object.create(null);

  function registerHook(name, callback) {
    if (typeof callback !== 'function') return;
    registry[name] = registry[name] || [];
    registry[name].push(callback);
  }

  function runHooks(name) {
    var args = Array.prototype.slice.call(arguments, 1);
    var hooks = registry[name] || [];
    for (var i = 0; i < hooks.length; i++) {
      try {
        hooks[i].apply(null, args);
      } catch (error) {
        console.error('[pmjs] error running hook ' + name + ':', error);
      }
    }
  }

  globalThis.pmjsRegisterHook = registerHook;
  globalThis.pmjsRunHooks = runHooks;
})();
