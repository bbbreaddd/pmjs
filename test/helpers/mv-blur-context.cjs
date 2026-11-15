'use strict';

const { runModule } = require('./runtime-context.cjs');
const vm = require('node:vm');
const { blur, adjustTone, rotateHue } = require('./mv-reviewed-methods.cjs');
const { createHostContext } = require('./mz-host-context.cjs');

function createMvBlurContext(native, { stockBlur, stockAdjustTone, stockRotateHue, disableOptimizations = [] } = {}) {
  const context = createHostContext(native, { graphics: false });
  context.PMJS_GAME_CONFIG = { disableOptimizations };
  for (const module of ['pmjs-core/config', 'pmjs-core/optimizations', 'pmjs-rpgmaker/lifecycle']) {
    runModule(context, 'js/' + module + '.js');
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
    Bitmap.prototype.fillRect = function(x, y, width, height, color) {
      this._context.save();
      this._context.fillStyle = color;
      this._context.fillRect(x, y, width, height);
      this._context.restore();
      this._setDirty();
    };
    Bitmap.prototype.fillAll = function(color) { this.fillRect(0, 0, this.width, this.height, color); };
    Bitmap.prototype._makeFontNameText = function() { return '24px GameFont'; };
    Bitmap.prototype.measureTextWidth = function(text) {
      var context = this._context;
      context.save();
      context.font = this._makeFontNameText();
      var width = context.measureText(text).width;
      context.restore();
      return width;
    };
    Bitmap.prototype.blur = ${stockBlur || blur.toString()};
    Bitmap.prototype.adjustTone = ${stockAdjustTone || adjustTone.toString()};
    Bitmap.prototype.rotateHue = ${stockRotateHue || rotateHue.toString()};
    function Sprite() {}
    function Graphics() {}
    function Input() {}
    function nativeBootPhase() {}
  `, context);
  context.NativeHost.runtime.loadScript = () => {};
  runModule(context, 'js/pmjs-mv/bitmap.js');
  return context;
}

module.exports = { createMvBlurContext };
