'use strict';

(function() {
  var screenRenderId;
  function afterServices() {
    if (typeof SceneManager !== 'undefined' &&
        SceneManager.ticker &&
        SceneManager.ticker._pmjsHostDriven &&
        typeof SceneManager.ticker.update === 'function') {
      SceneManager.ticker.update(performance.now());
    }
  }

  function pmjsMvTick(now) {
    var renderer = typeof Graphics !== 'undefined' && Graphics._renderer;
    screenRenderId = renderer && renderer._pmjsScreenRenderId;
    return globalThis.pmjsRunRpgMakerTick(now, afterServices);
  }

  function memoryReclamationBoundary() {
    if (typeof SceneManager === 'undefined' || typeof ScreenSprite !== 'function' ||
        typeof Graphics === 'undefined' || !SceneManager.isSceneChanging()) return null;
    var scene = SceneManager._scene, renderer = Graphics._renderer;
    var fade = scene && scene._fadeSprite;
    if (!renderer || renderer._pmjsScreenRenderId === screenRenderId ||
        renderer._pmjsScreenStage !== scene || !fade ||
        Object.getPrototypeOf(fade) !== ScreenSprite.prototype ||
        scene.children[scene.children.length - 1] !== fade ||
        scene.alpha !== 1 || fade.alpha !== 1 ||
        !scene.visible || !scene.renderable || !fade.visible || !fade.renderable ||
        scene._mask || fade._mask || scene._filters || fade._filters ||
        scene.cacheAsBitmap || fade.cacheAsBitmap ||
        fade._red !== 0 || fade._green !== 0 || fade._blue !== 0 ||
        scene._fadeSign !== -1 || scene._fadeDuration !== 0 ||
        Graphics._isVideoVisible()) return null;
    var matrix = fade.worldTransform;
    if (!matrix || matrix.a !== 1 || matrix.b !== 0 || matrix.c !== 0 ||
        matrix.d !== 1 || matrix.tx !== 0 || matrix.ty !== 0) return null;
    return 'scene-fade';
  }

  function pmjsMvRender(now) {
    if (typeof Graphics !== 'undefined' && Graphics._renderer &&
        typeof Graphics._renderer._pmjsSyncPresentation === 'function') {
      Graphics._renderer._pmjsSyncPresentation();
    }
  }

  globalThis.pmjsMvTick = pmjsMvTick;
  globalThis.pmjsMvRender = pmjsMvRender;
  globalThis.__pmjsTick = pmjsMvTick;
  globalThis.__pmjsRender = pmjsMvRender;
  globalThis.__pmjsMemoryReclamationBoundary = memoryReclamationBoundary;
})();
