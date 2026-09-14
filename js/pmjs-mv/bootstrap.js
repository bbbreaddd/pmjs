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
    globalThis.pmjsRunHooks('beforeBoot');
    // beforeBoot is the last legal optimization-registration seam: adapters
    // may register here once all plugins are composed. Finalize now, before
    // game boot, so a requested disable that nobody registered fails fast
    // instead of silently doing nothing. Registration freezes from here on.
    if (typeof PMJS !== 'undefined' && PMJS.optimizations &&
        typeof PMJS.optimizations.finalize === 'function') {
      PMJS.optimizations.finalize();
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
