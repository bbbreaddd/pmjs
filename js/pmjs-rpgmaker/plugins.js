'use strict';

(function() {
  function loadManifest() {
    NativeHost.runtime.loadScript('js/plugins.js');
  }

  function initialize(installManagerHooks, afterPlugins) {
    installManagerHooks();
    globalThis.pmjsRunHooks('beforePlugins');
    if (typeof $plugins !== 'undefined' && Array.isArray($plugins)) {
      PluginManager.setup($plugins);
    }
    globalThis.pmjsRunHooks('afterPlugins');
    if (typeof afterPlugins === 'function') afterPlugins();
    if (typeof nativeBootPhase === 'function') nativeBootPhase('plugins-loaded');
  }

  globalThis.pmjsLoadRpgMakerPluginManifest = loadManifest;
  globalThis.pmjsInitializeRpgMakerPlugins = initialize;
})();
