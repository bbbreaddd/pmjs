'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
const { loadPmjsRuntime } = require('./runtime-context.cjs');

module.exports = function fixture(module, plugin, files, { reviewed = true, enabled = true, hash } = {}) {
  const context = loadPmjsRuntime({ __pmjsBuiltinRequire: require, console,
    NativeHost: { runtime: { env: name => !enabled && name === 'PMJS_DISABLE_OPT' ? 'plugins.yanfly.independent-item-search' : '' } } }, [
    'js/pmjs-core/config.js', 'js/pmjs-core/optimizations.js', 'js/pmjs-core/methods.js',
    'js/pmjs-rpgmaker/lifecycle.js', 'js/pmjs-rpgmaker/plugins.js'
  ]);
  let output, delegated;
  context.NativeHost = {
    fs: { readText: file => files[file] ?? null },
    runtime: { runScript: text => { output = text; return 'evaluated'; } }
  };
  let adapter = fs.readFileSync(path.join(__dirname, '../..', module), 'utf8');
  if (hash && reviewed) {
    const input = files['js/plugins/' + plugin + '.js'];
    adapter = adapter.replace(hash, createHash('sha256').update(input.replace(/\r\n/g, '\n')).digest('hex'));
  }
  vm.runInContext(adapter, context);
  context.PMJS.phases.emit('beforePlugins');
  function source(file) {
    output = undefined; delegated = false;
    context.PMJS.plugins.loadScript(plugin, file, () => {
      delegated = true; output = files[file]; return 'delegated';
    });
    return output;
  }
  return { context, source, get delegated() { return delegated; },
    load(file) { return vm.runInContext(source(file), context); } };
};
