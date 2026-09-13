'use strict';

globalThis.__pmjsTick = function () {};
globalThis.__pmjsRender = function () {
  NativeHost.render.quad(16, 16, 96, 64, 0.2, 0.55, 0.9, 1);
};
