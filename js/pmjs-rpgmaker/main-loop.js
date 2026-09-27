'use strict';

(function() {
  var reportedScene = null;

  function updateNativeServices() {
    if (globalThis.PMJS && PMJS.rpgmaker && PMJS.rpgmaker.audio &&
        typeof PMJS.rpgmaker.audio.update === 'function') {
      PMJS.rpgmaker.audio.update();
    }
    if (Array.isArray(globalThis.nativeVideos)) {
      for (var videoIndex = nativeVideos.length - 1;
          videoIndex >= 0; videoIndex--) {
        var video = nativeVideos[videoIndex];
        if (!video) continue;
        var videoPlayGeneration = video._playGeneration;
        var videoLoadGeneration = video._loadGeneration;
        if (!video._update() && video._playGeneration === videoPlayGeneration &&
            video._loadGeneration === videoLoadGeneration) {
          var currentVideoIndex = nativeVideos.indexOf(video);
          if (currentVideoIndex >= 0) nativeVideos.splice(currentVideoIndex, 1);
        }
      }
    }
    if (globalThis.PMJS && PMJS.tasks) {
      PMJS.tasks.drain();
    }
  }

  function runTick(now, beforeServices, beforeScheduler) {
    if (typeof globalThis.__pmjsBeforeTick === 'function') {
      globalThis.__pmjsBeforeTick(now);
    }
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
    if (typeof globalThis.__pmjsAfterTick === 'function') {
      globalThis.__pmjsAfterTick(now);
    }
  }

  function runRender(now) {
    if (typeof globalThis.__pmjsBeforeNativeRender === 'function') {
      globalThis.__pmjsBeforeNativeRender(now);
    }
  }

  globalThis.pmjsRunRpgMakerTick = runTick;
  globalThis.pmjsRunRpgMakerRender = runRender;
})();
