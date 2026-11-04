'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const { loadPmjsRuntime } = require('./helpers/runtime-context.cjs');

for (const missing of [false, true]) test('MV plugin failures preserve diagnostics and continue subsequent scripts: ' + missing, () => {
  const reported = [], missingUrls = [], loaded = [];
  const context = loadPmjsRuntime({
    console: { log() {}, error() {} },
    NativeHost: { fs: { exists: () => !missing }, runtime: { loadScript(name) {
      loaded.push(name);
      if (name === 'js/plugins/Bad.js') throw new SyntaxError('invalid authored script');
    } } },
    pmjsReportEventError: error => reported.push(error.message),
    PluginManager: { _scripts: [], _path: 'js/plugins/', setParameters() {},
      onError(event) { missingUrls.push(event.target._url); } },
    $plugins: [{ name: 'Bad', status: true, parameters: {} }, { name: 'Good', status: true, parameters: {} }]
  });
  context.PMJS.plugins.interceptLoad('Bad', 'delegate', next => next());
  vm.runInContext(fs.readFileSync(require.resolve('../js/pmjs-mv/plugin-loader.js'), 'utf8'), context);
  context.pmjsMvInitializePlugins();
  const guests = context.PMJS.plugins.dump().guest;
  assert.equal(guests[0].state, 'failed');
  assert.equal(guests[0].failureStage, 'guest-script');
  assert.equal(guests[0].error, 'invalid authored script');
  assert.equal(guests[1].state, 'loaded');
  assert.deepEqual(loaded, ['js/plugins/Bad.js', 'js/plugins/Good.js']);
  assert.deepEqual(reported, missing ? [] : ['invalid authored script']);
  assert.deepEqual(missingUrls, missing ? ['js/plugins/Bad.js'] : []);
});

test('MV compatibility installer errors still stop initialization', () => {
  const context = loadPmjsRuntime({ console: { log() {}, error() {} },
    NativeHost: { runtime: { loadScript() {} } },
    PluginManager: { _scripts: [], _path: '', setParameters() {} },
    $plugins: [{ name: 'Guest', status: true, parameters: {} }] });
  context.PMJS.plugins.onLoaded('Guest', 'broken', () => { throw new Error('installer failed'); });
  vm.runInContext(fs.readFileSync(require.resolve('../js/pmjs-mv/plugin-loader.js'), 'utf8'), context);
  assert.throws(() => context.pmjsMvInitializePlugins(), /installer failed/);
  const entry = context.PMJS.plugins.dump().guest[0];
  assert.equal(entry.state, 'failed');
  assert.equal(entry.loadOrder, 0);
  assert.match(entry.reason, /loaded callback/);
});

for (const stage of ['loading-callback', 'load-interceptor', 'cleanup', 'loaded-callback']) {
  test('MV aborts on adapter failure during ' + stage, () => {
    const loaded = [], reported = [];
    const failure = Error('adapter initialization failed');
    const context = loadPmjsRuntime({ console: { log() {}, error() {} },
      NativeHost: { fs: { exists: () => true }, runtime: { loadScript(path) { loaded.push(path); } } },
      pmjsReportEventError: error => reported.push(error),
      PluginManager: { _scripts: [], _path: 'js/plugins/', setParameters() {} },
      $plugins: [{ name: 'Guest', status: true }, { name: 'Later', status: true }] });
    const fail = () => { throw failure; };
    if (stage === 'loading-callback') context.PMJS.plugins.onLoading('Guest', 'adapter', fail);
    if (stage === 'load-interceptor') context.PMJS.plugins.interceptLoad('Guest', 'adapter', fail);
    if (stage === 'cleanup') context.PMJS.plugins.onLoading('Guest', 'adapter', () => fail);
    if (stage === 'loaded-callback') context.PMJS.plugins.onLoaded('Guest', 'adapter', fail);
    vm.runInContext(fs.readFileSync(require.resolve('../js/pmjs-mv/plugin-loader.js'), 'utf8'), context);
    assert.throws(() => context.pmjsMvInitializePlugins(), error => error === failure);
    assert.deepEqual(reported, []);
    assert.deepEqual(loaded, stage === 'cleanup' || stage === 'loaded-callback' ? ['js/plugins/Guest.js'] : []);
    const entry = context.PMJS.plugins.dump().guest[0];
    assert.equal(entry.state, 'failed');
    assert.equal(entry.failureStage, stage);
    assert.equal(entry.loadOrder, stage === 'loaded-callback' ? 0 : null);
  });
}
