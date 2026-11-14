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
const runtime = () => createScriptRuntime({ connectRuntime() {} }, {});
const plugin = (name, status = true, parameters = {}) => ({ name, status, parameters });

test('native plugins execute once in enabled order with parameters and shared prototypes', () => {
  const root = game({
    First: `var order = ['first']; var later = PluginManager.parameters('SECOND').setting;
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
  assert.notEqual(r.scope.Game_Interpreter.prototype.wait, original);
  assert.deepEqual(Array.from(manager._scripts), ['First', 'Second']);
  manager.parameters('Second').setting = 'changed';
  assert.equal(manifest.plugins[2].parameters.setting, 'later');
  manager.setup(r.scope.$plugins);
  assert.equal(r.scope.order.length, 3);
});

test('native plugin failures stop startup and preserve the thrown error and source filename', () => {
  const root = game({ Bad: `throw pluginFailure;`, Later: `ranLater = true;` });
  const r = runtime(), failure = new Error('plugin failure');
  r.scope.pluginFailure = failure;
  assert.throws(() => installPlugins(r, root, { plugins: [plugin('Bad'), plugin('Later')] }), error => error === failure);
  assert.equal(r.scope.ranLater, undefined);
  assert.match(r.scope.PluginManager._errorUrls[0], /Bad\.js$/);
});

test('native plugin loading reports missing enabled files instead of skipping them', () => {
  const r = runtime();
  assert.throws(() => installPlugins(r, game({}), { plugins: [plugin('Missing')] }), /Missing\.js/);
});
