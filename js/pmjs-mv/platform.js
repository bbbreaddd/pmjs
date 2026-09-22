// PMJS exposes selected NW APIs but does not implement the full NW environment.
Utils.isNwjs = function() { return false; };
Utils.canReadGameFiles = function() { return true; };

if (typeof SceneManager !== 'undefined') {
  SceneManager.isFocus = function() { return true; };
  if (globalThis.PMJS_DEVELOPMENT_MODE ||
      (typeof pmjsGameConfig !== 'undefined' && pmjsGameConfig.developmentMode)) {
    SceneManager.catchException = function(error) { throw error; };
  }
  if (!SceneManager.ticker && typeof PIXI !== 'undefined' && PIXI.ticker &&
      typeof PIXI.ticker.Ticker === 'function') {
    SceneManager.ticker = new PIXI.ticker.Ticker();
    SceneManager.ticker.autoStart = false;
    SceneManager.ticker.stop();
    SceneManager.ticker._pmjsHostDriven = true;
  }
}
