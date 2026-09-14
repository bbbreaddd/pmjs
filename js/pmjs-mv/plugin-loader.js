'use strict';

(function() {
  function pmjsMvInstallPluginManagerHooks() {
    if (typeof PluginManager === 'undefined') return;

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
        this.loadScript(plugin.name + '.js');
      }, this);
    };
  }

  pmjsMvInstallPluginManagerHooks();

  function pmjsMvLoadPluginManifest() {
    NativeHost.runtime.loadScript('js/plugins.js');
  }

  function pmjsMvInitializePlugins() {
    var hooks = globalThis.PMJS_PORT_HOOKS;
    if (hooks && typeof hooks.beforePlugins === 'function') {
      hooks.beforePlugins();
    }
    if (typeof $plugins !== 'undefined' && Array.isArray($plugins)) {
      PluginManager.setup($plugins);
    }
    if (hooks && typeof hooks.afterPlugins === 'function') {
      hooks.afterPlugins();
    }
    if (typeof installNativeStorageManager === 'function') {
      installNativeStorageManager();
    }
    if (typeof nativeBootPhase === 'function') {
      nativeBootPhase('plugins-loaded');
    }
  }

  globalThis.pmjsMvInstallPluginManagerHooks = pmjsMvInstallPluginManagerHooks;
  globalThis.pmjsMvLoadPluginManifest = pmjsMvLoadPluginManifest;
  globalThis.pmjsMvInitializePlugins = pmjsMvInitializePlugins;
})();
