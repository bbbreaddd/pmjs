'use strict';
const { createContext, runModule } = require('./pixi5-context.cjs');
function createZoomContext() {
  const fixture = createContext();
  const { context } = fixture;
  context.PIXI.filters = {};
  context.PIXI.settings = { PRECISION_FRAGMENT: 'mediump', PRECISION_VERTEX: 'highp' };
  context.PIXI.Filter = function(vertex, fragment) {
    this.uniforms = {};
    this.program = { vertexSrc: 'precision highp float;\n#define SHADER_NAME fixture\n' + vertex.trim(),
      fragmentSrc: 'precision mediump float;\n#define SHADER_NAME fixture\n' + fragment.trim() };
    Object.assign(this, { enabled: true, legacy: false, resolution: 1,
      padding: 0, autoFit: true, blendMode: 0 });
  };
  context.PIXI.Filter.prototype.apply = function() {};
  runModule(context, 'test/assets/pixi-filters/zoom-blur-3.1.0.js');
  runModule(context, 'js/pmjs-pixi5/scene.js');
  context.PIXI.filters.AlphaFilter = class {
    constructor(alpha = 1) {
      this.alpha = alpha; this.program = 'stock-alpha';
      Object.assign(this, { enabled: true, resolution: 1, padding: 0, autoFit: true, blendMode: 0 });
    }
    apply() {}
  };
  runModule(context, 'js/pmjs-pixi5/filters.js');
  runModule(context, 'js/pmjs-pixi5/zoom-blur.js');
  runModule(context, 'js/pmjs-pixi5/renderer.js');
  return fixture;
}
module.exports = { createZoomContext, runModule };
