'use strict';

nativeBootPhase('adapter-ready');
var pmjsMzRuntimeGame = globalThis.PMJS_RUNTIME_GAME;
NativeHost.runtime.loadScript(pmjsMzRuntimeGame ?
  pmjsMzRuntimeGame.pixiPath : 'js/libs/pixi.js');

if (!globalThis.PIXI || typeof PIXI.Container !== 'function') {
  throw new Error('Pixi object model did not initialize');
}

var pmjsPixiMajor = Number.parseInt(PIXI.VERSION, 10);
if (pmjsPixiMajor !== 5) {
  throw new Error('pmjs-pixi5 requires Pixi 5.x; loaded ' + PIXI.VERSION);
}
if (pmjsMzRuntimeGame && PIXI.VERSION !== pmjsMzRuntimeGame.pixiVersion) {
  throw new Error('inspected Pixi ' + pmjsMzRuntimeGame.pixiVersion +
    ' but loaded ' + PIXI.VERSION);
}
