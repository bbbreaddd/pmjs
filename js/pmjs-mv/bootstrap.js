'use strict';

(function() {
  function pmjsMvLoadEntrypoint() {
    NativeHost.runtime.loadScript('js/main.js');
    if (typeof window.onload !== 'function') {
      throw new Error('main.js did not install boot hook (window.onload)');
    }
    if (typeof nativeBootPhase === 'function') {
      nativeBootPhase('main-loaded');
    }
  }

  function dispatchWindowLoad() {
    var hooks = globalThis.PMJS_PORT_HOOKS;
    if (hooks && typeof hooks.beforeBoot === 'function') {
      hooks.beforeBoot();
    }
    if (typeof window.dispatchEvent === 'function') {
      window.dispatchEvent({ type: 'load', target: window });
    }
    if (typeof window.onload === 'function') {
      window.onload();
    }
  }

  function pmjsMvStart() {
    dispatchWindowLoad();

    if (typeof nativeBootPhase === 'function') {
      nativeBootPhase('scene-boot-started');
    }
  }

  globalThis.pmjsMvLoadEntrypoint = pmjsMvLoadEntrypoint;
  globalThis.pmjsMvStart = pmjsMvStart;

  if (!globalThis.PMJS_MANUAL_BOOTSTRAP) {
    if (typeof pmjsMvLoadPluginManifest === 'function' && typeof $plugins === 'undefined') {
      pmjsMvLoadPluginManifest();
    }
    if (typeof pmjsMvInitializePlugins === 'function') {
      pmjsMvInitializePlugins();
    }
    if (typeof pmjsMvLoadEntrypoint === 'function') {
      pmjsMvLoadEntrypoint();
    }
    if (typeof pmjsMvStart === 'function') {
      pmjsMvStart();
    }
  }
})();
