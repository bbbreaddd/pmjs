'use strict';

(function() {
  function prepareBoot() {
    PMJS.phases.emit('beforeBoot');
    if (typeof PMJS !== 'undefined' && PMJS.optimizations &&
        typeof PMJS.optimizations.finalize === 'function') {
      PMJS.optimizations.finalize();
    }
  }

  function bootStarted() {
    if (typeof nativeBootPhase === 'function') {
      nativeBootPhase('scene-boot-started');
    }
  }

  globalThis.pmjsPrepareRpgMakerBoot = prepareBoot;
  globalThis.pmjsRpgMakerBootStarted = bootStarted;
})();
