// PMJS exposes selected NW APIs but does not implement the full NW environment.
Utils.isNwjs = function() { return false; };

if (typeof SceneManager !== 'undefined') {
  if (globalThis.PMJS_DEVELOPMENT_MODE || PMJS.config.developmentMode) {
    SceneManager.catchException = function(error) { throw error; };
  }
}
