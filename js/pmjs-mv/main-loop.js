'use strict';

(function() {
  function updateNativeServices() {
    if (typeof SceneManager !== 'undefined' &&
        SceneManager.ticker &&
        SceneManager.ticker._pmjsHostDriven &&
        typeof SceneManager.ticker.update === 'function') {
      SceneManager.ticker.update(performance.now());
    }

    if (Array.isArray(globalThis.nativeAudioBuffers)) {
      for (var i = nativeAudioBuffers.length - 1; i >= 0; i--) {
        if (!nativeAudioBuffers[i]._poll()) {
          nativeAudioBuffers.splice(i, 1);
        }
      }
    }

    if (Array.isArray(globalThis.nativeVideos)) {
      for (var j = nativeVideos.length - 1; j >= 0; j--) {
        if (!nativeVideos[j]._update()) {
          nativeVideos.splice(j, 1);
        }
      }
    }

    if (typeof globalThis.drainPendingTasks === 'function') {
      globalThis.drainPendingTasks();
    }
  }

  var reportedScene = null;

  function pmjsMvTick(now) {
    if (typeof globalThis.__pmjsBeforeTick === 'function') {
      globalThis.__pmjsBeforeTick(now);
    }

    updateNativeServices();

    // Re-wrap late plugin replacements of updateMain.
    if (typeof globalThis.pmjsMvEnsureTimingContract === 'function') {
      globalThis.pmjsMvEnsureTimingContract();
    }

    if (typeof globalThis.pmjsDrainScheduler === 'function') {
      globalThis.pmjsDrainScheduler(now);
    }

    if (typeof SceneManager !== 'undefined' && SceneManager._scene !== reportedScene) {
      reportedScene = SceneManager._scene;
      console.log('[pmjs] scene', reportedScene && reportedScene.constructor && reportedScene.constructor.name || 'UnknownScene');
    }

    if (typeof globalThis.__pmjsAfterTick === 'function') {
      globalThis.__pmjsAfterTick(now);
    }
  }

  function pmjsMvRender(now) {
    // Normally empty. Stock MV already calls SceneManager.renderScene()
    // from its own updateMain() during the scheduled RAF.
    if (typeof globalThis.__pmjsBeforeNativeRender === 'function') {
      globalThis.__pmjsBeforeNativeRender(now);
    }
  }

  globalThis.pmjsMvTick = pmjsMvTick;
  globalThis.pmjsMvRender = pmjsMvRender;
  globalThis.__pmjsTick = pmjsMvTick;
  globalThis.__pmjsRender = pmjsMvRender;
})();
