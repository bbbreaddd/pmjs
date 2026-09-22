'use strict';

(function() {
  function pmjsMvInstallPluginManagerHooks() {
    if (typeof PluginManager === 'undefined') return false;
    if (PluginManager._pmjsLifecycleInstalled) return true;

    PluginManager.loadScript = function(name) {
      NativeHost.runtime.loadScript(this._path + name);
    };

    PluginManager.setup = function(plugins) {
      var pending = [];
      var isAlreadyLoaded = function(scripts, name) {
        if (typeof scripts.contains === 'function') return scripts.contains(name);
        return scripts.indexOf(name) !== -1;
      };
      plugins.forEach(function(plugin) {
        if (plugin.status &&
            !isAlreadyLoaded(this._scripts, plugin.name) &&
            !pending.some(function(p) { return p.name === plugin.name; })) {
          pending.push(plugin);
        }
      }, this);

      pending.forEach(function(plugin) {
        this.setParameters(plugin.name, plugin.parameters);
      }, this);

      pending.forEach(function(plugin) {
        this._scripts.push(plugin.name);
        var loadedName = String(plugin.name).replace(/\.js$/i, '');
        var self = this;
        var file = plugin.name + '.js';
        PMJS.plugins.execute(loadedName, function() {
          self.loadScript(file);
        });
      }, this);
    };
    PluginManager._pmjsLifecycleInstalled = true;
    return true;
  }

  pmjsMvInstallPluginManagerHooks();

  function pmjsMvLoadPluginManifest() {
    globalThis.pmjsLoadRpgMakerPluginManifest();
  }

  function afterPlugins() {
    if (globalThis.pmjsPixiRenderPreflight) globalThis.pmjsPixiRenderPreflight.scan();

    if (typeof installNativeStorageManager === 'function') {
      installNativeStorageManager();
    }

    if (typeof pmjsMvInstallTimingContract === 'function') {
      pmjsMvInstallTimingContract();
    }
  }

  function pmjsMvInitializePlugins() {
    globalThis.pmjsInitializeRpgMakerPlugins(
      pmjsMvInstallPluginManagerHooks, afterPlugins);
  }

  globalThis.pmjsMvInstallPluginManagerHooks = pmjsMvInstallPluginManagerHooks;
  globalThis.pmjsMvLoadPluginManifest = pmjsMvLoadPluginManifest;
  globalThis.pmjsMvInitializePlugins = pmjsMvInitializePlugins;
})();
