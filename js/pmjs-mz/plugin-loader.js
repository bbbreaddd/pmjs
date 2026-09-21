'use strict';

(function() {
  function installPluginManagerHooks() {
    if (typeof PluginManager === 'undefined') return false;
    if (PluginManager._pmjsLifecycleInstalled) return true;

    PluginManager.loadScript = function(filename) {
      NativeHost.runtime.loadScript('js/plugins/' + filename + '.js');
    };

    PluginManager.setup = function(plugins) {
      var pending = [];
      plugins.forEach(function(plugin) {
        var pluginName = Utils.extractFileName(plugin.name);
        if (plugin.status && this._scripts.indexOf(pluginName) === -1) {
          this.setParameters(pluginName, plugin.parameters);
          this._scripts.push(pluginName);
          pending.push({ filename: plugin.name, name: pluginName });
        }
      }, this);

      pending.forEach(function(plugin) {
        this.loadScript(plugin.filename);
        globalThis.pmjsRunHooks('pluginLoaded', plugin.name);
      }, this);
    };

    PluginManager._pmjsLifecycleInstalled = true;
    return true;
  }

  function loadPluginManifest() {
    NativeHost.runtime.loadScript('js/plugins.js');
  }

  function initializePlugins() {
    installPluginManagerHooks();
    globalThis.pmjsRunHooks('beforePlugins');
    if (typeof $plugins !== 'undefined' && Array.isArray($plugins)) {
      PluginManager.setup($plugins);
    }
    globalThis.pmjsRunHooks('afterPlugins');
    if (typeof nativeBootPhase === 'function') nativeBootPhase('plugins-loaded');
  }

  globalThis.pmjsMzInstallPluginManagerHooks = installPluginManagerHooks;
  globalThis.pmjsMzLoadPluginManifest = loadPluginManifest;
  globalThis.pmjsMzInitializePlugins = initializePlugins;
})();
