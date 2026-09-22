'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const runtimeRoot = path.resolve(__dirname, '..');

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
        packetVersion: 27,
        schema: { version: 27, metadataStride: 7, valueStride: 41,
          transactionalSubmit: true },
        submit(version, metadata, values, count) {
          submissions.push({ version, metadata: metadata.slice(),
            values: values.slice(), count });
        },
      },
      render: {
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

test('Pixi 5 Application keeps plugins and uses the native renderer', () => {
  const fixture = createContext();
  runModule(fixture.context, 'js/pmjs-pixi5/scene.js');
  runModule(fixture.context, 'js/pmjs-pixi5/renderer.js');

  const view = { style: {} };
  const app = new fixture.context.PIXI.Application({
    view, width: 320, height: 180, resolution: 2, autoStart: false,
  });
  assert.ok(app instanceof fixture.OriginalApplication);
  assert.equal(app.renderer.view, view);
  assert.equal(app.renderer.width, 640);
  assert.equal(app.renderer.height, 360);
  assert.equal(app.stage instanceof fixture.context.PIXI.Container, true);
  assert.equal(app.pluginInitializedWith.autoStart, false);
  assert.equal(fixture.context.PIXI.Renderer.create({ width: 12, height: 8 }).width, 12);
  app.render();
  const packet = fixture.submissions[0];
  assert.equal(packet.count, 3, 'background, resolution transform, stage');
  assert.equal(packet.values[1 * 41], 2);
  assert.equal(packet.values[1 * 41 + 3], 2);
});

test('Pixi 5 scene encoder reads resource.source and submits sprites', () => {
  const fixture = createContext();
  runModule(fixture.context, 'js/pmjs-pixi5/scene.js');
  runModule(fixture.context, 'js/pmjs-pixi5/renderer.js');
  const app = new fixture.context.PIXI.Application({ width: 100, height: 50 });
  const texture = {
    baseTexture: {
      resource: { source: { _nativeImage: { handle: 42 } } },
      resolution: 1,
      scaleMode: fixture.context.PIXI.SCALE_MODES.NEAREST,
    },
    frame: { x: 4, y: 6, width: 20, height: 10 },
    orig: { width: 20, height: 10 },
    trim: null,
    rotate: 0,
  };
  const sprite = new fixture.context.PIXI.Sprite(texture);
  sprite.transform.localTransform.tx = 12;
  sprite.transform.localTransform.ty = 8;
  app.stage.addChild(sprite);

  app.render();

  assert.equal(fixture.submissions.length, 1);
  const packet = fixture.submissions[0];
  assert.equal(packet.version, 27);
  assert.equal(packet.count, 3, 'background, stage container, sprite');
  assert.equal(packet.metadata[2 * 7], 1);
  assert.equal(packet.metadata[2 * 7 + 2], 42);
  assert.equal(packet.metadata[2 * 7 + 5] & 8, 8);
  assert.equal(packet.values[2 * 41 + 4], 12);
  assert.equal(packet.values[2 * 41 + 5], 8);
  assert.equal(packet.values[2 * 41 + 7], -10);
  assert.equal(packet.values[2 * 41 + 8], -2.5);
  assert.equal(packet.values[2 * 41 + 9], 4);
  assert.equal(packet.values[2 * 41 + 10], 6);
  assert.equal(packet.values[2 * 41 + 11], 20);
  assert.equal(packet.values[2 * 41 + 12], 10);
});

test('Pixi 5 scene encoder accepts an unrealized BaseTexture resource', () => {
  const fixture = createContext();
  runModule(fixture.context, 'js/pmjs-pixi5/scene.js');
  runModule(fixture.context, 'js/pmjs-pixi5/renderer.js');
  const app = new fixture.context.PIXI.Application({ width: 100, height: 50 });
  const texture = {
    baseTexture: { resource: null, resolution: 1, scaleMode: 0 },
    frame: { x: 0, y: 0, width: 1, height: 1 },
    orig: { width: 1, height: 1 },
    trim: null,
    rotate: 0,
  };
  app.stage.addChild(new fixture.context.PIXI.Sprite(texture));

  assert.doesNotThrow(() => app.render());
  assert.equal(fixture.submissions[0].count, 3);
  assert.equal(fixture.submissions[0].metadata[2 * 7], 0);
});

test('Pixi 5 scene encoder emits MZ ScreenSprite without rasterizing its Graphics', () => {
  const fixture = createContext();
  function ScreenSprite() {
    fixture.context.PIXI.Container.call(this);
    this._red = 18;
    this._green = 52;
    this._blue = 86;
    this._graphics = new fixture.context.PIXI.Graphics();
    this.addChild(this._graphics);
  }
  ScreenSprite.prototype = Object.create(fixture.context.PIXI.Container.prototype);
  ScreenSprite.prototype.constructor = ScreenSprite;
  fixture.context.ScreenSprite = ScreenSprite;
  runModule(fixture.context, 'js/pmjs-pixi5/scene.js');
  runModule(fixture.context, 'js/pmjs-pixi5/renderer.js');
  const app = new fixture.context.PIXI.Application({ width: 100, height: 50 });
  app.stage.addChild(new fixture.context.ScreenSprite());

  assert.doesNotThrow(() => app.render());
  const packet = fixture.submissions[0];
  assert.equal(packet.count, 3, 'background, stage container, screen fill');
  assert.equal(packet.metadata[2 * 7], 3);
  assert.equal(packet.metadata[2 * 7 + 3], 0x123456);
});

test('Pixi 5 scene encoder emits full-texture TilingSprite packets', () => {
  const fixture = createContext();
  runModule(fixture.context, 'js/pmjs-pixi5/scene.js');
  runModule(fixture.context, 'js/pmjs-pixi5/renderer.js');
  const app = new fixture.context.PIXI.Application({ width: 100, height: 50 });
  const texture = {
    baseTexture: {
      resource: { source: { _nativeImage: { handle: 73 } } },
      width: 64,
      height: 32,
      resolution: 2,
      scaleMode: fixture.context.PIXI.SCALE_MODES.NEAREST,
    },
    frame: { x: 0, y: 0, width: 64, height: 32 },
    trim: null,
    rotate: 0,
  };
  const tiling = new fixture.context.PIXI.TilingSprite(texture, 80, 40);
  tiling.pluginName = 'tilingSprite';
  tiling.anchor = { x: 0.5, y: 0.25 };
  tiling.tilePosition = { x: 6, y: -4 };
  tiling.tileScale = { x: 2, y: 0.5 };
  app.stage.addChild(tiling);

  app.render();
  const packet = fixture.submissions[0];
  assert.equal(packet.metadata[2 * 7], 2);
  assert.equal(packet.metadata[2 * 7 + 2], 73);
  assert.equal(packet.metadata[2 * 7 + 5] & 8, 8);
  assert.equal(packet.values[2 * 41 + 7], -40);
  assert.equal(packet.values[2 * 41 + 8], -10);
  assert.equal(packet.values[2 * 41 + 9], -6);
  assert.equal(packet.values[2 * 41 + 10], 16);
  assert.equal(packet.values[2 * 41 + 11], 80);
  assert.equal(packet.values[2 * 41 + 12], 160);
  assert.equal(packet.values[2 * 41 + 13], 80);
  assert.equal(packet.values[2 * 41 + 14], 40);
});

test('Pixi 5 scene encoder isolates atlas frames used by TilingSprite', () => {
  const fixture = createContext();
  runModule(fixture.context, 'js/pmjs-pixi5/scene.js');
  runModule(fixture.context, 'js/pmjs-pixi5/renderer.js');
  const app = new fixture.context.PIXI.Application({ width: 100, height: 50 });
  const source = { _nativeImage: { handle: 73 } };
  const texture = {
    baseTexture: { resource: { source }, width: 192, height: 192,
      resolution: 1, scaleMode: 0 },
    frame: { x: 0, y: 96, width: 96, height: 96 },
    trim: null,
    rotate: 0,
  };
  const tiling = new fixture.context.PIXI.TilingSprite(texture, 80, 40);
  app.stage.addChild(tiling);

  app.render();
  const packet = fixture.submissions[0];
  assert.equal(packet.metadata[2 * 7], 2);
  assert.equal(packet.metadata[2 * 7 + 2], 900);
  assert.equal(texture.__pmjsPixi5TilingCanvas.width, 96);
  assert.equal(texture.__pmjsPixi5TilingCanvas.height, 96);
  assert.deepEqual(texture.__pmjsPixi5TilingCanvas.drawCalls[0].slice(1),
    [0, 96, 96, 96, 0, 0, 96, 96]);
});

test('Pixi 5 tiling cache invalidates when its canvas source changes', () => {
  const fixture = createContext();
  runModule(fixture.context, 'js/pmjs-pixi5/scene.js');
  runModule(fixture.context, 'js/pmjs-pixi5/renderer.js');
  const app = new fixture.context.PIXI.Application({ width: 100, height: 50 });
  const source = { _nativeCanvas: { handle: 73 }, __pmjsContentRevision: 1,
    _ensureNativeCanvas() { return this._nativeCanvas; } };
  const texture = {
    baseTexture: { resource: { source }, width: 192, height: 192,
      resolution: 1, scaleMode: 0 },
    frame: { x: 0, y: 96, width: 96, height: 96 }, trim: null, rotate: 0,
  };
  app.stage.addChild(new fixture.context.PIXI.TilingSprite(texture, 80, 40));
  app.render();
  app.render();
  assert.equal(texture.__pmjsPixi5TilingCanvas.drawCalls.length, 1);
  source.__pmjsContentRevision++;
  app.render();
  assert.equal(texture.__pmjsPixi5TilingCanvas.drawCalls.length, 2);
});

test('Pixi 5 scene encoder omits non-drawable transform subtrees', () => {
  const fixture = createContext();
  runModule(fixture.context, 'js/pmjs-pixi5/scene.js');
  runModule(fixture.context, 'js/pmjs-pixi5/renderer.js');
  const app = new fixture.context.PIXI.Application({ width: 100, height: 50 });
  const collapsed = new fixture.context.PIXI.Container();
  collapsed.transform.localTransform.a = 0;
  collapsed.transform.localTransform.d = 0;
  const invalidChild = new fixture.context.PIXI.Container();
  invalidChild.transform.localTransform.tx = NaN;
  collapsed.addChild(invalidChild);
  app.stage.addChild(collapsed);

  assert.doesNotThrow(() => app.render());
  assert.equal(fixture.submissions[0].count, 2, 'background and stage only');
});

test('Pixi 5 renderer renders and extracts MZ RenderTexture canvases', () => {
  const fixture = createContext();
  runModule(fixture.context, 'js/pmjs-pixi5/scene.js');
  runModule(fixture.context, 'js/pmjs-pixi5/renderer.js');
  const app = new fixture.context.PIXI.Application({ width: 100, height: 50 });
  const renderTexture = { baseTexture: { width: 40, height: 30, resolution: 2 } };

  app.renderer.render(app.stage, renderTexture);
  const extracted = app.renderer.extract.canvas(renderTexture);

  assert.equal(extracted.width, 80);
  assert.equal(extracted.height, 60);
  assert.deepEqual(fixture.targets, [['size', 80, 60], ['render', 900]]);
  assert.equal(fixture.submissions[0].count, 2,
    'resolution transform and stage container');
  assert.equal(fixture.submissions[0].values[0], 2);
});
