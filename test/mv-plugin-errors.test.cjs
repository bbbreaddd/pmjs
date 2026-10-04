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
  vm.runInContext(fs.readFileSync(require.resolve('../js/pmjs-mv/plugin-loader.js'), 'utf8'), context);
  context.pmjsMvInitializePlugins();
  const guests = context.PMJS.plugins.dump().guest;
  assert.equal(guests[0].state, 'failed');
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
});
