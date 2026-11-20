'use strict';

if (PMJS.rpgmaker && typeof PMJS.rpgmaker.start === 'function') {
  globalThis.__pmjsStartup = Promise.resolve().then(function() { return PMJS.rpgmaker.start(); });
} else {
  if (typeof $plugins === 'undefined') pmjsMvLoadPluginManifest();
  pmjsMvInitializePlugins();
  pmjsMvLoadEntrypoint();
  pmjsMvStart();
}
