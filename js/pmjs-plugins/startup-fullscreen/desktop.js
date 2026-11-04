'use strict';

(function() {
  PMJS.phases.on('beforePlugins', 'pmjs.startup-fullscreen.desktop', function() {
    PMJS.plugins.interceptLoad('StartUpFullScreen', 'pmjs.startup-fullscreen.desktop', function(next) {
      var isNwjs = Utils.isNwjs;
      Utils.isNwjs = function() { return true; };
      try { return next(); }
      finally { Utils.isNwjs = isNwjs; }
    });
  });
})();
