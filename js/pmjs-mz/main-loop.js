'use strict';

(function() {
  function tick(now) {
    globalThis.pmjsRunRpgMakerTick(now);
  }

  function render(now) {
    globalThis.pmjsRunRpgMakerRender(now);
  }

  globalThis.pmjsMzTick = tick;
  globalThis.pmjsMzRender = render;
  globalThis.__pmjsTick = tick;
  globalThis.__pmjsRender = render;
})();
