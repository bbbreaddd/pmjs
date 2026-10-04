'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const runtimeRoot = path.resolve(__dirname, '../..');

function runModule(context, relative) {
  const source = fs.readFileSync(path.join(runtimeRoot, relative), 'utf8');
  vm.runInContext(source, context, { filename: relative });
}

function createContext({ strictCompatibility = true } = {}) {
  let nextCanvasHandle = 900;
  function CanvasElement() {
    this.width = 0;
    this.height = 0;
    this.drawCalls = [];
    this._handle = nextCanvasHandle++;
  }
  CanvasElement.prototype.getContext = function() {
    return { drawImage: (...args) => this.drawCalls.push(args) };
  };
  CanvasElement.prototype._ensureNativeCanvas = function() {
    return { handle: this._handle };
  };
  CanvasElement.prototype._pmjsContentChanged = function() {};
  CanvasElement.prototype._releaseNativeCanvas = function() { this.released = true; };
  function Rectangle(x, y, width, height) {
    Object.assign(this, { x, y, width, height });
  }
  function Container() {
    this.children = [];
    this.visible = true;
    this.renderable = true;
    this.alpha = 1;
    this.transform = {
      localTransform: { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 },
      updateLocalTransform() {},
    };
  }
  Container.prototype.addChild = function(child) {
    this.children.push(child);
    child.parent = this;
  };
  function Sprite(texture) {
    Container.call(this);
    this.texture = texture;
    this.anchor = { x: 0.5, y: 0.25 };
    this.tint = 0xffffff;
    this.blendMode = 0;
    this.pluginName = 'batch';
  }
  Sprite.prototype = Object.create(Container.prototype);
  Sprite.prototype.constructor = Sprite;
  function TilingSprite(texture, width, height) {
    Sprite.call(this, texture);
    this.width = width;
    this.height = height;
    this.anchor = { x: 0, y: 0 };
    this.tilePosition = { x: 0, y: 0 };
    this.tileScale = { x: 1, y: 1 };
    this.pluginName = 'tilingSprite';
    this.uvRespectAnchor = false;
    this.tileTransform = {
      pivot: { x: 0, y: 0 }, rotation: 0,
      localTransform: { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 },
      updateLocalTransform: () => {
        const t = this.tileTransform, m = t.localTransform;
        m.a = Math.cos(t.rotation) * this.tileScale.x;
        m.b = Math.sin(t.rotation) * this.tileScale.x;
        m.c = -Math.sin(t.rotation) * this.tileScale.y;
        m.d = Math.cos(t.rotation) * this.tileScale.y;
        m.tx = this.tilePosition.x - t.pivot.x * m.a - t.pivot.y * m.c;
        m.ty = this.tilePosition.y - t.pivot.x * m.b - t.pivot.y * m.d;
      },
    };
  }
  TilingSprite.prototype = Object.create(Sprite.prototype);
  TilingSprite.prototype.constructor = TilingSprite;
  function OriginalRenderer() {}
  function OriginalApplication() {}
  OriginalApplication._plugins = [{
    init(options) {
      this.pluginInitializedWith = options;
      this.ticker = { remove() {}, add() {} };
    },
    destroy() {},
  }];
  OriginalApplication.prototype.render = function() {
    this.renderer.render(this.stage);
  };

  const submissions = [];
  const sizes = [];
  const targets = [];
  const canvas = { style: {}, width: 0, height: 0 };
  const context = vm.createContext({
    console,
    globalThis: null,
    CanvasElement,
    document: { createElement() { return canvas; } },
    PMJS: {},
    trackNativeResource(resource) { return resource; },
    releaseNativeResource(resource) { context.NativeHost.images.release(resource.handle); },
    NativeHost: {
      runtime: { env(name) { return name === 'PMJS_STRICT_COMPAT' && strictCompatibility ? '1' : undefined; } },
      scene: {
        packetVersion: 29,
        schema: { version: 29, metadataStride: 7, valueStride: 41,
          transactionalSubmit: true, filterCompositeBlend: true, clampedTilingSampling: true, floatSpriteUv: true, repeatSpriteSampling: true },
        submit(version, metadata, values, count) {
          submissions.push({ version, metadata: metadata.slice(),
            values: values.slice(), count });
        },
      },
      render: {
        setClearColor() {},
        setClearBeforeRender() {},
        setSceneProjection() {},
        setScreenRenderSize(width, height) { sizes.push([width, height]); },
        setRenderTargetSize(width, height) { targets.push(['size', width, height]); },
        renderToCanvas(handle) { targets.push(['render', handle]); },
      },
      canvas: { captureScene() { return { handle: 333 }; } },
      images: { release() {} },
    },
    PIXI: {
      VERSION: '5.3.12',
      RENDERER_TYPE: { WEBGL: 1 },
      SCALE_MODES: { LINEAR: 1, NEAREST: 0 },
      Rectangle,
      Container,
      Sprite,
      Graphics: function Graphics() {},
      TilingSprite,
      Renderer: OriginalRenderer,
      Application: OriginalApplication,
    },
  });
  context.globalThis = context;
  runModule(context, 'js/pmjs-core/compatibility.js');
  return { context, canvas, submissions, sizes, targets, OriginalApplication };
}

module.exports = { createContext, runModule };
