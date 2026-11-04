'use strict';

(function() {
  function installPluginManagerHooks() {
    if (typeof PluginManager === 'undefined') return false;
    if (PluginManager._pmjsLifecycleInstalled) return true;

    PluginManager.loadScript = function(filename) {
      var path = 'js/plugins/' + filename + '.js';
      return PMJS.plugins.loadScript(filename, path, function() {
        return NativeHost.runtime.loadScript(path);
      });
    };

    PluginManager.setup = function(plugins) {
      var pending = [];
      plugins.forEach(function(plugin) {
        var pluginName = plugin.name.split('/').pop();
        if (plugin.status && this._scripts.indexOf(pluginName) === -1) {
          this.setParameters(pluginName, plugin.parameters);
          this._scripts.push(pluginName);
          pending.push({ filename: plugin.name, name: pluginName });
        }
      }, this);

      pending.forEach(function(plugin) {
        var self = this;
        var file = plugin.filename;
        var name = plugin.name;
        PMJS.plugins.execute(name, function() {
          self.loadScript(file);
        });
      }, this);
    };

    PluginManager._pmjsLifecycleInstalled = true;
    return true;
  }

  function loadPluginManifest() {
    globalThis.pmjsLoadRpgMakerPluginManifest();
  }

  function initializePlugins() {
    globalThis.pmjsInitializeRpgMakerPlugins(installPluginManagerHooks);
  }

  globalThis.pmjsMzLoadPluginManifest = loadPluginManifest;
  globalThis.pmjsMzInitializePlugins = initializePlugins;
})();
