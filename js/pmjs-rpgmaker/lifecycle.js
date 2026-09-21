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
    for (var index = 0; index < hooks.length; index++) {
      try {
        hooks[index].apply(null, args);
      } catch (error) {
        console.error('[pmjs] error running hook ' + name + ':', error);
      }
    }
  }

  globalThis.pmjsRegisterHook = registerHook;
  globalThis.pmjsRunHooks = runHooks;
})();
