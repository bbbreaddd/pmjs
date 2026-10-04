'use strict';

(function() {
  var reportedScene = null;

  function updateNativeServices() {
    if (globalThis.PMJS && PMJS.rpgmaker && PMJS.rpgmaker.audio &&
        typeof PMJS.rpgmaker.audio.update === 'function') {
      PMJS.rpgmaker.audio.update();
    }
    if (globalThis.PMJS && PMJS.web && PMJS.web.video) {
      PMJS.web.video.update();
    }
    if (globalThis.PMJS && PMJS.tasks) {
      PMJS.tasks.drain();
    }
  }

  function runTick(now, beforeServices, beforeScheduler) {
    if (typeof beforeServices === 'function') beforeServices(now);
    updateNativeServices();
    if (typeof beforeScheduler === 'function') beforeScheduler(now);
    if (typeof globalThis.pmjsDrainScheduler === 'function') {
      globalThis.pmjsDrainScheduler(now);
    }
    if (typeof SceneManager !== 'undefined' && SceneManager._scene !== reportedScene) {
      reportedScene = SceneManager._scene;
      console.log('[pmjs] scene', reportedScene && reportedScene.constructor &&
        reportedScene.constructor.name || 'UnknownScene');
    }
  }

  globalThis.pmjsRunRpgMakerTick = runTick;
})();
