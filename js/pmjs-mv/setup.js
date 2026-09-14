function warmIntl(config) {
  if (!config) return;
  if (config.numberEn) (1234567).toLocaleString('en');
  if (config.dateEn) new Date(0).toLocaleDateString('en');
  if (config.collatorEn) 'b'.localeCompare('a', 'en');
}

warmIntl((globalThis.PMJS_GAME_CONFIG || {}).intlWarmup);

var pmjsHookRegistry = {};

function pmjsRegisterHook(name, callback) {
  if (typeof callback !== 'function') return;
  pmjsHookRegistry[name] = pmjsHookRegistry[name] || [];
  pmjsHookRegistry[name].push(callback);
}

// Canonical lifecycle events: beforePlugins, pluginLoaded(name),
// afterPlugins, beforeBoot. Extra args forward to subscribers; failures
// log and continue.
function pmjsRunHooks(name) {
  var args = Array.prototype.slice.call(arguments, 1);
  var list = pmjsHookRegistry[name];
  if (!list) return;
  for (var i = 0; i < list.length; i++) {
    try {
      list[i].apply(null, args);
    } catch (err) {
      console.error('[pmjs] error running hook ' + name + ':', err);
    }
  }
}

globalThis.pmjsRegisterHook = pmjsRegisterHook;
globalThis.pmjsRunHooks = pmjsRunHooks;
