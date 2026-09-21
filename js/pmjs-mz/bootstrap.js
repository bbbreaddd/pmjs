'use strict';

(function() {
  function start() {
    globalThis.pmjsPrepareRpgMakerBoot();
    SceneManager.run(Scene_Boot);
    globalThis.pmjsRpgMakerBootStarted();
  }

  globalThis.pmjsMzStart = start;

  if (!globalThis.PMJS_MANUAL_BOOTSTRAP) {
    globalThis.pmjsMzLoadPluginManifest();
    globalThis.pmjsMzInitializePlugins();
    start();
  }
})();
