'use strict';

(function() {
  function start() {
    globalThis.pmjsPrepareRpgMakerBoot();
    SceneManager.run(Scene_Boot);
    globalThis.pmjsRpgMakerBootStarted();
  }

  globalThis.pmjsMzStart = start;
})();
