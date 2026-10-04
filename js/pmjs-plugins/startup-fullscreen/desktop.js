'use strict';

(function() {
  PMJS.phases.on('beforePlugins', 'pmjs.startup-fullscreen.desktop', function() {
    var load = PluginManager.loadScript;
    PluginManager.loadScript = function(name) {
      if (String(name).replace(/\.js$/i, '').toLowerCase() !== 'startupfullscreen') {
        return load.apply(this, arguments);
      }
      var isNwjs = Utils.isNwjs;
      Utils.isNwjs = function() { return true; };
      try { return load.apply(this, arguments); }
      finally { Utils.isNwjs = isNwjs; }
    };
  });
})();
