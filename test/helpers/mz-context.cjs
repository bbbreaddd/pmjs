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
  context.PIXI.SHAPES = { RECT: 1 };
  context.PIXI.Texture = { WHITE: {} };
  class Graphics extends Container {
    constructor() {
      super();
      this.geometry = { graphicsData: [] };
      this.pluginName = 'batch';
      this.tint = 0xffffff;
    }
    get worldTransform() { return this.transform.worldTransform || this.transform.localTransform; }
    finishPoly() {}
    _render() {}
    _populateBatches() {}
    _renderBatched() {}
    _renderDirect() {}
    calculateVertices() {}
    calculateTints() {}
    clear() { this.geometry.graphicsData = []; return this; }
    beginFill(color, alpha = 1) { this.fill = { color, alpha, visible: true,
      texture: context.PIXI.Texture.WHITE, matrix: null }; return this; }
    drawRect(x, y, width, height) {
      this.geometry.graphicsData.push({ shape: { x, y, width, height, type: 1 },
        fillStyle: this.fill, lineStyle: { visible: false }, holes: [], matrix: null });
      return this;
    }
  }
  class ScreenSprite extends Container {
    constructor() {
      super();
      this._graphics = new Graphics();
      this.addChild(this._graphics);
      this.setColor(0, 0, 0);
    }
    setColor(red, green, blue) {
      Object.assign(this, { _red: red, _green: green, _blue: blue });
      this._graphics.clear().beginFill(red << 16 | green << 8 | blue)
        .drawRect(-50000, -50000, 100000, 100000);
    }
  }
  context.PIXI.Graphics = Graphics;
  context.ScreenSprite = ScreenSprite;
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
