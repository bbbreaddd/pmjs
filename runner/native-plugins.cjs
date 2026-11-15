'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createRequire, Module } = require('node:module');
const { createScriptRuntime } = require('./mv-script-runtime.cjs');
const { installDatabase } = require('./native-database.cjs');
const { installWeb } = require('./native-web.cjs');
const { installStorage } = require('./native-storage.cjs');
const { installSaveManager } = require('./native-save-manager.cjs');
const { installCoreServices } = require('./native-core-services.cjs');

function installPlugins(runtime, gameRoot, manifest, beforePlugins, nativePlugins = {}) {
  const scope = runtime.scope;
  if (!scope.require) {
    const gameRequire = createRequire(path.resolve(gameRoot, 'package.json'));
    const gameProcess = Object.create(process);
    const main = new Module('.');
    main.filename = path.resolve(gameRoot, 'index.html'); main.path = path.resolve(gameRoot); main.loaded = true;
    main.paths = gameRequire.resolve.paths('.') || [];
    scope.require = Object.assign(function(name) { return name === 'process' || name === 'node:process' ? gameProcess : gameRequire(name); }, gameRequire);
    scope.require.main = main; main.require = scope.require;
    Object.defineProperty(gameProcess, 'mainModule', { configurable: true, enumerable: true, writable: true, value: main });
    scope.process = gameProcess;
  }
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
        const name = path.basename(file, '.js');
        const implementation = Object.hasOwn(nativePlugins, name) ? nativePlugins[name] : null;
        try {
          const source = implementation ? null : fs.readFileSync(file, 'utf8');
          const execute=implementation ? () => { implementation(runtime); manager._nativeScripts.push(name); } : () => {
            if (scope.pmjsExecuteScriptElement) {
              const script = scope.document.createElement('script');
              script.src = 'file:///game/' + path.relative(gameRoot, file).split(path.sep).join('/');
              script.textContent = source;
              scope.pmjsExecuteScriptElement(script);
            } else runtime.runScript(source, file);
          };
          if (scope.PMJS?.plugins) scope.PMJS.plugins.execute(name,execute);
          else execute();
        }
        catch (error) {
          if (implementation || error.code !== 'ENOENT' && error.code !== 'EACCES') throw error;
          manager.onError({ target: { _url: file } });
        }
      }
    } finally { loading = false; }
  }
  scope.$plugins = runtime.runScript('JSON.parse(' + JSON.stringify(JSON.stringify(manifest.plugins)) + ')');
  const manager = scope.PluginManager = runtime.runScript('(function PluginManager() { throw new Error("This is a static class"); })');
  Object.assign(manager, {
    _path: 'js/plugins/',
    _scripts: runtime.runScript('[]'),
    _nativeScripts: runtime.runScript('[]'),
    _parameters: runtime.runScript('({})'),
    _errorUrls: runtime.runScript('[]'),
    parameters(name) { return this._parameters[String(name).toLowerCase()] || runtime.runScript('({})'); },
    setParameters(name, parameters) { this._parameters[String(name).toLowerCase()] = parameters; },
    loadScript(name) {
      queue.push(path.resolve(gameRoot, this._path, name));
      loadQueued();
    },
    onError(event) { this._errorUrls.push(event.target._url); },
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
  });
  beforePlugins?.(runtime);
  const lifecycle=scope.PMJS;
  lifecycle?.plugins?.snapshotOriginalManifest(scope.$plugins);
  lifecycle?.plugins?.snapshotEffectiveManifest(scope.$plugins);
  lifecycle?.phases?.emit('beforePlugins');
  manager.setup(scope.$plugins);
  lifecycle?.plugins?.finish();
  lifecycle?.phases?.emit('afterGuestPlugins');
  lifecycle?.phases?.emit('afterPlugins');
  lifecycle?.methods?.install();
  return manager;
}

function createRuntimeBindings(engine, session, options) {
  const runtime = createScriptRuntime(engine, session, { native: options.native, guestArguments: options.guestArguments });
  const drain = installWeb(runtime, options);
  runtime.installScenes();
  installCoreServices(runtime, engine);
  installDatabase(runtime, engine, session, options.gameRoot);
  installStorage(runtime, options.native, options.storage);
  installSaveManager(runtime, engine, session);
  runtime.beforeFrame = drain;
  return runtime;
}

function createPluginRuntime(engine, session, options) {
  const runtime = createRuntimeBindings(engine, session, options);
  installPlugins(runtime, options.gameRoot, options.manifest, options.beforePlugins, options.nativePlugins);
  return runtime;
}

module.exports = { installPlugins, createRuntimeBindings, createPluginRuntime };
