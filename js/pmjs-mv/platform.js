// PMJS exposes selected NW APIs but does not implement the full NW environment.
Utils.isNwjs = function() { return false; };
Utils.canReadGameFiles = function() { return true; };

if (typeof SceneManager !== 'undefined') {
  SceneManager.isFocus = function() { return true; };
  if (globalThis.PMJS_DEVELOPMENT_MODE || PMJS.config.developmentMode) {
    SceneManager.catchException = function(error) { throw error; };
  }
}
