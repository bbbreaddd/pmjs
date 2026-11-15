'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { temporaryDirectory } = require('./helpers/temp.cjs');
const { createScriptRuntime } = require('../runner/mv-script-runtime.cjs');
const { installPlugins } = require('../runner/native-plugins.cjs');

function game(files) {
  const root = temporaryDirectory('native-plugins-');
  fs.mkdirSync(path.join(root, 'js/plugins'), { recursive: true });
  for (const [name, source] of Object.entries(files)) fs.writeFileSync(path.join(root, 'js/plugins', name + '.js'), source);
  return root;
}
const runtime = () => createScriptRuntime({ connectRuntime() {}, utilsInvoke(_session, name) { return name === 'RPGMAKER_NAME' ? 'MV' : '1.6.1'; } }, {});
const plugin = (name, status = true, parameters = {}) => ({ name, status, parameters });

test('web host retains inherited addon services and shared service identity', () => {
  const root = game({});
  fs.writeFileSync(path.join(root, 'index.html'), '');
  const host = { fs: { stat() {} }, media: { setAudioContextSuspended() {} }, runtime: {} };
  const native = Object.create(host);
  const r = { scope: {}, runScript() {} };
  require('../runner/native-web.cjs').installWeb(r, { native, gameRoot: root, settings: { width: 640, height: 480 } });
  assert.equal(r.scope.NativeHost.media, host.media);
  assert.equal(r.scope.NativeHost.fs, host.fs);
  host.media.laterMethod = () => 7;
  assert.equal(r.scope.NativeHost.media.laterMethod(), 7);
});

test('native plugins execute once in enabled order with parameters and shared prototypes', () => {
  const root = game({
    First: `var nodeFiles = typeof require('node:fs').readFileSync; var guestWindow = window === globalThis;
      var order = ['first']; var later = PluginManager.parameters('SECOND').setting;
      var originalWait = Game_Interpreter.prototype.wait;
      Game_Interpreter.prototype.wait = function(n) { return originalWait.call(this, n + 1); };
      PluginManager.loadScript('Extra.js');`,
    Second: `order.push('second'); if (!PluginManager._scripts.contains('First')) throw new Error('guest arrays required');`,
    Extra: `order.push('extra');`
  });
  const r = runtime(), original = r.scope.Game_Interpreter.prototype.wait;
  const manifest = { plugins: [plugin('First'), plugin('Disabled', false), plugin('Second', true, { setting: 'later' }), plugin('First')] };
  const manager = installPlugins(r, root, manifest);
  assert.deepEqual(Array.from(r.scope.order), ['first', 'second', 'extra']);
  assert.equal(r.scope.later, 'later');
  assert.equal(r.scope.nodeFiles, 'function');
  assert.equal(r.scope.guestWindow, true);
  assert.equal(r.scope.process.versions.node, process.versions.node);
  assert.notEqual(r.scope.Game_Interpreter.prototype.wait, original);
  assert.deepEqual(Array.from(manager._scripts), ['First', 'Second']);
  manager.parameters('Second').setting = 'changed';
  assert.equal(manifest.plugins[2].parameters.setting, 'later');
  manager.setup(r.scope.$plugins);
  assert.equal(r.scope.order.length, 3);
});

test('native plugin implementations replace source loading at the manifest position', () => {
  const root = game({ Later: 'order.push("later");', toString: 'order.push("source");' });
  const r = runtime(); r.scope.order = r.runScript('[]');
  const nativePlugins = { YED_Tiled(current) {
    assert.equal(current, r);
    assert.equal(current.scope.PluginManager.parameters('YED_Tiled').setting, 'native');
    current.scope.order.push('native');
  } };
  const manager = installPlugins(r, root, { plugins: [plugin('YED_Tiled', true, { setting: 'native' }),
    plugin('Later'), plugin('toString')] }, undefined, nativePlugins);
  assert.deepEqual(Array.from(r.scope.order), ['native', 'later', 'source']);
  assert.deepEqual(Array.from(manager._errorUrls), []);
  assert.deepEqual(Array.from(manager._nativeScripts), ['YED_Tiled']);
  assert.equal(fs.existsSync(path.join(root, 'js/plugins/YED_Tiled.js')), false);
});

test('native implementation errors preserve their resource failure instead of reporting a missing plugin', () => {
  const r = runtime(), failure = Object.assign(new Error('native resource missing'), { code: 'ENOENT' });
  assert.throws(() => installPlugins(r, game({}), { plugins: [plugin('Native')] }, undefined,
    { Native() { throw failure; } }), error => error === failure);
});

test('native plugin failures stop startup and preserve the thrown error and source filename', () => {
  const root = game({ Bad: `throw pluginFailure;`, Later: `ranLater = true;` });
  const r = runtime(), failure = new Error('plugin failure');
  r.scope.pluginFailure = failure;
  assert.throws(() => installPlugins(r, root, { plugins: [plugin('Bad'), plugin('Later')] }), error => error === failure);
  assert.equal(r.scope.ranLater, undefined);
  assert.equal(r.scope.PluginManager._errorUrls.length, 0);
});

test('native plugin loading reports missing enabled files instead of skipping them', () => {
  const r = runtime();
  const manager = installPlugins(r, game({}), { plugins: [plugin('Missing')] });
  assert.throws(() => manager.checkErrors(), /Missing\.js/);
  let failed; manager.onError = event => { failed = event.target._url; };
  manager.loadScript('Again.js'); assert.match(failed, /Again\.js$/);
  assert.doesNotThrow(() => manager.checkErrors());
});

test('native plugin evaluation exposes the current script and restores it after errors', () => {
  const r = runtime();
  r.scope.document = { createElement() { return {}; } };
  r.scope.NativeHost = { runtime: { evalScript: (source, filename) => r.runScript(source, filename) } };
  r.runScript(fs.readFileSync(path.join(__dirname, '../js/pmjs-web/script-loader.js'), 'utf8'));
  const root = game({ Current: `var currentUrl = document.currentScript.src;
    var ownParameters = PluginManager.parameters(currentUrl.split('/').pop().replace('.js', ''));
    throw new Error(ownParameters.message);` });
  assert.throws(() => installPlugins(r, root, { plugins: [plugin('Current', true, { message: 'from current script' })] }), /from current script/);
  assert.equal(r.scope.currentUrl, 'file:///game/js/plugins/Current.js');
  assert.equal(r.scope.document.currentScript, null);
});

test('plugin main module resolves to the game without modifying the host process', () => {
  const r = runtime(), hostMain = process.mainModule;
  const root = game({ Main: `var mainFilename = process.mainModule.filename;
    var processMatches = require('node:process') === process;
    var mainMatches = require.main === process.mainModule && require.main.require('process') === process;` });
  installPlugins(r, root, { plugins: [plugin('Main')] });
  assert.equal(r.scope.mainFilename, path.join(root, 'index.html'));
  assert.equal(r.scope.processMatches, true); assert.equal(r.scope.mainMatches, true);
  assert.equal(process.mainModule, hostMain);
});

test('engine array equality compares sparse elements rather than skipping them', () => {
  const r = runtime();
  assert.equal(r.runScript('Array(1).equals([1])'), false);
  assert.equal(r.runScript('Array(1).equals([undefined])'), true);
  assert.equal(r.runScript('[1, [2]].equals([1, [2]])'), true);
});
