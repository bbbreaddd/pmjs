'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const runtimeRoot = path.resolve(__dirname, '../..');

function runModule(context, relative) {
  const source = fs.readFileSync(path.join(runtimeRoot, relative), 'utf8');
  vm.runInContext(source, context, { filename: relative });
}

function createContext() {
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
    NativeHost: {
      scene: {
        packetVersion: 28,
        schema: { version: 28, metadataStride: 7, valueStride: 41,
          transactionalSubmit: true, filterCompositeBlend: true },
        submit(version, metadata, values, count) {
          submissions.push({ version, metadata: metadata.slice(),
            values: values.slice(), count });
        },
      },
      render: {
        setClearColor() {},
        setScreenRenderSize(width, height) { sizes.push([width, height]); },
        setRenderTargetSize(width, height) { targets.push(['size', width, height]); },
        renderToCanvas(handle) { targets.push(['render', handle]); },
      },
      canvas: { captureScene() { return { handle: 333 }; } },
    },
    PIXI: {
      VERSION: '5.3.12',
      RENDERER_TYPE: { WEBGL: 1 },
      SCALE_MODES: { LINEAR: 0, NEAREST: 1 },
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
  return { context, canvas, submissions, sizes, targets, OriginalApplication };
}

module.exports = { createContext, runModule };
