'use strict';

(function() {
  var reportedScene = null;

  function updateNativeServices() {
    if (Array.isArray(globalThis.nativeAudioBuffers)) {
      for (var audioIndex = nativeAudioBuffers.length - 1;
          audioIndex >= 0; audioIndex--) {
        if (!nativeAudioBuffers[audioIndex]._poll()) {
          nativeAudioBuffers.splice(audioIndex, 1);
        }
      }
    }
    if (Array.isArray(globalThis.nativeVideos)) {
      for (var videoIndex = nativeVideos.length - 1;
          videoIndex >= 0; videoIndex--) {
        if (!nativeVideos[videoIndex]._update()) {
          nativeVideos.splice(videoIndex, 1);
        }
      }
    }
    if (typeof globalThis.drainPendingTasks === 'function') {
      globalThis.drainPendingTasks();
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
