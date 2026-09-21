'use strict';

(function() {
  function start() {
    globalThis.pmjsRunHooks('beforeBoot');
    if (typeof PMJS !== 'undefined' && PMJS.optimizations &&
        typeof PMJS.optimizations.finalize === 'function') {
      PMJS.optimizations.finalize();
    }
    SceneManager.run(Scene_Boot);
    if (typeof nativeBootPhase === 'function') nativeBootPhase('scene-boot-started');
  }

  globalThis.pmjsMzStart = start;

  if (!globalThis.PMJS_MANUAL_BOOTSTRAP) {
    globalThis.pmjsMzLoadPluginManifest();
    globalThis.pmjsMzInitializePlugins();
    start();
  }
})();
