'use strict';

(function() {
  function tick(now) {
    globalThis.pmjsRunRpgMakerTick(now);
  }

  // MZ renders from its ticker during the update phase.
  function render() { PMJS.mz.graphics.updatePresentation(); }

  globalThis.pmjsMzTick = tick;
  globalThis.pmjsMzRender = render;
  globalThis.__pmjsTick = tick;
  globalThis.__pmjsRender = render;
})();
