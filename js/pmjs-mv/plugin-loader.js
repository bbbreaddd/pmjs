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
        try {
          PMJS.plugins.execute(loadedName, function() {
            self.loadScript(file);
          });
        } catch (error) {
          var failed = PMJS.plugins.dump().guest.some(function(entry) {
            return entry.key === loadedName.toLowerCase() && entry.state === 'failed';
          });
          if (!failed) throw error;
          if (!NativeHost.fs.exists(this._path + file)) {
            this.onError({ target: { _url: this._path + file } });
          } else {
            pmjsReportEventError(error);
          }
        }
      }, this);
    };
    PluginManager._pmjsLifecycleInstalled = true;
    return true;
  }

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

  globalThis.pmjsMvLoadPluginManifest = pmjsMvLoadPluginManifest;
  globalThis.pmjsMvInitializePlugins = pmjsMvInitializePlugins;
})();
