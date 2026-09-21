'use strict';

(function() {
  if (typeof FontManager === 'undefined' || !globalThis.PMJS || !PMJS.fonts) {
    return;
  }

  FontManager.startLoading = function(family, url) {
    this._urls[family] = url;
    this._states[family] = 'loading';
    var registered = PMJS.fonts.registerFace(family, url, { fromGame: true });
    this._states[family] = registered && PMJS.fonts.isFamilyLoaded(family) ?
      'loaded' : 'error';
  };
})();
