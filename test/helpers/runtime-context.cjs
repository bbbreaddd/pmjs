'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '../..');

function loadPmjsRuntime(extra = {}, modules = [
  'js/pmjs-core/config.js',
  'js/pmjs-core/optimizations.js',
  'js/pmjs-core/methods.js',
  'js/pmjs-rpgmaker/lifecycle.js',
  'js/pmjs-rpgmaker/plugins.js',
]) {
  const context = vm.createContext(Object.assign({ console }, extra));
  for (const relative of modules) {
    vm.runInContext(fs.readFileSync(path.join(root, relative), 'utf8'),
      context, { filename: relative });
  }
  return context;
}

module.exports = { loadPmjsRuntime };
