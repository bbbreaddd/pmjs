'use strict';

(function() {
  function beforeServices() {
    if (typeof SceneManager !== 'undefined' &&
        SceneManager.ticker &&
        SceneManager.ticker._pmjsHostDriven &&
        typeof SceneManager.ticker.update === 'function') {
      SceneManager.ticker.update(performance.now());
    }
  }

  function beforeScheduler() {
    // Re-wrap late plugin replacements of updateMain.
    if (typeof globalThis.pmjsMvEnsureTimingContract === 'function') {
      globalThis.pmjsMvEnsureTimingContract();
    }
  }

  function pmjsMvTick(now) {
    globalThis.pmjsRunRpgMakerTick(now, beforeServices, beforeScheduler);
  }

  function pmjsMvRender(now) {
    globalThis.pmjsRunRpgMakerRender(now);
  }

  globalThis.pmjsMvTick = pmjsMvTick;
  globalThis.pmjsMvRender = pmjsMvRender;
  globalThis.__pmjsTick = pmjsMvTick;
  globalThis.__pmjsRender = pmjsMvRender;
})();
