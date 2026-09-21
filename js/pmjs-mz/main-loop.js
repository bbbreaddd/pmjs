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

  function tick(now) {
    if (typeof globalThis.__pmjsBeforeTick === 'function') {
      globalThis.__pmjsBeforeTick(now);
    }
    updateNativeServices();
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

  function render(now) {
    if (typeof globalThis.__pmjsBeforeNativeRender === 'function') {
      globalThis.__pmjsBeforeNativeRender(now);
    }
  }

  globalThis.pmjsMzTick = tick;
  globalThis.pmjsMzRender = render;
  globalThis.__pmjsTick = tick;
  globalThis.__pmjsRender = render;
})();
