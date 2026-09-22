'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const runtimeRoot = path.resolve(__dirname, '..');

function runModule(context, relative) {
  const source = fs.readFileSync(path.join(runtimeRoot, relative), 'utf8');
  vm.runInContext(source, context, { filename: relative });
}

test('MZ engine loader preserves the authored script order', () => {
  const loaded = [];
  const phases = [];
  const context = vm.createContext({
    console,
    globalThis: null,
    NativeHost: { runtime: { loadScript(script) {
      loaded.push(script);
      if (script === 'js/rmmz_core.js') context.Graphics = function() {};
      if (script === 'js/rmmz_managers.js') context.SceneManager = {};
      if (script === 'js/rmmz_scenes.js') context.Scene_Boot = function() {};
      if (script === 'js/rmmz_windows.js') context.PluginManager = {};
    } } },
    nativeBootPhase(phase) { phases.push(phase); },
  });
  context.globalThis = context;

  runModule(context, 'js/pmjs-mz/engine.js');

  assert.deepEqual(loaded, [
    'js/libs/pako.min.js',
    'js/libs/localforage.min.js',
    'js/rmmz_core.js',
    'js/rmmz_managers.js',
    'js/rmmz_objects.js',
    'js/rmmz_scenes.js',
    'js/rmmz_sprites.js',
    'js/rmmz_windows.js',
  ]);
  assert.deepEqual(phases, ['rpg-core-loaded']);
});

test('MZ plugin and boot lifecycle runs synchronously without main.js or Effekseer', () => {
  const events = [];
  const context = vm.createContext({
    console,
    globalThis: null,
    PMJS_MANUAL_BOOTSTRAP: true,
    NativeHost: { runtime: { loadScript(script) {
      events.push(['script', script]);
      if (script === 'js/plugins.js') {
        context.$plugins = [{ name: 'Example', status: true, parameters: {} }];
      }
    } } },
    PluginManager: {
      _scripts: [],
      setParameters() {},
    },
    Utils: { extractFileName(name) { return name; } },
    SceneManager: { run(scene) { events.push(['scene', scene.name]); } },
    Scene_Boot: function Scene_Boot() {},
    nativeBootPhase(phase) { events.push(['phase', phase]); },
  });
  context.globalThis = context;

  runModule(context, 'js/pmjs-rpgmaker/lifecycle.js');
  runModule(context, 'js/pmjs-core/methods.js');
  runModule(context, 'js/pmjs-rpgmaker/plugins.js');
  runModule(context, 'js/pmjs-core/optimizations.js');
  runModule(context, 'js/pmjs-rpgmaker/bootstrap.js');
  context.PMJS.phases.on('beforePlugins', () => events.push(['hook', 'beforePlugins']));
  context.PMJS.plugins.onLoaded('Example', () => events.push(['hook', 'pluginLoaded']));
  context.PMJS.phases.on('afterPlugins', () => events.push(['hook', 'afterPlugins']));
  context.PMJS.phases.on('beforeBoot', () => events.push(['hook', 'beforeBoot']));
  runModule(context, 'js/pmjs-mz/plugin-loader.js');
  runModule(context, 'js/pmjs-mz/bootstrap.js');
  context.pmjsMzLoadPluginManifest();
  context.pmjsMzInitializePlugins();
  context.pmjsMzStart();

  assert.deepEqual(context.PluginManager._scripts, ['Example']);
  assert.deepEqual(events, [
    ['script', 'js/plugins.js'],
    ['hook', 'beforePlugins'],
    ['script', 'js/plugins/Example.js'],
    ['hook', 'pluginLoaded'],
    ['hook', 'afterPlugins'],
    ['phase', 'plugins-loaded'],
    ['hook', 'beforeBoot'],
    ['scene', 'Scene_Boot'],
    ['phase', 'scene-boot-started'],
  ]);
});
