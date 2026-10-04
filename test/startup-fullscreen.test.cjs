'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');
const { loadPmjsRuntime } = require('./helpers/runtime-context.cjs');

for (const throws of [false, true]) {
  test('desktop plugin loading restores host identity after ' + (throws ? 'failure' : 'success'), () => {
    const visits = [];
    const context = loadPmjsRuntime({ Utils: { isNwjs() { return false; } },
      PluginManager: { loadScript(name) {
        visits.push([name, context.Utils.isNwjs()]);
        if (throws && name === 'StartUpFullScreen.js') throw new Error('load failed');
        return 'loaded';
      } } });
    const original = context.Utils.isNwjs;
    const file = require.resolve('../js/pmjs-plugins/startup-fullscreen/desktop.js');
    vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
    context.PMJS.phases.emit('beforePlugins');
    assert.equal(context.PluginManager.loadScript('Other.js'), 'loaded');
    if (throws) assert.throws(() => context.PluginManager.loadScript('StartUpFullScreen.js'), /load failed/);
    else assert.equal(context.PluginManager.loadScript('StartUpFullScreen.js'), 'loaded');
    assert.equal(context.Utils.isNwjs, original);
    assert.deepEqual(visits, [['Other.js', false], ['StartUpFullScreen.js', true]]);
  });
}
