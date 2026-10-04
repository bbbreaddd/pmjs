'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createContext, runModule } = require('./helpers/pixi5-context.cjs');

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

test('Pixi 5 scene installation preserves the shared namespace and other capabilities', () => {
  const fixture = createContext(), c = fixture.context;
  const extension = () => 'existing capability';
  const namespace = { extension };
  c.PMJS.pixi5 = namespace;
  runModule(c, 'js/pmjs-pixi5/scene.js');
  runModule(c, 'js/pmjs-pixi5/renderer.js');
  assert.equal(c.PMJS.pixi5, namespace);
  assert.equal(c.PMJS.pixi5.extension(), 'existing capability');
  const app = new c.PIXI.Application({ width: 32, height: 24 });
  app.render();
  assert.equal(fixture.submissions.length, 1);
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
  assert.equal(packet.version, 28);
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

test('rounded Pixi 5 sprites prepare world vertices while children retain local transforms', () => {
  const fixture = createContext();
  runModule(fixture.context, 'js/pmjs-pixi5/scene.js');
  runModule(fixture.context, 'js/pmjs-pixi5/renderer.js');
  const texture = {
    baseTexture: { resource: { source: { _nativeImage: { handle: 42 } } } },
    frame: { x: 0, y: 0, width: 8, height: 8 },
  };
  const sprite = new fixture.context.PIXI.Sprite(texture);
  sprite.roundPixels = true;
  sprite.alpha = 0.5;
  sprite.transform.localTransform.tx = 5.75;
  let preparations = 0;
  sprite.calculateVertices = function() {
    preparations++;
    this.vertexData = new Float32Array([-1, 5, 7, 5, 7, 13, -1, 13]);
  };
  const child = new fixture.context.PIXI.Sprite(texture);
  child.transform.localTransform.tx = 2.25;
  sprite.addChild(child);
  const renderer = new fixture.context.PIXI.Renderer({ width: 32, height: 32, resolution: 2 });
  renderer.render(sprite);
  const packet = fixture.submissions[0];
  const rows = Array.from({ length: packet.count }, (_, i) => ({
    metadata: Array.from(packet.metadata.subarray(i * 7, i * 7 + 7)),
    values: Array.from(packet.values.subarray(i * 41, i * 41 + 41)),
  }));
  const rounded = rows.find(row => row.metadata[5] & 4096);
  const parent = rows[rounded.metadata[1]];
  assert.equal(preparations, 1);
  assert.deepEqual(rounded.values.slice(0, 6), [-2, 10, 14, 10, 14, 26]);
  assert.deepEqual(rounded.values.slice(15, 17), [-2, 26]);
  assert.equal(rounded.values[6], 1, 'alpha is inherited once from the transform parent');
  assert.equal(parent.metadata[0], 0);
  assert.equal(parent.values[4], 5.75);
  assert.equal(parent.values[6], 0.5);
  const childRow = rows.at(-1);
  assert.equal(childRow.metadata[1], rounded.metadata[1]);
  assert.equal(childRow.values[4], 2.25);
  assert.equal(childRow.metadata[5] & 4096, 0);

  sprite.roundPixels = false;
  renderer.render(sprite);
  assert.equal(preparations, 1, 'unrounded sprites retain the existing encoding');
  sprite.roundPixels = true;
  sprite.calculateVertices = () => { throw Error('authored vertex failure'); };
  assert.throws(() => renderer.render(sprite), /authored vertex failure/);
  assert.equal(fixture.submissions.length, 2, 'failed preparation submits no partial scene');
});

test('Pixi 5 filter target discovery follows translated children', () => {
  const fixture = createContext();
  const { context } = fixture;
  context.PIXI.Graphics = class Graphics extends context.PIXI.Container {
    _render() {}
  };
  runModule(context, 'js/pmjs-pixi5/scene.js');
  runModule(context, 'js/pmjs-pixi5/renderer.js');
  context.pmjsPixi5RegisterFilterEncoder(() => ({ kind: 20, parameters: [0.5] }));
  const app = new context.PIXI.Application({ width: 100, height: 50 });
  app.stage.filters = [{}];
  assert.doesNotThrow(() => app.render());

  class TranslatedContainer extends context.PIXI.Container {}
  context.PMJS.pixi5.registerRenderContract(TranslatedContainer.prototype, {
    children: node => node.children.slice(0, 1).map(child => ({ node: child })),
  });
  const translated = new TranslatedContainer();
  translated.addChild(new context.PIXI.Container());
  translated.addChild(new context.PIXI.Graphics());
  translated.children[1]._render = () => {};
  app.stage.addChild(translated);
  assert.doesNotThrow(() => app.render());

  app.stage.addChild(translated.children[1]);
  translated.children[1].transform.localTransform.a = 0;
  translated.children[1].transform.localTransform.d = 0;
  assert.doesNotThrow(() => app.render(), 'collapsed subtrees do not reach a drawing producer');
  translated.children[1].transform.localTransform.a = 1;
  translated.children[1].transform.localTransform.d = 1;
  const submitted = fixture.submissions.length;
  assert.throws(() => app.render(), /render\.(render-method|graphics)/);
  assert.equal(fixture.submissions.length, submitted, 'reached unknown producers still reject before submission');
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

test('Pixi 5 tiling readiness omits invalid sampling without hiding children or later draws', () => {
  const fixture = createContext();
  const { context } = fixture;
  runModule(context, 'js/pmjs-pixi5/scene.js');
  runModule(context, 'js/pmjs-pixi5/renderer.js');
  const app = new context.PIXI.Application({ width: 100, height: 50 });
  const texture = {
    valid: true,
    baseTexture: { resource: { source: { _nativeImage: { handle: 73 } } },
      width: 4, height: 4, resolution: 1 },
    frame: { x: 0, y: 0, width: 4, height: 4 },
  };
  const tiling = new context.PIXI.TilingSprite(texture, 80, 40);
  const childTexture = { ...texture, baseTexture: {
    ...texture.baseTexture, resource: { source: { _nativeImage: { handle: 74 } } },
  } };
  tiling.addChild(new context.PIXI.Sprite(childTexture));
  app.stage.addChild(tiling);
  app.stage.addChild(new context.PIXI.Sprite(childTexture));
  function draw() {
    app.render();
    const packet = fixture.submissions.at(-1);
    assert.ok(Array.from(packet.values).every(Number.isFinite));
    return Array.from({ length: packet.count }, (_, i) =>
      packet.metadata[i * 7 + 2]).filter(Boolean);
  }
  for (const position of [{ x: NaN, y: NaN }, { x: Infinity, y: 0 },
    { x: 0, y: -Infinity }]) {
    const authored = { ...position };
    tiling.tilePosition = position;
    assert.deepEqual(draw(), [74, 74]);
    assert.equal(tiling.tilePosition, position, 'authored sampling state stays untouched');
    assert.deepEqual(position, authored);
  }
  tiling.tilePosition = { x: 3, y: -2 };
  texture.valid = false;
  assert.deepEqual(draw(), [74, 74], 'stock TilingSprite skips an invalid texture');
  texture.valid = true;
  assert.deepEqual(draw(), [73, 74, 74], 'the ready tiling leaf resumes before its children');
  const packet = fixture.submissions.at(-1);
  assert.equal(packet.values[2 * 41 + 9], -3);
  assert.equal(packet.values[2 * 41 + 10], 2);
  tiling.tilePosition.x = NaN;
  tiling._render = function() {};
  const submitted = fixture.submissions.length;
  assert.throws(() => app.render(), /render.render-method/);
  assert.equal(fixture.submissions.length, submitted,
    'invalid sampling must not conceal an unknown drawing producer');
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

test('MZ ColorFilter encloses its subtree and skips neutral or disabled filters', () => {
  const { context, submissions } = createContext();
  context.ColorFilter = function ColorFilter() {
    this.uniforms = { hue: 0, colorTone: [0, 0, 0, 0],
      blendColor: [0, 0, 0, 0], brightness: 255 };
  };
  runModule(context, 'js/pmjs-pixi5/scene.js');
  runModule(context, 'js/pmjs-mz/rendering.js');
  const stage = new context.PIXI.Container();
  const child = new context.PIXI.Container();
  stage.addChild(child);
  const filter = new context.ColorFilter();
  stage.filters = [filter];
  context.pmjsPixi5RenderScene(stage, null, 1);
  assert.equal(submissions.at(-1).count, 2);
  Object.assign(filter.uniforms, { hue: -120, colorTone: [-20, 30, 40, 100],
    blendColor: [80, 90, 100, 120], brightness: 180 });
  context.pmjsPixi5RenderScene(stage, null, 1);
  const packet = submissions.at(-1);
  assert.equal(packet.count, 4);
  assert.deepEqual([0, 1, 2, 3].map(i => packet.metadata[i * 7]), [6, 0, 0, 7]);
  assert.equal(packet.metadata[4], 30);
  assert.deepEqual(Array.from(packet.values.slice(7, 17)),
    [-120, -20, 30, 40, 100, 80, 90, 100, 120, 180]);
  const second = new context.ColorFilter();
  second.uniforms.brightness = 90;
  stage.filters = [filter, second];
  context.pmjsPixi5RenderScene(stage, null, 1);
  const chain = submissions.at(-1);
  assert.equal(chain.count, 6);
  assert.equal(chain.values[16], 90);
  assert.equal(chain.values[41 + 16], 180);
  stage.filters = [filter];
  filter.enabled = false;
  context.pmjsPixi5RenderScene(stage, null, 1);
  assert.equal(submissions.at(-1).count, 2);
});

test('Pixi 5 retains a neutral filter with a composite blend and rejects unsupported modes', () => {
  const { context, submissions } = createContext();
  const hits = [];
  const stockHit = context.PMJS.compat.hit;
  context.PMJS.compat.hit = (...args) => { hits.push(args); stockHit(...args); };
  runModule(context, 'js/pmjs-pixi5/scene.js');
  context.pmjsPixi5RegisterFilterEncoder(() => ({ kind: 20, parameters: [1], neutral: true }));
  const stage = new context.PIXI.Container();
  stage.filters = [{ blendMode: 1 }];
  context.pmjsPixi5RenderScene(stage, null, 1);
  assert.equal(submissions.at(-1).count, 3);
  assert.equal(submissions.at(-1).values[34], 1);
  stage.filters[0].blendMode = 1.5;
  assert.throws(() => context.pmjsPixi5RenderScene(stage, null, 1), /render.blend-mode/);
  assert.equal(submissions.length, 1);
  stage.filters[0].blendMode = 1;
  context.NativeHost.scene.schema.filterCompositeBlend = false;
  assert.throws(() => context.pmjsPixi5RenderScene(stage, null, 1), /render.filter-blend/);
  assert.deepEqual(hits.map(hit => hit[0]), ['render.blend-mode', 'render.filter-blend']);
});

test('MZ ColorFilter subclasses fall through to compatibility handling or another encoder', () => {
  const { context, submissions } = createContext();
  const hits = [];
  const stockHit = context.PMJS.compat.hit;
  context.PMJS.compat.hit = (...args) => { hits.push(args); stockHit(...args); };
  context.ColorFilter = class ColorFilter {};
  class CustomColorFilter extends context.ColorFilter {}
  runModule(context, 'js/pmjs-pixi5/scene.js');
  runModule(context, 'js/pmjs-mz/rendering.js');
  const stage = new context.PIXI.Container();
  stage.filters = [new CustomColorFilter()];
  assert.throws(() => context.pmjsPixi5RenderScene(stage, null, 1),
    /unsupported native capability: render.filter/);
  assert.equal(hits[0][0], 'render.filter');
  assert.equal(submissions.length, 0);
  context.pmjsPixi5RegisterFilterEncoder(filter =>
    filter instanceof CustomColorFilter ? { neutral: true } : null);
  assert.doesNotThrow(() => context.pmjsPixi5RenderScene(stage, null, 1));
  assert.equal(submissions.at(-1).count, 1);
});

test('MZ filter encoder tolerates an unavailable ColorFilter class', () => {
  const { context } = createContext();
  let encoder;
  context.pmjsPixi5RegisterFilterEncoder = callback => { encoder = callback; };
  runModule(context, 'js/pmjs-mz/rendering.js');
  assert.equal(encoder({}), null);
});

test('MZ rejects later filter drawing overrides before submitting a scene', () => {
  const { context, submissions } = createContext();
  const hits = [];
  const stockHit = context.PMJS.compat.hit;
  context.PMJS.compat.hit = (...args) => { hits.push(args); stockHit(...args); };
  context.ColorFilter = function ColorFilter() {
    this.uniforms = { hue: 0, colorTone: [0, 0, 0, 0],
      blendColor: [0, 0, 0, 0], brightness: 255 };
  };
  runModule(context, 'js/pmjs-pixi5/scene.js');
  runModule(context, 'js/pmjs-mz/rendering.js');
  context.ColorFilter.prototype.apply = function() {};
  const stage = new context.PIXI.Container();
  stage.filters = [new context.ColorFilter()];
  assert.throws(() => context.pmjsPixi5RenderScene(stage, null, 1), /render.filter/);
  assert.equal(hits[0][0], 'render.filter');
  assert.equal(submissions.length, 0);
});

test('Pixi 5 refuses an older native packet contract', () => {
  const { context } = createContext();
  context.NativeHost.scene.packetVersion = 27;
  context.NativeHost.scene.schema.version = 27;
  assert.throws(() => runModule(context, 'js/pmjs-pixi5/scene.js'), /scene schema/);
});

test('Pixi 5 rejects reached instance and late prototype drawing overrides before submission', () => {
  const fixture = createContext();
  const hits = [];
  const stockHit = fixture.context.PMJS.compat.hit;
  fixture.context.PMJS.compat.hit = (...args) => { hits.push(args); stockHit(...args); };
  runModule(fixture.context, 'js/pmjs-pixi5/scene.js');
  const stage = new fixture.context.PIXI.Container();
  const sprite = new fixture.context.PIXI.Sprite();
  stage.addChild(sprite);
  sprite._render = function customDrawing() {};
  assert.throws(() => fixture.context.pmjsPixi5RenderScene(stage, null, 1), /render.render-method/);
  assert.equal(fixture.submissions.length, 0);
  delete sprite._render;
  fixture.context.PIXI.Sprite.prototype.render = function laterDrawing() {};
  assert.throws(() => fixture.context.pmjsPixi5RenderScene(stage, null, 1), /render.render-method/);
  assert.equal(fixture.submissions.length, 0);
  assert.equal(hits.length, 2);
  sprite.visible = false;
  assert.doesNotThrow(() => fixture.context.pmjsPixi5RenderScene(stage, null, 1));
});

test('Pixi 5 RenderTexture backing is drawable and screen size survives offscreen failure', () => {
  const fixture = createContext();
  runModule(fixture.context, 'js/pmjs-pixi5/scene.js');
  runModule(fixture.context, 'js/pmjs-pixi5/renderer.js');
  const renderer = fixture.context.PIXI.Renderer.create({ width: 100, height: 50 });
  const stage = new fixture.context.PIXI.Container();
  const texture = { baseTexture: { width: 40, height: 30, resolution: 2 },
    frame: { x: 0, y: 0, width: 40, height: 30 }, orig: { width: 40, height: 30 } };
  renderer.render(stage, texture);
  const sprite = new fixture.context.PIXI.Sprite(texture);
  sprite.calculateVertices = function() {
    this.vertexData = new Float32Array([-20, -7.5, 20, -7.5, 20, 22.5, -20, 22.5]);
  };
  stage.addChild(sprite);
  renderer.render(stage);
  const packet = fixture.submissions.at(-1);
  const spriteIndex = Array.from({ length: packet.count }, (_, i) => i)
    .find(i => packet.metadata[i * 7] === 1);
  assert.equal(packet.metadata[spriteIndex * 7 + 2], 900);
  assert.equal(packet.metadata[spriteIndex * 7 + 5] & 4096, 4096);
  stage._render = function unknownDrawing() {};
  assert.throws(() => renderer.render(stage, texture), /render.render-method/);
  assert.deepEqual(fixture.sizes.at(-1), [100, 50]);
});

test('Pixi 5 tiling validates the renderer plugin and authored sampling before submission', () => {
  const f = createContext(), c = f.context;
  runModule(c, 'js/pmjs-pixi5/scene.js'); runModule(c, 'js/pmjs-pixi5/renderer.js');
  const app = new c.PIXI.Application({ width: 32, height: 24 });
  const texture = { valid: true, baseTexture: {
    resource: { source: { _nativeImage: { handle: 73 } } }, width: 4, height: 4 },
  frame: { x: 0, y: 0, width: 4, height: 4 } };
  const tiling = new c.PIXI.TilingSprite(texture, 20, 16); app.stage.addChild(tiling);
  for (const plugin of ['custom', 'batch', 'sprite', 'TilingSprite', undefined]) {
    tiling.pluginName = plugin; tiling.tilePosition.x = NaN;
    assert.throws(() => app.render(), /render.renderer-plugin/);
    assert.equal(f.submissions.length, 0, 'undefined sampling does not conceal a custom renderer');
  }
  tiling.pluginName = 'tilingSprite'; tiling.tilePosition.x = 0;
  const sprite = new c.PIXI.Sprite(texture); app.stage.addChild(sprite);
  for (const plugin of ['sprite', 'Batch', undefined]) {
    sprite.pluginName = plugin;
    assert.throws(() => app.render(), /render.renderer-plugin/);
    assert.equal(f.submissions.length, 0);
  }
  sprite.pluginName = 'batch';
  tiling.tileTransform.rotation = Math.PI / 2;
  assert.throws(() => app.render(), /render.tiling-transform/);
  tiling.tileTransform.rotation = 0; tiling.clampMargin = 0;
  assert.throws(() => app.render(), /render.tiling-clamp/);
  tiling.clampMargin = 0.5; tiling.uvMatrix = { clampOffset: 1 };
  assert.throws(() => app.render(), /render.tiling-clamp/);
  assert.equal(f.submissions.length, 0);
  tiling.uvMatrix.clampOffset = 0;
  app.render();
  assert.equal(f.submissions.at(-1).metadata[2 * 7], 2);
});

test('Pixi 5 tiling prepares pivot and anchor sampling and preserves small or collapsed scales', () => {
  const f = createContext(), c = f.context;
  runModule(c, 'js/pmjs-pixi5/scene.js'); runModule(c, 'js/pmjs-pixi5/renderer.js');
  const app = new c.PIXI.Application({ width: 32, height: 24 });
  const texture = { baseTexture: { resource: { source: { _nativeImage: { handle: 73 } } },
    width: 4, height: 4 }, frame: { x: 0, y: 0, width: 4, height: 4 } };
  const tiling = new c.PIXI.TilingSprite(texture, 20, 16); app.stage.addChild(tiling);
  tiling.addChild(new c.PIXI.Sprite(texture));
  tiling.tileTransform.pivot = { x: 1.5, y: 2 };
  tiling.anchor = { x: 0.25, y: 0.5 }; tiling.uvRespectAnchor = true;
  tiling.tileScale = { x: 2, y: 0.5 };
  app.render();
  assert.equal(f.submissions.at(-1).values[2 * 41 + 9], -1);
  assert.equal(f.submissions.at(-1).values[2 * 41 + 10], -14);
  tiling.tileScale.x = 0;
  app.render();
  assert.equal(f.submissions.at(-1).metadata[2 * 7], 0);
  assert.equal(f.submissions.at(-1).metadata[3 * 7], 1, 'collapsed UVs retain drawable children');
  assert.equal(tiling.tileScale.x, 0);
  tiling.tileScale.x = 1e-7;
  app.render();
  assert.equal(f.submissions.at(-1).values[2 * 41 + 11], 200000000,
    'a small finite scale is not replaced with scale one');
});

test('Pixi 5 cropped tiling backing follows Texture destruction and explicit frame replacement', () => {
  const f = createContext(), c = f.context;
  c.PIXI.Texture = function Texture() {};
  c.PIXI.Texture.prototype.destroy = function(destroyBase) {
    this.valid = false; this.baseDestroyed = destroyBase; return 'authored-destroy';
  };
  runModule(c, 'js/pmjs-core/methods.js');
  runModule(c, 'js/pmjs-pixi5/scene.js'); runModule(c, 'js/pmjs-pixi5/renderer.js');
  // A later authored wrapper must still run with its arguments and return value.
  const original = c.PIXI.Texture.prototype.destroy;
  c.PIXI.Texture.prototype.destroy = function(...args) { this.destroyCalls = (this.destroyCalls || 0) + 1; return original.apply(this, args); };
  c.PMJS.methods.install();
  const app = new c.PIXI.Application({ width: 32, height: 24 });
  const source = { _nativeImage: { handle: 73 } };
  const texture = Object.assign(new c.PIXI.Texture(), { valid: true,
    baseTexture: { resource: { source }, width: 8, height: 8 },
    frame: { x: 2, y: 2, width: 3, height: 3 } });
  const sprite = new c.PIXI.TilingSprite(texture, 20, 16); app.stage.addChild(sprite);
  app.render(); const first = texture.__pmjsPixi5TilingCanvas;
  app.stage.children.length = 0;
  app.renderer.destroy();
  assert.equal(first.released, undefined, 'display removal and renderer destruction do not destroy a retained Texture');
  const next = new c.PIXI.Application({ width: 32, height: 24 }); next.stage.addChild(sprite);
  next.render(); assert.equal(texture.__pmjsPixi5TilingCanvas, first);
  texture.frame = { x: 0, y: 0, width: 8, height: 8 }; next.render();
  assert.equal(first.released, true, 'full-frame replacement retires only the PMJS crop');
  texture.frame = { x: 1, y: 1, width: 3, height: 3 }; next.render();
  const second = texture.__pmjsPixi5TilingCanvas;
  assert.notEqual(first, second);
  assert.equal(texture.destroy(false), 'authored-destroy');
  assert.equal(texture.destroyCalls, 1); assert.equal(texture.baseDestroyed, false);
  assert.equal(second.released, true); assert.equal(texture.__pmjsPixi5TilingCanvas, undefined);
  assert.equal(source._nativeImage.handle, 73, 'the shared authored source is not released');
});

for (const strictCompatibility of [false, true]) {
  test('Pixi 5 compatibility policy preserves legal drawing or fails strictly (' + strictCompatibility + ')', () => {
    for (const failure of ['filter', 'mask', 'renderer', 'render-method', 'tiling-transform']) {
      const f = createContext({ strictCompatibility }), c = f.context;
      runModule(c, 'js/pmjs-pixi5/scene.js'); runModule(c, 'js/pmjs-pixi5/renderer.js');
      const texture = { baseTexture: { resource: { source: { _nativeImage: { handle: 73 } } },
        width: 4, height: 4 }, frame: { x: 0, y: 0, width: 4, height: 4 } };
      const app = new c.PIXI.Application({ width: 32, height: 24 });
      const leaf = failure === 'tiling-transform' ? new c.PIXI.TilingSprite(texture, 20, 16) : new c.PIXI.Sprite(texture);
      const child = new c.PIXI.Sprite(texture), sibling = new c.PIXI.Sprite(texture);
      leaf.addChild(child); app.stage.addChild(leaf); app.stage.addChild(sibling);
      if (failure === 'filter') {
        leaf.filters = [{ enabled: true }];
        leaf.filterArea = new c.PIXI.Rectangle(1, 2, 3, 4);
      } else if (failure === 'mask') leaf.mask = {};
      else if (failure === 'renderer') leaf.pluginName = 'custom';
      else if (failure === 'render-method') leaf._render = () => {};
      else leaf.tileTransform.rotation = Math.PI / 4;
      const filters = leaf.filters, parent = child.parent;
      if (strictCompatibility) {
        assert.throws(() => app.render(), /unsupported native capability: render\./);
        assert.equal(f.submissions.length, 0);
      } else {
        assert.doesNotThrow(() => app.render());
        const packet = f.submissions.at(-1);
        const resources = Array.from({ length: packet.count }, (_, i) => packet.metadata[i * 7 + 2]).filter(Boolean);
        assert.deepEqual(resources, failure === 'filter' ? [73, 73, 73] : [73, 73]);
        assert.ok(Array.from(packet.values).every(Number.isFinite));
        assert.ok(Array.from({ length: packet.count }, (_, i) => packet.metadata[i * 7 + 5]).every(flags => !(flags & 1)),
          'an unsupported filter does not apply its filter-area clip');
      }
      assert.equal(c.PMJS.compat.count('render.'), 1);
      assert.equal(child.parent, parent); assert.equal(leaf.filters, filters);
    }
  });
}

test('production Pixi 5 rendering leaves authored errors and native submission errors visible', () => {
  const f = createContext({ strictCompatibility: false }), c = f.context;
  runModule(c, 'js/pmjs-pixi5/scene.js'); runModule(c, 'js/pmjs-pixi5/renderer.js');
  const app = new c.PIXI.Application({ width: 32, height: 24 });
  app.stage.updateTransform = () => { throw new Error('authored update'); };
  assert.throws(() => app.render(), /authored update/);
  delete app.stage.updateTransform;
  c.NativeHost.scene.submit = () => false;
  assert.throws(() => app.render(), /scene submission rejected/);
  assert.equal(c.PMJS.compat.count('render.'), 0);
});
