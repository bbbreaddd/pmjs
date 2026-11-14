'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { createScriptRuntime } = require('./mv-script-runtime.cjs');
const { installDatabase } = require('./native-database.cjs');
const { installWeb } = require('./native-web.cjs');
const { installStorage } = require('./native-storage.cjs');
const { installCoreServices } = require('./native-core-services.cjs');

function installPlugins(runtime, gameRoot, manifest) {
  const scope = runtime.scope;
  scope.require = createRequire(path.resolve(gameRoot, 'package.json'));
  scope.process = process;
  scope.Buffer = Buffer;
  runtime.runScript('globalThis.window = globalThis; globalThis.global = globalThis;');
  const queue = [];
  let loading = false, scheduling = 0;
  function loadQueued() {
    if (loading || scheduling) return;
    loading = true;
    try {
      while (queue.length) {
        const file = queue.shift();
        try { runtime.runScript(fs.readFileSync(file, 'utf8'), file); }
        catch (error) { manager._errorUrls.push(file); throw error; }
      }
    } finally { loading = false; }
  }
  scope.$plugins = runtime.runScript('JSON.parse(' + JSON.stringify(JSON.stringify(manifest.plugins)) + ')');
  const manager = scope.PluginManager = {
    _path: 'js/plugins/',
    _scripts: runtime.runScript('[]'),
    _parameters: runtime.runScript('({})'),
    _errorUrls: runtime.runScript('[]'),
    parameters(name) { return this._parameters[String(name).toLowerCase()] || runtime.runScript('({})'); },
    setParameters(name, parameters) { this._parameters[String(name).toLowerCase()] = parameters; },
    loadScript(name) {
      queue.push(path.resolve(gameRoot, this._path, name));
      loadQueued();
    },
    checkErrors() {
      const url = this._errorUrls.shift();
      if (url) throw new Error('Failed to load: ' + url);
    },
    setup(plugins) {
      const pending = [];
      for (const plugin of plugins) {
        if (!plugin.status || this._scripts.includes(plugin.name)) continue;
        this.setParameters(plugin.name, plugin.parameters);
        this._scripts.push(plugin.name);
        pending.push(plugin.name + '.js');
      }
      ++scheduling;
      try { for (const name of pending) this.loadScript(name); }
      finally { --scheduling; }
      loadQueued();
    }
  };
  manager.setup(scope.$plugins);
  return manager;
}

function createRuntimeBindings(engine, session, options) {
  const runtime = createScriptRuntime(engine, session, { native: options.native, guestArguments: options.guestArguments });
  const drain = installWeb(runtime, options);
  runtime.installScenes();
  installCoreServices(runtime, engine);
  installDatabase(runtime, engine, session, options.gameRoot);
  installStorage(runtime, options.native, options.storage);
  runtime.beforeFrame = drain;
  return runtime;
}

function createPluginRuntime(engine, session, options) {
  const runtime = createRuntimeBindings(engine, session, options);
  installPlugins(runtime, options.gameRoot, options.manifest);
  return runtime;
}

module.exports = { installPlugins, createRuntimeBindings, createPluginRuntime };
