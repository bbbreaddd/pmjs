'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const jsDir = path.resolve(__dirname, '../js');

test('two-pass PluginManager.setup allows cross-plugin parameter lookups', () => {
  const context = {
    PluginManager: {
      _path: 'js/plugins/',
      _scripts: [],
      _parameters: {},
      setParameters: function(name, params) { this._parameters[name.toLowerCase()] = params; },
      parameters: function(name) { return this._parameters[name.toLowerCase()] || {}; },
      loadScript: function() {}
    }
  };
  vm.createContext(context);
  const setupCode = fs.readFileSync(path.join(jsDir, 'pmjs-mv/setup.js'), 'utf8');
  const pluginLoaderCode = fs.readFileSync(path.join(jsDir, 'pmjs-mv/plugin-loader.js'), 'utf8');
  vm.runInContext(setupCode, context);
  vm.runInContext(pluginLoaderCode, context);

  let p1SawP2Params = null;
  context.PluginManager.loadScript = function(name) {
    if (name === 'PluginA.js') {
      p1SawP2Params = context.PluginManager.parameters('PluginB');
    }
  };

  const samplePlugins = [
    { name: 'PluginA', status: true, description: '', parameters: { optA: '123' } },
    { name: 'PluginB', status: true, description: '', parameters: { optB: '456' } },
    { name: 'PluginA', status: true, description: 'dup', parameters: { optA: 'dup' } }
  ];

  context.PluginManager.setup(samplePlugins);
  assert.deepEqual(p1SawP2Params, { optB: '456' }, 'PluginA should see PluginB parameters before PluginB script loads');
  assert.equal(context.PluginManager._scripts.length, 2, 'Duplicate plugins should be suppressed');
  assert.equal(context.PluginManager._scripts[0], 'PluginA');
  assert.equal(context.PluginManager._scripts[1], 'PluginB');
});

test('plugin lifecycle hooks install after PluginManager becomes available', () => {
  const loaded = [];
  const context = {
    NativeHost: { runtime: { loadScript(name) { loaded.push(name); } } }
  };
  context.globalThis = context;
  vm.createContext(context);
  const setupCode = fs.readFileSync(path.join(jsDir, 'pmjs-mv/setup.js'), 'utf8');
  const pluginLoaderCode = fs.readFileSync(
    path.join(jsDir, 'pmjs-mv/plugin-loader.js'), 'utf8');
  vm.runInContext(setupCode, context);
  vm.runInContext(pluginLoaderCode, context);

  assert.equal(context.pmjsMvInstallPluginManagerHooks(), false);
  context.PluginManager = {
    _path: 'js/plugins/',
    _scripts: [],
    setParameters() {},
    setup() { throw new Error('stock setup should be replaced'); }
  };
  const events = [];
  context.pmjsRegisterHook('pluginLoaded', name => events.push(name));

  assert.equal(context.pmjsMvInstallPluginManagerHooks(), true);
  assert.equal(context.pmjsMvInstallPluginManagerHooks(), true);
  context.PluginManager.setup([
    { name: 'YED_Tiled', status: true, parameters: {} }
  ]);

  assert.deepEqual(loaded, ['js/plugins/YED_Tiled.js']);
  assert.deepEqual(events, ['YED_Tiled']);
  assert.equal(context.PluginManager._pmjsLifecycleInstalled, true);
});

test('document.currentScript stack exposes file:///game/ URL and restores on return and on error', () => {
  const scriptsLoaded = [];
  const context = {
    document: {},
    NativeHost: {
      runtime: {
        loadScript: function(scriptPath) {
          scriptsLoaded.push({
            path: scriptPath,
            currentScriptSrc: context.document.currentScript ? context.document.currentScript.src : null
          });
          if (scriptPath === 'outer.js') {
            try {
              context.NativeHost.runtime.loadScript('throwing.js');
            } catch (_) {}
            scriptsLoaded.push({
              path: 'outer.js-after-throw',
              currentScriptSrc: context.document.currentScript ? context.document.currentScript.src : null
            });
            context.NativeHost.runtime.loadScript('inner.js');
            scriptsLoaded.push({
              path: 'outer.js-resumed',
              currentScriptSrc: context.document.currentScript ? context.document.currentScript.src : null
            });
          } else if (scriptPath === 'throwing.js') {
            throw new Error('boom');
          }
        }
      }
    }
  };
  vm.createContext(context);
  const scriptLoaderCode = fs.readFileSync(path.join(jsDir, 'pmjs-web/script-loader.js'), 'utf8');
  vm.runInContext(scriptLoaderCode, context);

  assert.equal(context.document.currentScript, null, 'Idle currentScript should be null');

  context.NativeHost.runtime.loadScript('outer.js');

  assert.equal(context.document.currentScript, null, 'Post-execution currentScript should be null');
  assert.equal(scriptsLoaded.length, 5);
  assert.equal(scriptsLoaded[0].path, 'outer.js');
  assert.equal(scriptsLoaded[0].currentScriptSrc, 'file:///game/outer.js');
  assert.equal(scriptsLoaded[1].path, 'throwing.js');
  assert.equal(scriptsLoaded[1].currentScriptSrc, 'file:///game/throwing.js');
  assert.equal(scriptsLoaded[2].path, 'outer.js-after-throw');
  assert.equal(scriptsLoaded[2].currentScriptSrc, 'file:///game/outer.js');
  assert.equal(scriptsLoaded[3].path, 'inner.js');
  assert.equal(scriptsLoaded[3].currentScriptSrc, 'file:///game/inner.js');
  assert.equal(scriptsLoaded[4].path, 'outer.js-resumed');
  assert.equal(scriptsLoaded[4].currentScriptSrc, 'file:///game/outer.js');
});test('process.versions and process.version reflect host Node and NW.js compatibility', () => {
  const context = {
    process: {
      platform: 'linux',
      arch: 'x64',
      versions: { node: '25.4.0', v8: '14.0.0', uv: '1.48.0' }
    },
    nativePlatform: { platform: 'linux', arch: 'x64' },
    nativeLogicalWidth: 800,
    nativeLogicalHeight: 600,
    pmjsGameConfig: {}
  };
  vm.createContext(context);
  const modulesCode = fs.readFileSync(path.join(jsDir, 'pmjs-web/modules.js'), 'utf8');
  vm.runInContext(modulesCode, context);

  assert.ok(context.process.versions);
  assert.equal(context.process.version, 'v25.4.0');
  assert.equal(context.process.versions.node, '25.4.0');
  assert.equal(context.process.versions.v8, '14.0.0');
  assert.equal(context.process.versions.nw, '0.29.0');
  assert.equal(context.process.versions['node-webkit'], '0.29.0');
});

test('FPSMeter defines the standard method surface, returns this from methods, and propagates library errors', () => {
  const stubContext = {
    window: {},
    NativeHost: { fs: { exists: () => false } }
  };
  vm.createContext(stubContext);
  const fpsmeterCode = fs.readFileSync(path.join(jsDir, 'pmjs-mv/fpsmeter.js'), 'utf8');
  vm.runInContext(fpsmeterCode, stubContext);

  assert.equal(typeof stubContext.FPSMeter, 'function');
  const meter = new stubContext.FPSMeter({ theme: 'transparent' });
  assert.equal(meter.tickStart(), meter);
  assert.equal(meter.tick(), meter);
  assert.equal(meter.show(), meter);
  assert.equal(meter.hide(), meter);
  assert.equal(meter.toggle(), meter);
  assert.equal(meter.pause(), meter);
  assert.equal(meter.resume(), meter);
  assert.equal(meter.destroy(), meter);

  const errorContext = {
    window: {},
    NativeHost: {
      fs: { exists: () => true },
      runtime: {
        loadScript: () => { throw new Error('syntax error in broken fpsmeter'); }
      }
    }
  };
  vm.createContext(errorContext);
  assert.throws(() => {
    vm.runInContext(fpsmeterCode, errorContext);
  }, /syntax error in broken fpsmeter/);
});

test('greenworks compatibility registers its supported module aliases', () => {
  const modules = {};
  const context = {
    console,
    pmjsGameConfig: { steam: { provider: 'portable', appId: 123456 } },
    pmjsAchievements: {
      initialize: () => {},
      names: () => ['test'],
      isUnlocked: () => false,
      setUnlocked: () => true,
      getStat: () => 0,
      setStat: () => true,
      flush: () => true,
    },
    registerCommonJsModule(names, value) {
      for (const name of names) modules[name] = value;
    },
  };
  vm.createContext(context);
  const compatCode = fs.readFileSync(path.join(jsDir, 'pmjs-plugins/greenworks/compat.js'), 'utf8');
  vm.runInContext(compatCode, context);
  const gw = modules.greenworks;
  assert.equal(modules['./greenworks'], gw);
  assert.equal(gw.initAPI(), true);
  assert.equal(gw.isSteamRunning(), true);
  assert.equal(gw.getSteamId().isValid, false);
  assert.equal(gw.isSubscribedApp(), false);
  assert.equal(gw.isGameOverlayEnabled(), false);
  assert.equal(gw.isDLCInstalled(1), false);
  assert.equal(gw.getAppId(), 123456);

  let achievementResult = null;
  gw.activateAchievement('test', (res) => { achievementResult = res; });
  assert.equal(achievementResult, true);

  let statsResult = null;
  gw.storeStats((res) => { statsResult = res; });
  assert.equal(statsResult, true);
});

test('one physical host tick executes ticker, audio, video, and scheduled MV update', () => {
  let tickerUpdates = 0;
  let audioPolls = 0;
  let videoUpdates = 0;
  let inputUpdates = 0;
  let managerUpdates = 0;
  let sceneUpdates = 0;

  const schedulerCode = fs.readFileSync(path.join(jsDir, 'pmjs-web/scheduler.js'), 'utf8');
  const mainLoopCode = fs.readFileSync(path.join(jsDir, 'pmjs-mv/main-loop.js'), 'utf8');

  const context = {
    console: console,
    performance: { now: () => 1000 },
    Math: Math,
    Number: Number,
    TypeError: TypeError,
    Map: Map,
    nativeAudioBuffers: [{ _poll: () => { audioPolls++; return true; } }],
    nativeVideos: [{ _update: () => { videoUpdates++; return true; } }],
    drainPendingTasks: () => {},
    SceneManager: {
      _stopped: false,
      ticker: { _pmjsHostDriven: true, started: false, update: () => { tickerUpdates++; } },
      update() {
        this.updateManagers();
        this.updateMain();
      },
      updateManagers: () => { managerUpdates++; },
      updateMain() {
        this.updateInputData();
        this.changeScene();
        this.updateScene();
        this.requestUpdate();
      },
      updateInputData: () => { inputUpdates++; },
      changeScene: () => {},
      updateScene: () => { sceneUpdates++; },
      requestUpdate() {
        if (!this._stopped) {
          context.requestAnimationFrame(this.update.bind(this));
        }
      },
      _scene: { constructor: { name: 'Scene_Boot' } }
    }
  };
  context.globalThis = context;
  context.window = context;
  vm.createContext(context);
  vm.runInContext(schedulerCode, context);
  vm.runInContext(mainLoopCode, context);

  context.SceneManager.requestUpdate();

  assert.equal(typeof context.__pmjsTick, 'function');
  context.__pmjsTick(1000);

  assert.equal(tickerUpdates, 1, 'Ticker should update exactly once per host tick');
  assert.equal(audioPolls, 1, 'Audio should poll exactly once per host tick');
  assert.equal(videoUpdates, 1, 'Video should update exactly once per host tick');
  assert.equal(inputUpdates, 1, 'Input should update exactly once per host tick');
  assert.equal(managerUpdates, 1, 'Managers should update exactly once per host tick');
  assert.equal(sceneUpdates, 1, 'Scene should update exactly once per host tick');
});

test('bootstrap dispatches window load event listeners and window.onload', () => {
  let onloadCalled = false;
  let addEventListenerCalled = false;

  const listeners = [];
  const context = {
    window: {
      onload: () => { onloadCalled = true; },
      dispatchEvent: (event) => {
        if (event.type === 'load') {
          for (const l of listeners) l(event);
        }
      }
    },
    PMJS_MANUAL_BOOTSTRAP: true
  };
  listeners.push(() => { addEventListenerCalled = true; });

  vm.createContext(context);
  const setupCode = fs.readFileSync(path.join(jsDir, 'pmjs-mv/setup.js'), 'utf8');
  const bootstrapCode = fs.readFileSync(path.join(jsDir, 'pmjs-mv/bootstrap.js'), 'utf8');
  vm.runInContext(setupCode, context);
  vm.runInContext(bootstrapCode, context);

  assert.equal(typeof context.pmjsMvStart, 'function');
  context.pmjsMvStart();

  assert.equal(onloadCalled, true, 'window.onload should be invoked');
  assert.equal(addEventListenerCalled, true, 'window load event listeners should be dispatched');
});

test('integrated stack: PluginManager.setup -> loadScript -> document.currentScript -> parameter resolution', () => {
  const loadedScripts = [];
  const context = {
    document: {},
    PluginManager: {
      _path: 'js/plugins/',
      _scripts: [],
      _parameters: {},
      setParameters: function(name, params) { this._parameters[name.toLowerCase()] = params; },
      parameters: function(name) { return this._parameters[name.toLowerCase()] || {}; }
    },
    NativeHost: {
      runtime: {
        loadScript: function(scriptPath) {
          loadedScripts.push({
            path: scriptPath,
            src: context.document.currentScript.src,
            paramP2: context.PluginManager.parameters('PluginTwo')
          });
        }
      }
    }
  };
  vm.createContext(context);

  const setupCode = fs.readFileSync(path.join(jsDir, 'pmjs-mv/setup.js'), 'utf8');
  const scriptLoaderCode = fs.readFileSync(path.join(jsDir, 'pmjs-web/script-loader.js'), 'utf8');
  const pluginLoaderCode = fs.readFileSync(path.join(jsDir, 'pmjs-mv/plugin-loader.js'), 'utf8');
  vm.runInContext(setupCode, context);
  vm.runInContext(scriptLoaderCode, context);
  vm.runInContext(pluginLoaderCode, context);

  const plugins = [
    { name: 'PluginOne', status: true, description: '', parameters: { opt1: 'v1' } },
    { name: 'PluginTwo', status: true, description: '', parameters: { opt2: 'v2' } }
  ];

  context.PluginManager.setup(plugins);

  assert.equal(loadedScripts.length, 2);
  assert.equal(loadedScripts[0].path, 'js/plugins/PluginOne.js');
  assert.equal(loadedScripts[0].src, 'file:///game/js/plugins/PluginOne.js');
  assert.deepEqual(loadedScripts[0].paramP2, { opt2: 'v2' }, 'PluginOne should observe PluginTwo parameters at load time');

  assert.equal(loadedScripts[1].path, 'js/plugins/PluginTwo.js');
  assert.equal(loadedScripts[1].src, 'file:///game/js/plugins/PluginTwo.js');
});

test('lifecycle pulses beforePlugins, afterPlugins, and beforeBoot', () => {
  const events = [];
  const sandbox = {
    globalThis: {},
    window: {
      addEventListener() {},
      dispatchEvent() {},
      onload: null
    },
    document: {},
    NativeHost: {
      runtime: {
        loadScript(file) {
          if (file === 'js/main.js') {
            sandbox.window.onload = () => { events.push('window.onload'); };
          } else if (file.startsWith('js/plugins/')) {
            events.push('plugin-script-loaded');
          }
        }
      }
    },
    $plugins: [{ name: 'TestPlugin', status: true, parameters: {} }],
    PluginManager: {
      _scripts: [],
      _path: 'js/plugins/',
      loadScript() { events.push('plugin-script-loaded'); },
      setParameters() {},
      setup: null
    }
  };
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);

  const setupCode = fs.readFileSync(path.join(jsDir, 'pmjs-mv/setup.js'), 'utf8');
  const pluginLoaderCode = fs.readFileSync(path.join(jsDir, 'pmjs-mv/plugin-loader.js'), 'utf8');
  const bootstrapCode = fs.readFileSync(path.join(jsDir, 'pmjs-mv/bootstrap.js'), 'utf8');

  vm.runInContext(setupCode, context);
  context.globalThis.PMJS_MANUAL_BOOTSTRAP = true;
  context.globalThis.pmjsRegisterHook('beforePlugins', () => events.push('beforePlugins'));
  context.globalThis.pmjsRegisterHook('afterPlugins', () => events.push('afterPlugins'));
  context.globalThis.pmjsRegisterHook('beforeBoot', () => events.push('beforeBoot'));
  context.globalThis.pmjsPixiRenderPreflight = {
    scan() { events.push('pixi-preflight'); }
  };

  vm.runInContext(pluginLoaderCode, context);
  vm.runInContext(bootstrapCode, context);

  context.pmjsMvInitializePlugins();
  context.pmjsMvLoadEntrypoint();
  context.pmjsMvStart();

  assert.deepEqual(events, [
    'beforePlugins',
    'plugin-script-loaded',
    'afterPlugins',
    'pixi-preflight',
    'beforeBoot',
    'window.onload'
  ]);
});

test('pmjsRegisterHook registers multiple hooks in order', () => {
  const events = [];
  const sandbox = {
    globalThis: {},
    window: { addEventListener() {}, dispatchEvent() {}, onload: null },
    document: {},
    NativeHost: { runtime: { loadScript() {} } },
    $plugins: [],
    PluginManager: {
      _scripts: [],
      _path: 'js/plugins/',
      loadScript() {},
      setParameters() {},
      setup() {}
    }
  };
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);

  const setupCode = fs.readFileSync(path.join(jsDir, 'pmjs-mv/setup.js'), 'utf8');
  const pluginLoaderCode = fs.readFileSync(path.join(jsDir, 'pmjs-mv/plugin-loader.js'), 'utf8');

  vm.runInContext(setupCode, context);
  context.globalThis.pmjsRegisterHook('afterPlugins', () => events.push('hook-1'));
  context.globalThis.pmjsRegisterHook('afterPlugins', () => events.push('hook-2'));

  vm.runInContext(pluginLoaderCode, context);

  context.pmjsMvInitializePlugins();

  assert.deepEqual(events, ['hook-1', 'hook-2']);
});

test('pluginLoaded hooks fire in load order and stay generic', () => {
  const events = [];
  const sandbox = {
    globalThis: {},
    NativeHost: { runtime: { loadScript() {} } },
    $plugins: [
      { name: 'PluginA', status: true, parameters: {} },
      { name: 'PluginB', status: true, parameters: {} }
    ],
    PluginManager: {
      _scripts: [],
      _path: 'js/plugins/',
      loadScript() {},
      setParameters() {},
      setup() {}
    }
  };
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);

  const setupCode = fs.readFileSync(path.join(jsDir, 'pmjs-mv/setup.js'), 'utf8');
  const pluginLoaderCode = fs.readFileSync(path.join(jsDir, 'pmjs-mv/plugin-loader.js'), 'utf8');

  vm.runInContext(setupCode, context);

  const onPlugin = (name, fn) => {
    context.globalThis.pmjsRegisterHook('pluginLoaded', (loaded) => {
      if (loaded === name) fn();
    });
  };
  onPlugin('PluginA', () => events.push('a-1'));
  onPlugin('PluginA', () => events.push('a-2'));
  onPlugin('PluginB', () => events.push('b'));

  vm.runInContext(pluginLoaderCode, context);

  context.pmjsMvInitializePlugins();

  assert.deepEqual(events, ['a-1', 'a-2', 'b']);

  context.globalThis.pmjsRunHooks('pluginLoaded', 'Nobody');
});

test('hook arguments forward and failures never take down boot', () => {
  const sandbox = { globalThis: {}, console };
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);

  const setupCode = fs.readFileSync(path.join(jsDir, 'pmjs-mv/setup.js'), 'utf8');
  vm.runInContext(setupCode, context);

  const seen = [];
  context.globalThis.pmjsRegisterHook('pluginLoaded', (name) => seen.push(name));
  context.globalThis.pmjsRunHooks('pluginLoaded', 'SomePlugin.js');
  assert.deepEqual(seen, ['SomePlugin.js']);

  for (const devMode of [false, true]) {
    let secondRan = false;
    context.globalThis.PMJS_DEVELOPMENT_MODE = devMode;
    context.globalThis.pmjsRegisterHook('pluginLoaded', () => {
      throw new Error('boom');
    });
    context.globalThis.pmjsRegisterHook('pluginLoaded', () => { secondRan = true; });
    context.globalThis.pmjsRunHooks('pluginLoaded', 'Flaky');
    assert.equal(secondRan, true);
  }
});

test('Scene_Map same-map transfer does not short-circuit through reuse and preserves stock transfer hooks', () => {
  let pluginHookCalls = 0;
  let playerTransferFinalized = false;

  const player = {
    _transferring: true,
    _newMapId: 10,
    _needsMapReload: false,
    isTransferring() { return this._transferring; },
    newMapId() { return this._newMapId; },
    performTransfer() {

      this._transferring = false;
      playerTransferFinalized = true;
    }
  };

  const map = {
    _mapId: 10,
    mapId() { return this._mapId; }
  };

  const origPerformTransfer = player.performTransfer;
  player.performTransfer = function() {
    pluginHookCalls++;
    return origPerformTransfer.apply(this, arguments);
  };

  function Scene_Base() {}
  function Scene_Map() {
    this._transfer = false;
  }
  Scene_Map.prototype = Object.create(Scene_Base.prototype);
  Scene_Map.prototype.constructor = Scene_Map;
  Scene_Map.prototype.updateTransferPlayer = function() {
    if (player.isTransferring()) {
      SceneManager.goto(Scene_Map);
    }
  };
  Scene_Map.prototype.onMapLoaded = function() {
    if (this._transfer) {
      player.performTransfer();
    }
  };

  const SceneManager = {
    _scene: null,
    _nextScene: null,
    _nextSceneSame: false,
    goto(sceneClass) {
      const newScene = new sceneClass();
      newScene._transfer = player.isTransferring();
      this._nextScene = newScene;
    }
  };

  const sandbox = {
    Utils: {},
    SceneManager: SceneManager,
    Scene_Map: Scene_Map,
    $gamePlayer: player,
    $gameMap: map,
    NativeHost: { runtime: {} },
    nativeCompatibilityHit() {}
  };
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  const scenesCode = fs.readFileSync(path.join(jsDir, 'pmjs-mv/scenes.js'), 'utf8');
  vm.runInContext(scenesCode, context);

  assert.equal(context.Scene_Map.prototype._pmjsTransferPatched, undefined);

  const currentMapScene = new context.Scene_Map();
  currentMapScene.updateTransferPlayer();

  assert.ok(SceneManager._nextScene instanceof context.Scene_Map);
  assert.equal(SceneManager._nextSceneSame, false, '_nextSceneSame must not be set on stock same-map transfer');
  assert.equal(currentMapScene.reused, undefined, 'Scene_Map instance must not be marked reused by shared runtime');

  SceneManager._nextScene.onMapLoaded();
  assert.equal(pluginHookCalls, 1, 'Plugin performTransfer hook must execute exactly once');
  assert.equal(playerTransferFinalized, true, 'Player transfer state must be finalized normally');
  assert.equal(player.isTransferring(), false, 'Player isTransferring must be cleared');
});

test('Window_Base and Sprite_Base execute update without suppression', () => {
  let windowUpdated = 0;
  let spriteUpdated = 0;

  function Window_Base() { this.visible = false; }
  Window_Base.prototype.update = function() { windowUpdated++; };

  function Sprite_Base() {}
  Sprite_Base.prototype.update = function() { spriteUpdated++; };

  function Sprite_Picture() { Sprite_Base.call(this); }
  Sprite_Picture.prototype = Object.create(Sprite_Base.prototype);
  Sprite_Picture.prototype.picture = function() { return null; };

  const sandbox = {
    Tilemap: function() {},
    Window_Base: Window_Base,
    Sprite_Base: Sprite_Base,
    Sprite_Picture: Sprite_Picture
  };
  sandbox.Tilemap.prototype = {};
  const context = vm.createContext(sandbox);
  const displayCode = fs.readFileSync(path.join(jsDir, 'pmjs-mv/display.js'), 'utf8');
  vm.runInContext(displayCode, context);

  const win = new context.Window_Base();
  win.update();
  assert.equal(windowUpdated, 1, 'invisible Window_Base should not be suppressed');

  const pic = new context.Sprite_Picture();
  pic.update();
  assert.equal(spriteUpdated, 1, 'Sprite_Picture with null picture should not be suppressed');
});

test('Bitmap.prototype.drawText installs native acceleration only for stock pipeline and respects overrides', () => {
  let stockOutlineCalls = 0;
  let customOutlineCalls = 0;
  let nativeDrawCalls = 0;

  function makeMockBitmapClass(customDrawText) {
    function MockBitmap() {
      this.width = 100;
      this.height = 100;
      this.fontSize = 16;
      this.outlineWidth = 2;
      this.outlineColor = '#000000';
      this.textColor = '#ffffff';
      this._context = {
        globalAlpha: 1,
        save() {},
        restore() {},
        strokeText() {},
        fillText() {}
      };
      this._canvas = { _ensureNativeCanvas() { return { handle: 1 }; } };
    }
    MockBitmap.prototype._makeFontNameText = function() { return '16px sans-serif'; };
    MockBitmap.prototype._setDirty = function() {};
    MockBitmap.prototype._drawTextOutline = function(text, tx, ty, maxWidth) {
      var context = this._context;
      context.strokeStyle = this.outlineColor;
      context.strokeText(text, tx, ty, maxWidth);
      stockOutlineCalls++;
    };
    MockBitmap.prototype._drawTextBody = function(text, tx, ty, maxWidth) {
      var context = this._context;
      context.fillStyle = this.textColor;
      context.fillText(text, tx, ty, maxWidth);
    };
    MockBitmap.prototype.drawText = customDrawText || function(text, x, y, maxWidth, lineHeight, align) {
      if (text !== undefined) {
        var tx = x;
        var ty = y + lineHeight - (lineHeight - this.fontSize * 0.7) / 2;
        var context = this._context;
        var alpha = context.globalAlpha;
        maxWidth = maxWidth || 0xffffffff;
        context.save();
        context.font = this._makeFontNameText();
        this._drawTextOutline(text, tx, ty, maxWidth);
        this._drawTextBody(text, tx, ty, maxWidth);
        context.restore();
        this._setDirty();
      }
    };
    return MockBitmap;
  }

  function createContext(BitmapClass) {
    nativeDrawCalls = 0;
    const sandbox = {
      Bitmap: BitmapClass,
      Sprite: function() {},
      Graphics: Object.assign(function() {}, { width: 100, height: 100 }),
      Input: function() {},
      contextFont: function() { return { path: 'font.ttf', size: 16 }; },
      colorWithGlobalAlpha: function() { return 0xffffffff; },
      nativeBootPhase: function() {},
      NativeHost: {
        runtime: { loadScript() {} },
        render: {},
        canvas: {
          measureText: function() { return 50; },
          drawText: function() { nativeDrawCalls++; }
        }
      }
    };
    const context = vm.createContext(sandbox);
    const bitmapCode = fs.readFileSync(path.join(jsDir, 'pmjs-mv/bitmap.js'), 'utf8');
    vm.runInContext(bitmapCode, context);
    return context;
  }

  const StockBitmap = makeMockBitmapClass();
  const stockContext = createContext(StockBitmap);
  const stockBmp = new stockContext.Bitmap();
  stockBmp.drawText('hello', 0, 0, 100, 20, 'left');
  assert.equal(nativeDrawCalls > 0, true, 'stock methods should use native fast path');
  assert.equal(stockOutlineCalls, 0, 'stock outline should not be called when native fast-path runs');

  let pluginDrawCalls = 0;
  const PreModifiedBitmap = makeMockBitmapClass(function(text) {
    pluginDrawCalls++;
    this._drawTextBody(text, 0, 0, 100);
  });
  const preModifiedContext = createContext(PreModifiedBitmap);
  const preModifiedBmp = new preModifiedContext.Bitmap();
  preModifiedBmp.drawText('custom');
  assert.equal(pluginDrawCalls, 1, 'pre-modified drawText must not be replaced');
  assert.equal(nativeDrawCalls, 0, 'native drawText must not run for non-stock pipeline');

  const customBmp = new stockContext.Bitmap();
  customBmp._drawTextOutline = function() { customOutlineCalls++; };
  customBmp.drawText('hello', 0, 0, 100, 20, 'left');
  assert.equal(customOutlineCalls, 1, 'overridden _drawTextOutline must be invoked via fallback');
});

test('synchronous-burst storage read coalescing preserves stock DataManager object identity and coalesces storage I/O', async () => {
  let storageReads = 0;
  let storageStats = 0;
  let lzDecompresses = 0;

  const sampleGlobalData = {
    1: { title: 'Save 1', playtime: '01:00:00' },
    2: { title: 'Save 2', playtime: '02:00:00' }
  };
  const serializedJson = JSON.stringify(sampleGlobalData);

  const mockStorage = {
    exists(p) {
      storageStats++;

      if (p === 'save/file1.rpgsave' || p === 'file1.rpgsave') return true;
      if (p === 'save/file2.rpgsave' || p === 'file2.rpgsave') return true;
      if (p === 'save/global.rpgsave' || p === 'global.rpgsave') return true;
      return false;
    },
    readText(p) {
      storageReads++;
      if (p === 'save/global.rpgsave' || p === 'global.rpgsave') {
        return 'BASE64_MOCK_GLOBAL';
      }
      return null;
    },
    writeText() {},
    remove() {},
    rename() {}
  };

  const mockLZString = {
    decompressFromBase64(str) {
      lzDecompresses++;
      if (str === 'BASE64_MOCK_GLOBAL') return serializedJson;
      return null;
    }
  };

  const StorageManager = {
    isLocalMode() { return true; },
    localFilePath(savefileId) {
      if (savefileId === 0) return '/save/global.rpgsave';
      return '/save/file' + savefileId + '.rpgsave';
    },
    load(savefileId) {
      return this.loadFromLocalFile(savefileId);
    },
    loadFromLocalFile(savefileId) {
      const p = this.localFilePath(savefileId);
      const relative = p.startsWith('/save/') ? p.slice(6) : p;
      const text = mockStorage.readText(relative);
      return mockLZString.decompressFromBase64(text);
    },
    exists(savefileId) {
      return this.localFileExists(savefileId);
    },
    localFileExists(savefileId) {
      const p = this.localFilePath(savefileId);
      const relative = p.startsWith('/save/') ? p.slice(6) : p;
      return mockStorage.exists(relative);
    },
    saveToLocalFile(savefileId, json) {},
    backup(savefileId) {},
    remove(savefileId) {}
  };

  const DataManager = {
    maxSavefiles() { return 20; },
    loadGlobalInfo() {
      const json = StorageManager.load(0);
      if (json) {
        const globalInfo = JSON.parse(json);
        for (let i = 1; i <= this.maxSavefiles(); i++) {
          if (!StorageManager.exists(i)) {
            delete globalInfo[i];
          }
        }
        return globalInfo;
      }
      return [];
    }
  };

  const sandbox = {
    NativeHost: { storage: mockStorage },
    StorageManager: StorageManager,
    DataManager: DataManager,
    LZString: mockLZString,
    queueMicrotask: globalThis.queueMicrotask,
    Promise: globalThis.Promise,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout
  };
  sandbox.globalThis = sandbox;

  const context = vm.createContext(sandbox);
  const storageCode = fs.readFileSync(path.join(jsDir, 'pmjs-mv/storage.js'), 'utf8');
  vm.runInContext(storageCode, context);

  const a = context.DataManager.loadGlobalInfo();
  const b = context.DataManager.loadGlobalInfo();

  assert.notEqual(a, b, 'Each loadGlobalInfo call must return a fresh, distinct object reference');
  assert.deepEqual(a, b, 'Contents should match');

  a[1].title = 'Mutated by plugin';
  assert.equal(b[1].title, 'Save 1', 'Mutating a must not affect b');

  for (let i = 0; i < 14; i++) {
    context.DataManager.loadGlobalInfo();
  }

  assert.equal(storageReads, 1, 'Only 1 storage read for the entire burst of 16 calls');
  assert.equal(lzDecompresses, 1, 'Only 1 LZString decompression for the entire burst of 16 calls');
  assert.equal(storageStats, 20, 'Only 20 exists stats (1..20) for the entire burst of 16 calls (not 320)');

  context.StorageManager.remove(1);
  const c = context.DataManager.loadGlobalInfo();
  assert.equal(storageReads, 2, 'Storage mutation must invalidate burst cache, causing fresh read');
  assert.equal(lzDecompresses, 2, 'Storage mutation must invalidate burst cache, causing fresh decompression');
  assert.equal(storageStats, 40, 'Storage mutation must invalidate burst cache, causing fresh stats');

  await new Promise(resolve => queueMicrotask(resolve));
  const d = context.DataManager.loadGlobalInfo();
  assert.equal(storageReads, 3, 'New microtask turn must execute fresh storage read');
  assert.equal(lzDecompresses, 3, 'New microtask turn must execute fresh decompression');
  assert.equal(storageStats, 60, 'New microtask turn must execute fresh stats');
});

test('storage read coalescing runs underneath plugin wrappers and respects dynamic localFilePath', () => {
  let physicalReads = 0;
  let physicalStats = 0;
  let pluginLoadCalls = 0;
  let pluginExistsCalls = 0;

  const mockStorage = {
    exists(p) {
      physicalStats++;
      return true;
    },
    readText(p) {
      physicalReads++;
      return p.includes('profileA') ? '{"profile":"A"}' : '{"profile":"B"}';
    },
    writeText() {},
    remove() {},
    rename() {}
  };

  const mockLZString = {
    decompressFromBase64(s) { return s; }
  };

  let activeProfile = 'profileA';

  const StorageManager = {
    isLocalMode() { return true; },
    localFilePath(savefileId) {
      if (savefileId < 0) return '/save/config.rpgsave';
      if (savefileId === 0) return '/save/global.rpgsave';
      return '/save/file' + savefileId + '.rpgsave';
    },
    load(savefileId) {
      return this.loadFromLocalFile(savefileId);
    },
    loadFromLocalFile(savefileId) {
      const p = this.localFilePath(savefileId).slice(6);
      return mockLZString.decompressFromBase64(mockStorage.readText(p));
    },
    exists(savefileId) {
      return this.localFileExists(savefileId);
    },
    localFileExists(savefileId) {
      const p = this.localFilePath(savefileId).slice(6);
      return mockStorage.exists(p);
    },
    saveToLocalFile() {},
    backup() {},
    remove() {}
  };

  let jsonParses = 0;
  const DataManager = {
    maxSavefiles() { return 2; },
    loadGlobalInfo() {
      const json = StorageManager.load(0);
      if (json) {
        jsonParses++;
        return JSON.parse(json);
      }
      return [];
    }
  };

  const sandbox = {
    NativeHost: { storage: mockStorage },
    StorageManager: StorageManager,
    DataManager: DataManager,
    LZString: mockLZString,
    queueMicrotask: globalThis.queueMicrotask,
    Promise: globalThis.Promise,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout
  };
  sandbox.globalThis = sandbox;

  const context = vm.createContext(sandbox);

  const storageCode = fs.readFileSync(path.join(jsDir, 'pmjs-mv/storage.js'), 'utf8');
  vm.runInContext(storageCode, context);

  context.StorageManager.localFilePath = function(savefileId) {
    return '/save/' + activeProfile + '/file' + savefileId + '.rpgsave';
  };
  const origLoadFromLocalFile = context.StorageManager.loadFromLocalFile;
  context.StorageManager.loadFromLocalFile = function(savefileId) {
    pluginLoadCalls++;
    return origLoadFromLocalFile.call(this, savefileId);
  };

  const origLocalFileExists = context.StorageManager.localFileExists;
  context.StorageManager.localFileExists = function(savefileId) {
    pluginExistsCalls++;
    return origLocalFileExists.call(this, savefileId);
  };

  const res1 = context.StorageManager.load(1);
  const res2 = context.StorageManager.load(1);

  assert.equal(pluginLoadCalls, 2, 'Plugin wrapper must run on every single StorageManager.load call');
  assert.equal(physicalReads, 1, 'Underneath, low-level physical disk read is coalesced to 1');
  assert.equal(res1, '{"profile":"A"}');
  assert.equal(res2, '{"profile":"A"}');

  const ex1 = context.StorageManager.exists(1);
  const ex2 = context.StorageManager.exists(1);
  assert.equal(pluginExistsCalls, 2, 'Plugin wrapper must run on every single StorageManager.exists call');
  assert.equal(physicalStats, 1, 'Underneath, physical stat is coalesced to 1');

  const g1 = context.DataManager.loadGlobalInfo();
  const g2 = context.DataManager.loadGlobalInfo();
  assert.notEqual(g1, g2, 'Each loadGlobalInfo must return a fresh object');
  assert.equal(jsonParses, 2, 'JSON.parse must run on every loadGlobalInfo call');
  assert.equal(pluginLoadCalls, 4, 'Plugin load wrapper must run on every loadGlobalInfo call');
  assert.equal(physicalReads, 2, 'Only one physical read for the new file0 path across both calls');

  activeProfile = 'profileB';
  const resB = context.StorageManager.load(1);
  assert.equal(pluginLoadCalls, 5, 'Plugin wrapper runs on profile B call');
  assert.equal(physicalReads, 3, 'Switching directory path must perform a physical read for new path');
  assert.equal(resB, '{"profile":"B"}', 'Result must reflect profile B, not stale profile A');

  mockStorage.writeText('profileB/file1.rpgsave', 'something');
  const resAfterWrite = context.StorageManager.load(1);
  assert.equal(pluginLoadCalls, 6);
  assert.equal(physicalReads, 4, 'Direct NativeHost.storage write must invalidate read burst');

  vm.runInContext(storageCode, context);
  assert.equal(
    context.StorageManager.localFilePath(1),
    '/save/profileB/file1.rpgsave',
    'Reinstall must preserve the plugin localFilePath override');
  const resReinstall = context.StorageManager.load(1);
  assert.equal(pluginLoadCalls, 7, 'Plugin wrapper must still be outermost after reinstall');
  assert.equal(resReinstall, '{"profile":"B"}');
  assert.equal(physicalReads, 4, 'Live burst must survive reinstall (still a hit, no new physical read)');
});

