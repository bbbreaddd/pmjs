'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { blur } = require('./mv-reviewed-methods.cjs');
const { createHostContext } = require('./mz-host-context.cjs');

function createMvBlurContext(native, { stockBlur, disableOptimizations = [] } = {}) {
  const context = createHostContext(native, { graphics: false });
  context.PMJS_GAME_CONFIG = { disableOptimizations };
  const root = path.resolve(__dirname, '../..');
  for (const module of ['pmjs-core/config', 'pmjs-core/optimizations', 'pmjs-rpgmaker/lifecycle']) {
    vm.runInContext(fs.readFileSync(path.join(root, 'js', module + '.js'), 'utf8'), context);
  }
  vm.runInContext(`
    function Bitmap(width, height) {
      this.width = width; this.height = height;
      this._canvas = document.createElement('canvas');
      this._canvas.width = width; this._canvas.height = height;
      this._context = this._canvas.getContext('2d');
      this.dirtyCalls = 0; this.stockCalls = 0;
    }
    Bitmap.prototype._setDirty = function() { this.dirtyCalls++; };
    Bitmap.prototype.blur = ${stockBlur || blur.toString()};
    function Sprite() {}
    function Graphics() {}
    function Input() {}
    function nativeBootPhase() {}
  `, context);
  const loadScript = native.runtime.loadScript;
  native.runtime.loadScript = () => {};
  try {
    vm.runInContext(fs.readFileSync(path.join(root, 'js/pmjs-mv/bitmap.js'), 'utf8'), context);
  } finally {
    native.runtime.loadScript = loadScript;
  }
  return context;
}

module.exports = { createMvBlurContext };
