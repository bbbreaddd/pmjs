'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { loadPmjsRuntime, runModule } = require('./helpers/runtime-context.cjs');

const root = path.resolve(__dirname, '..');
function plain(value) { return JSON.parse(JSON.stringify(value)); }

test('plugin failure remains primary when a method accessor also fails during auditing', () => {
  const logs = [];
  const ctx = loadPmjsRuntime({ console: { error(...args) { logs.push(args); } } });
  const original = new Error('plugin failure'), audit = new Error('accessor failure');
  const target = { update() {} };
  ctx.PMJS.methods.wrap({ key: 'K.update', id: 'pmjs.k', method: 'update', getTarget: () => target, wrap: next => next });
  assert.throws(() => ctx.PMJS.plugins.execute('Example', () => {
    Object.defineProperty(target, 'update', { get() { throw audit; } });
    throw original;
  }), error => error === original);
  assert.deepEqual(logs, [], 'auditing must not invoke the accessor');
  assert.equal(ctx.PMJS.plugins.dump().counts.failed, 1);
});

test('method accessors cannot fail an otherwise successful plugin load', () => {
  const ctx = loadPmjsRuntime();
  const error = new Error('accessor failure'), target = { update() {} };
  ctx.PMJS.methods.wrap({ key: 'K.update', id: 'pmjs.k', method: 'update', getTarget: () => target, wrap: next => next });
  assert.equal(ctx.PMJS.plugins.execute('Example', () => {
    Object.defineProperty(target, 'update', { get() { throw error; } });
  }), true);
  assert.equal(ctx.PMJS.plugins.dump().counts.failed, 0);
  assert.equal(ctx.PMJS.plugins.dump().counts.loaded, 1);
});

test('a falsy plugin exception remains primary when auditing fails', () => {
  const ctx = loadPmjsRuntime({ console: { error() {} } });
  const target = { update() {} };
  ctx.PMJS.methods.wrap({ key: 'K.update', id: 'pmjs.k', method: 'update', getTarget: () => target, wrap: next => next });
  assert.throws(() => ctx.PMJS.plugins.execute('Example', () => {
    Object.defineProperty(target, 'update', { get() { throw new Error('audit'); } });
    throw 0;
  }), caught => caught === 0);
});

test('plugin error formatting and audit logging cannot replace the load failure', () => {
  const ctx = loadPmjsRuntime({ console: { error() { throw new Error('logging failure'); } } });
  const original = { get message() { throw new Error('formatting failure'); } };
  const target = { update() {} };
  ctx.PMJS.methods.wrap({ key: 'K.update', id: 'pmjs.k', method: 'update', getTarget: () => target, wrap: next => next });
  assert.throws(() => ctx.PMJS.plugins.execute('Example', () => {
    Object.defineProperty(target, 'update', { get() { throw new Error('audit failure'); } });
    throw original;
  }), caught => caught === original);
  assert.equal(ctx.PMJS.plugins.dump().counts.failed, 1);
});

test('plugin lifecycle installation preserves existing plugin capabilities', () => {
  const extension = () => 'existing capability';
  const namespace = { extension };
  const ctx = loadPmjsRuntime({ PMJS: { plugins: namespace } });
  assert.equal(ctx.PMJS.plugins, namespace);
  assert.equal(ctx.PMJS.plugins.extension(), 'existing capability');
  const loaded = [];
  ctx.PMJS.plugins.snapshotEffectiveManifest([{ name: 'Example', status: true }]);
  ctx.PMJS.plugins.onLoaded('Example', () => loaded.push('loaded'));
  ctx.PMJS.plugins.execute('Example', () => {});
  assert.deepEqual(loaded, ['loaded']);
  assert.equal(ctx.PMJS.plugins.dump().counts.loaded, 1);
});

test('startup snapshots keep authored order and canonical guest identity', () => {
  const ctx = loadPmjsRuntime();
  ctx.PMJS.plugins.snapshotOriginalManifest([
    { name: 'YED_Tiled', status: true }, { name: 'Off', status: false }
  ]);
  ctx.PMJS.plugins.snapshotEffectiveManifest([
    { name: 'YED_Tiled', status: true }, { name: 'Off', status: false }
  ]);
  ctx.PMJS.plugins.execute('yed_tiled.js', () => {});
  const dump = plain(ctx.PMJS.plugins.dump());
  assert.deepEqual(dump.original, ['YED_Tiled', 'Off']);
  assert.deepEqual(dump.effective, ['YED_Tiled', 'Off']);
  assert.equal(dump.guest.length, 2);
  assert.equal(dump.guest[0].id, 'game:yed_tiled');
  assert.equal(dump.guest[0].name, 'YED_Tiled');
  assert.equal(dump.guest[0].state, 'loaded');
  assert.equal(dump.guest[1].state, 'disabled');
});

test('manifests are one-shot and unfinished plugins appear unloaded at report time', () => {
  const ctx = loadPmjsRuntime();
  ctx.PMJS.plugins.snapshotOriginalManifest([]);
  ctx.PMJS.plugins.snapshotEffectiveManifest([
    { name: 'A', status: true }, { name: 'B', status: true }
  ]);
  ctx.PMJS.plugins.execute('A', () => {});
  assert.equal(ctx.PMJS.plugins.dump().counts.discovered, 1);
  assert.equal(ctx.PMJS.plugins.finish(), true);
  assert.equal(ctx.PMJS.plugins.dump().counts.unloaded, 1);
  assert.equal(ctx.PMJS.plugins.finish(), false);
  assert.throws(() => ctx.PMJS.plugins.snapshotOriginalManifest([]), /already captured/);
  assert.throws(() => ctx.PMJS.plugins.snapshotEffectiveManifest([]), /already captured/);
});

test('named callbacks run once and late subscribers run immediately', () => {
  const ctx = loadPmjsRuntime();
  const seen = [];
  ctx.PMJS.plugins.onLoaded('yed_tiled.js', 'good', () => seen.push('loaded'));
  ctx.PMJS.plugins.execute('YED_Tiled', () => {});
  ctx.PMJS.plugins.onLoaded('YED_Tiled', 'late', () => seen.push('late'));
  assert.deepEqual(seen, ['loaded', 'late']);
});

test('unexpected loaded and late phase installer failures propagate to the caller', () => {
  const errors = [];
  const ctx = loadPmjsRuntime({ console: { error(...args) { errors.push(args); } } });
  const seen = [];
  ctx.PMJS.plugins.onLoaded('Example', 'bad', () => { throw new Error('loaded installer'); });
  ctx.PMJS.plugins.onLoaded('Example', 'next', () => seen.push('next'));
  assert.throws(() => ctx.PMJS.plugins.execute('Example', () => {}), /loaded installer/);
  assert.deepEqual(seen, [], 'boot stops before further installers can mutate state');
  assert.throws(() => ctx.PMJS.plugins.onLoaded('Example', 'late', () => { throw new Error('late installer'); }), /late installer/);
  ctx.PMJS.phases.emit('afterPlugins');
  assert.throws(() => ctx.PMJS.phases.on('afterPlugins', 'late', () => { throw new Error('late phase'); }), /late phase/);
  assert.equal(errors.length, 3);
});

test('loading callbacks surround the named guest execution and canonicalize its name', () => {
  const ctx = loadPmjsRuntime();
  const seen = [];
  ctx.PMJS.plugins.onLoading('Example.js', 'adapter', () => seen.push('before'));
  ctx.PMJS.plugins.onLoaded('Example', 'adapter', () => seen.push('after'));
  ctx.PMJS.plugins.execute('Other', () => seen.push('other'));
  ctx.PMJS.plugins.execute('example', () => seen.push('guest'));
  assert.deepEqual(seen, ['other', 'before', 'guest', 'after']);
  assert.throws(() => ctx.PMJS.plugins.onLoading('EXAMPLE', 'late', () => {}), /after execution/);
});

test('loading callback failures prevent guest execution and remain visible', () => {
  const errors = [];
  const ctx = loadPmjsRuntime({ console: { error(...args) { errors.push(args); } } });
  ctx.PMJS.plugins.onLoading('Example', 'adapter', () => { throw new Error('capture failed'); });
  let executed = false;
  assert.throws(() => ctx.PMJS.plugins.execute('Example', () => { executed = true; }), /capture failed/);
  assert.equal(executed, false);
  const guest = ctx.PMJS.plugins.dump().guest[0];
  assert.equal(guest.state, 'failed');
  assert.equal(guest.error, 'capture failed');
  assert.match(errors[0][0], /owner adapter/);
});

test('failed plugin execution keeps the error and method mutation attribution', () => {
  const target = { update() {} };
  const ctx = loadPmjsRuntime({ target });
  vm.runInContext(`PMJS.methods.wrap({ key: 'K.update', id: 'pmjs.k',
    getTarget: () => target, method: 'update', wrap: next => next })`, ctx);
  assert.throws(() => ctx.PMJS.plugins.execute('Bad', () => {
    target.update = function() {};
    throw new Error('parse explosion');
  }), /parse explosion/);
  const dump = plain(ctx.PMJS.plugins.dump());
  assert.equal(dump.guest[0].state, 'failed');
  assert.equal(dump.guest[0].error, 'parse explosion');
  assert.equal(plain(ctx.PMJS.methods.dump())[0].mutations[0].plugin, 'Bad');
});

test('phases fire once and late registration runs immediately', () => {
  const ctx = loadPmjsRuntime();
  const seen = [];
  ctx.PMJS.phases.on('beforePlugins', 'first', () => seen.push('first'));
  assert.equal(ctx.PMJS.phases.emit('beforePlugins'), true);
  assert.equal(ctx.PMJS.phases.emit('beforePlugins'), false);
  ctx.PMJS.phases.on('beforePlugins', 'late', () => seen.push('late'));
  assert.deepEqual(seen, ['first', 'late']);
});

test('MV bootstrap executes plugins in order and logs a final summary', () => {
  const lines = [];
  const ctx = loadPmjsRuntime({
    console: { log(message) { lines.push(message); }, error(message) { lines.push(message); } },
    NativeHost: { runtime: { loadScript() {} } },
    PluginManager: { _scripts: [], _path: '', setParameters() {} },
    $plugins: [
      { name: 'First', status: true, parameters: {} },
      { name: 'Off', status: false, parameters: {} },
      { name: 'Last', status: true, parameters: {} }
    ]
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'js/pmjs-mv/plugin-loader.js'), 'utf8'),
    ctx);
  vm.runInContext('pmjsMvInitializePlugins()', ctx);
  const dump = plain(ctx.PMJS.plugins.dump());
  assert.equal(dump.counts.loaded, 2);
  assert.equal(dump.counts.disabled, 1);
  assert.deepEqual(dump.guest.filter(entry => entry.state === 'loaded')
    .map(entry => entry.name), ['First', 'Last']);
  assert.ok(lines.some(line => /guest plugins: 3 manifest, 2 loaded/.test(line)));
});

test('MZ manifest paths and filename callbacks describe the same loaded plugin', () => {
  const { loadPmjsRuntime, runModule } = require('./helpers/runtime-context.cjs');
  const context = loadPmjsRuntime({ PMJS_RUNTIME_ENGINE: 'mz' });
  let called = 0;
  context.PMJS.plugins.snapshotEffectiveManifest([{ name: 'Folder/Example', status: true }]);
  context.PMJS.plugins.onLoaded('Example', () => called++);
  context.PMJS.plugins.execute('Example', () => {});
  const snapshot = context.PMJS.plugins.dump();
  assert.equal(called, 1); assert.equal(snapshot.counts.total, 1);
  assert.equal(snapshot.counts.loaded, 1); assert.equal(snapshot.counts.unloaded, 0);
  assert.equal(snapshot.guest[0].name, 'Folder/Example');
});

for (const phase of ['loading', 'loaded', 'late']) {
  test('plugin callback receiver and original exception survive ' + phase + ' dispatch', () => {
    const logs = [], seen = [];
    const ctx = loadPmjsRuntime({ console: { error(...args) { logs.push(args); } } });
    const failure = new Error('callback failed');
    function callback() { seen.push(this); throw failure; }
    callback.call = () => { throw new Error('callback call property must not be invoked'); };
    if (phase === 'late') ctx.PMJS.plugins.execute('Example', () => {});
    const subscribe = () => ctx.PMJS.plugins[phase === 'loading' ? 'onLoading' : 'onLoaded'](
      'Example', 'adapter', callback);
    if (phase === 'late') assert.throws(subscribe, error => error === failure);
    else {
      subscribe();
      assert.throws(() => ctx.PMJS.plugins.execute('Example', () => {}), error => error === failure);
    }
    assert.equal(seen.length, 1);
    if (phase === 'late') assert.equal(seen[0], undefined);
    else { assert.equal(seen[0].owner, 'adapter'); assert.equal(seen[0].callback, callback); }
    assert.equal(logs.length, 1);
    assert.equal(logs[0][0], '[pmjs] error running ' + (phase === 'loading' ? 'loading' : 'loaded') +
      ' callback for example (owner adapter):');
    assert.equal(logs[0][1], failure);
  });
}

function runPluginInfra(context) {
  for (const relative of ['pmjs-core/config.js', 'pmjs-rpgmaker/lifecycle.js',
    'pmjs-core/methods.js', 'pmjs-rpgmaker/plugins.js', 'pmjs-core/optimizations.js',
    'pmjs-rpgmaker/bootstrap.js']) runModule(context, 'js/' + relative);
}

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
  runPluginInfra(context);
  runModule(context, 'js/pmjs-mv/plugin-loader.js');

  let p1SawP2Params = null;
  context.NativeHost = { runtime: { loadScript(name) {
    if (name === 'js/plugins/PluginA.js') {
      p1SawP2Params = context.PluginManager.parameters('PluginB');
    }
  } } };

  const samplePlugins = [
    { name: 'PluginA', status: true, description: '', parameters: { optA: '123' } },
    { name: 'PluginB', status: true, description: '', parameters: { optB: '456' } },
    { name: 'PluginA', status: true, description: 'dup', parameters: { optA: 'dup' } }
  ];

  context.$plugins = samplePlugins;
  context.pmjsMvInitializePlugins();
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
  runPluginInfra(context);
  runModule(context, 'js/pmjs-mv/plugin-loader.js');

  assert.equal(context.PluginManager, undefined);
  context.PluginManager = {
    _path: 'js/plugins/',
    _scripts: [],
    setParameters() {},
    setup() { throw new Error('stock setup should be replaced'); }
  };
  const events = [];
  context.PMJS.plugins.onLoaded('YED_Tiled', () => events.push('loaded'));

  context.$plugins = [{ name: 'YED_Tiled', status: true, parameters: {} }];
  context.pmjsMvInitializePlugins();

  assert.deepEqual(loaded, ['js/plugins/YED_Tiled.js']);
  assert.deepEqual(events, ['loaded']);
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
  runModule(context, 'js/pmjs-web/script-loader.js');

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
    }
  };
  listeners.push(() => { addEventListenerCalled = true; });

  vm.createContext(context);
  runPluginInfra(context);
  runModule(context, 'js/pmjs-mv/boot.js');

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
  runPluginInfra(context);
  runModule(context, 'js/pmjs-web/script-loader.js');
  runModule(context, 'js/pmjs-mv/plugin-loader.js');

  const plugins = [
    { name: 'PluginOne', status: true, description: '', parameters: { opt1: 'v1' } },
    { name: 'PluginTwo', status: true, description: '', parameters: { opt2: 'v2' } }
  ];

  context.$plugins = plugins;
  context.pmjsMvInitializePlugins();

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

  runPluginInfra(context);
  context.PMJS.phases.on('beforePlugins', () => events.push('beforePlugins'));
  context.PMJS.phases.on('afterPlugins', () => events.push('afterPlugins'));
  context.PMJS.phases.on('beforeBoot', () => events.push('beforeBoot'));
  context.globalThis.pmjsPixiRenderPreflight = {
    scan() { events.push('pixi-preflight'); }
  };

  runModule(context, 'js/pmjs-mv/plugin-loader.js');
  runModule(context, 'js/pmjs-mv/boot.js');

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

test('phases run multiple hooks in registration order', () => {
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

  runPluginInfra(context);
  context.PMJS.phases.on('afterPlugins', () => events.push('hook-1'));
  context.PMJS.phases.on('afterPlugins', () => events.push('hook-2'));

  runModule(context, 'js/pmjs-mv/plugin-loader.js');

  context.pmjsMvInitializePlugins();

  assert.deepEqual(events, ['hook-1', 'hook-2']);
});

test('named plugin installer failures stop peers and propagate', () => {
  const context = vm.createContext({ console });
  runPluginInfra(context);
  const seen = [];
  context.PMJS.plugins.onLoaded('SomePlugin', () => { throw new Error('boom'); });
  context.PMJS.plugins.onLoaded('someplugin.js', () => seen.push('loaded'));
  assert.throws(() => context.PMJS.plugins.execute('SomePlugin', function() {}), /boom/);
  assert.deepEqual(seen, []);
});

test('load interceptors preserve ordering, nested loads, results and disposal', () => {
  const ctx = loadPmjsRuntime(), plugins = ctx.PMJS.plugins, calls = [];
  const result = {};
  const dispose = plugins.interceptLoad('Main', 'first', (next, context) => {
    calls.push(['first', context.name, context.path]);
    const value = next();
    calls.push('after');
    return value;
  });
  plugins.interceptLoad('Main.js', 'second', next => {
    calls.push('second');
    return next();
  });
  plugins.interceptLoad('Helper', 'helper', next => { calls.push('helper'); return next(); });
  const load = () => plugins.loadScript('main.js', 'js/plugins/main.js', () => {
    calls.push('main');
    return plugins.loadScript('Helper.js', 'js/plugins/Helper.js', () => result);
  });
  assert.equal(load(), result);
  assert.deepEqual(calls, [['first', 'main.js', 'js/plugins/main.js'], 'second', 'main', 'helper', 'after']);
  dispose(); dispose(); calls.length = 0;
  assert.equal(load(), result);
  assert.deepEqual(calls, ['second', 'main', 'helper']);
  for (const error of [0, null, new Error('guest load')]) {
    assert.throws(() => plugins.loadScript('Main', 'Main.js', () => { throw error; }), caught => caught === error);
  }
});

test('loading cleanup runs in reverse order before success and preserves primary failures', () => {
  for (const phase of ['load', 'loading', 'cleanup']) {
    const ctx = loadPmjsRuntime({ console: { error() {} } }), plugins = ctx.PMJS.plugins;
    const calls = [], primary = 0, cleanupError = new Error('cleanup failed');
    plugins.onLoading('Example', 'first', () => {
      calls.push('first');
      return () => { calls.push('cleanup-first'); throw cleanupError; };
    });
    plugins.onLoading('Example', 'second', () => {
      if (phase === 'loading') throw primary;
      calls.push('second');
      return () => calls.push('cleanup-second');
    });
    plugins.onLoaded('Example', 'loaded', () => calls.push('loaded'));
    assert.throws(() => plugins.execute('Example', () => {
      calls.push('load');
      if (phase === 'load') throw primary;
    }), caught => caught === (phase === 'cleanup' ? cleanupError : primary));
    assert.equal(calls.includes('loaded'), false);
    assert.equal(calls.at(-1), 'cleanup-first');
    if (phase !== 'loading') assert.deepEqual(calls.slice(-2), ['cleanup-second', 'cleanup-first']);
    assert.equal(plugins.dump().counts.failed, 1);
  }
  const ctx = loadPmjsRuntime(), calls = [];
  ctx.PMJS.plugins.onLoading('Example', 'scoped', () => () => calls.push('cleanup'));
  ctx.PMJS.plugins.onLoaded('Example', 'loaded', () => calls.push('loaded'));
  assert.equal(ctx.PMJS.plugins.execute('Example', () => calls.push('load')), true);
  assert.deepEqual(calls, ['load', 'cleanup', 'loaded']);
});

for (const engine of ['mv', 'mz']) {
  test(engine + ' loader intercepts manifest and helper scripts with resolved paths and parameters', () => {
    const calls = [], parameters = new Map(), result = {};
    const name = engine === 'mz' ? 'Folder/Example' : 'Example';
    const ctx = loadPmjsRuntime({ PMJS_RUNTIME_ENGINE: engine,
      console: { log() {} },
      $plugins: [{ name, status: true, parameters: { option: 'value' } }],
      PluginManager: { _scripts: [], _path: 'js/plugins/', setParameters(name, values) { parameters.set(name, values); } },
      NativeHost: { runtime: { loadScript(path) {
        calls.push(['native', path]);
        if (path.endsWith('Example.js')) {
          assert.equal(parameters.get('Example').option, 'value');
          return ctx.PluginManager.loadScript(engine === 'mv' ? 'Helper.js' : 'Helper');
        }
        return result;
      } } }
    });
    ctx.PMJS.plugins.interceptLoad('Example', 'example', (next, context) => {
      calls.push(['intercept', context.name, context.path]);
      assert.equal(next(), result);
      return result;
    });
    ctx.PMJS.plugins.interceptLoad('Helper', 'helper', (next, context) => {
      calls.push(['helper', context.name, context.path]);
      return next();
    });
    vm.runInContext(fs.readFileSync(path.join(root, 'js/pmjs-' + engine + '/plugin-loader.js'), 'utf8'), ctx);
    ctx[engine === 'mv' ? 'pmjsMvInitializePlugins' : 'pmjsMzInitializePlugins']();
    assert.equal(ctx.PMJS.plugins.dump().counts.loaded, 1);
    assert.deepEqual(calls, [
      ['intercept', engine === 'mv' ? 'Example.js' : 'Folder/Example', 'js/plugins/' + name + '.js'],
      ['native', 'js/plugins/' + name + '.js'],
      ['helper', engine === 'mv' ? 'Helper.js' : 'Helper', 'js/plugins/Helper.js'],
      ['native', 'js/plugins/Helper.js']
    ]);
  });
}
