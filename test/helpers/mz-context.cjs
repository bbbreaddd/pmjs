'use strict';

const { createContext, runModule } = require('./pixi5-context.cjs');

function createMzContext(options) {
  const fixture = createContext(options);
  const { context } = fixture;
  const { Container } = context.PIXI;
  Container.prototype.render = function() {};
  Container.prototype.renderAdvanced = function() {};
  Container.prototype._render = function() {};
  Container.prototype.destroy = function() { this.destroyed = true; };
  class Layer extends Container {
    constructor() {
      super();
      this._images = [];
      this._elements = [];
      this._needsTexturesUpdate = false;
    }
    render() {}
  }
  class Window extends Container {
    constructor(x, y, width, height) {
      super();
      Object.assign(this, { x, y, width, height, _isWindow: true, openness: 255 });
    }
    drawShape() {}
  }
  class WindowLayer extends Container {
    constructor() {
      super();
      this.worldTransform = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };
    }
    render() {}
  }
  class Sprite_Animation extends Container {
    constructor() {
      super();
      this._targets = [{}];
      this._handle = null;
    }
    _render() {}
  }
  Object.assign(context, { Tilemap: { Layer }, Window, WindowLayer,
    Sprite_Animation, Graphics: {}, EffectManager: { load(name) { return name; } },
    queueMicrotask });
  fixture.hits = [];
  const stockHit = context.PMJS.compat.hit;
  context.PMJS.compat.hit = (...args) => { fixture.hits.push(args); stockHit(...args); };
  runModule(context, 'js/pmjs-core/methods.js');
  runModule(context, 'js/pmjs-pixi5/scene.js');
  runModule(context, 'js/pmjs-pixi5/renderer.js');
  const renderOwner = {};
  fixture.renderOwner = renderOwner;
  fixture.render = (stage, width = 64, height = 64, renderer = renderOwner) => {
    context.pmjsPixi5RenderScene(stage, null, 1, { width, height }, renderer);
    return fixture.submissions.at(-1);
  };
  fixture.sprite = (handle, x, y, width, height) => {
    const sprite = new context.PIXI.Sprite({
      baseTexture: { resource: { source: { _nativeImage: { handle } } }, resolution: 1 },
      frame: { x: 0, y: 0, width, height }, orig: { width, height },
    });
    sprite.anchor = { x: 0, y: 0 };
    Object.assign(sprite.transform.localTransform, { tx: x, ty: y });
    return sprite;
  };
  return fixture;
}

module.exports = { createMzContext, runModule };
