'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '../..');

const scripts = new Map();

function runModule(context, relative) {
  let script = scripts.get(relative);
  if (!script) {
    script = new vm.Script(fs.readFileSync(path.join(root, relative), 'utf8'),
      { filename: relative });
    scripts.set(relative, script);
  }
  return script.runInContext(context);
}

function loadPmjsRuntime(extra = {}, modules = [
  'js/pmjs-core/config.js',
  'js/pmjs-core/optimizations.js',
  'js/pmjs-core/methods.js',
  'js/pmjs-rpgmaker/lifecycle.js',
  'js/pmjs-rpgmaker/plugins.js',
  'js/pmjs-web/images.js',
]) {
  const context = vm.createContext(Object.assign({ console }, extra));
  for (const relative of modules) {
    runModule(context, relative);
  }
  return context;
}

module.exports = { loadPmjsRuntime, runModule };
