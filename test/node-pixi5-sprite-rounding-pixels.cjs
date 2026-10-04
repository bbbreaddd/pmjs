'use strict';

const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const crypto = require('node:crypto'), zlib = require('node:zlib');
const { createMzContext, runModule } = require('./helpers/mz-context.cjs');
const { spriteRoundingCases, spriteRoundingPixels } = require('./helpers/sprite-rounding-scenario.cjs');
const stockVertices = require('./assets/pixi5/sprite-vertices-5.3.12.cjs');
const { png } = require('./helpers/png.cjs');
const reference = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, 'assets/reference/pixi5-sprite-rounding.json.gz'))));
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, file))).digest('hex');
assert.equal(reference.pixi, '5.3.12');
assert.equal(hash('helpers/sprite-rounding-scenario.cjs'), reference.scenarioSha256);
assert.equal(hash('../tools/generate-pixi5-sprite-rounding-reference.cjs'), reference.generatorSha256);
assert.equal(hash('assets/pixi5/sprite-vertices-5.3.12.cjs'), reference.vertexFixtureSha256);
const native = require(path.resolve(process.argv[2])), assets = path.resolve(process.argv[3]);
native.initialize({ gameRoot: assets, width: 32, height: 32, windowTitle: 'Pixi 5 sprite rounding' });
const handles = [], renderers = [];
try {
  const { context: c } = createMzContext();
  c.NativeHost.render = native.render; c.NativeHost.scene.submit = native.scene.submit;
  Object.assign(c.NativeHost.scene.schema, native.scene.schema);
  c.PIXI.settings = { RESOLUTION: 1, PRECISION_FRAGMENT: 'mediump' };
  c.PIXI.Sprite.prototype.calculateVertices = stockVertices(c.PIXI.settings);
  c.PIXI.filters = { AlphaFilter: class {
    constructor(alpha) { this.alpha = alpha; this.enabled = true; this.program = 'stock-alpha'; }
    apply() {}
  } };
  c.CanvasElement = class {
    constructor() { this.width = 0; this.height = 0; }
    _ensureNativeCanvas() {
      if (!this._nativeCanvas) {
        this._nativeCanvas = native.canvas.create(this.width, this.height);
        handles.push(this._nativeCanvas.handle);
      }
      return this._nativeCanvas;
    }
    _pmjsContentChanged() {}
    getContext() {
      return { fillRect: () => native.canvas.writePixels(this._ensureNativeCanvas().handle,
        0, 0, 1, 1, Uint8Array.of(255, 255, 255, 255)) };
    }
  };
  let transformId = 0;
  function updateWorld(node, parent = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 }) {
    const m = node.transform.localTransform;
    const world = node.transform.worldTransform = {
      a: parent.a * m.a + parent.c * m.b, b: parent.b * m.a + parent.d * m.b,
      c: parent.a * m.c + parent.c * m.d, d: parent.b * m.c + parent.d * m.d,
      tx: parent.a * m.tx + parent.c * m.ty + parent.tx,
      ty: parent.b * m.tx + parent.d * m.ty + parent.ty,
    };
    node.transform._worldID = ++transformId;
    for (const child of node.children) updateWorld(child, world);
  }
  c.PIXI.Container.prototype.updateTransform = function() { updateWorld(this); };
  function place(node, x, y = x, scaleX = 1, scaleY = scaleX, rotation = 0) {
    Object.assign(node.transform.localTransform, { a: Math.cos(rotation) * scaleX,
      b: Math.sin(rotation) * scaleX, c: -Math.sin(rotation) * scaleY,
      d: Math.cos(rotation) * scaleY, tx: x, ty: y });
  }
  function sprite(texture, rounded = false, anchor = 0) {
    const node = new c.PIXI.Sprite(texture);
    node._texture = texture; node._anchor = { _x: anchor, _y: anchor };
    node.anchor = { x: anchor, y: anchor }; node._roundPixels = node.roundPixels = rounded;
    node._transformID = node._textureID = -1; node.vertexData = new Float32Array(8);
    return node;
  }
  runModule(c, 'js/pmjs-pixi5/filters.js');
  runModule(c, 'js/pmjs-mz/display.js');
  const sources = new Map();
  let failures = 0;
  const cases = spriteRoundingCases(); assert.equal(cases.length, reference.rows.length);
  for (const [i, spec] of cases.entries()) {
    c.PIXI.settings.RESOLUTION = spec.settingsResolution;
    const width = spec.sourceWidth || 8, height = spec.sourceHeight || 8;
    const key = `${width}x${height}`;
    if (!sources.has(key)) {
      const source = native.canvas.create(width, height); handles.push(source.handle);
      native.canvas.writePixels(source.handle, 0, 0, width, height, spriteRoundingPixels(width, height));
      sources.set(key, source);
    }
    const base = { resource: { source: { _nativeCanvas: sources.get(key) } },
      scaleMode: c.PIXI.SCALE_MODES.NEAREST };
    base.resolution = spec.textureResolution;
    const renderer = new c.PIXI.Renderer({ width: 32, height: 32, resolution: spec.resolution, transparent: true });
    renderers.push(renderer);
    const extentX = width / spec.textureResolution, extentY = height / spec.textureResolution;
    const swap = (spec.atlasRotation || 0) % 4 === 2;
    const texture = { baseTexture: base, _updateID: 0, _uvs: { uvsFloat32: new Float32Array(8) },
      frame: { x: 0, y: 0, width: extentX, height: extentY }, rotate: spec.atlasRotation || 0,
      orig: { width: spec.logicalWidth || (spec.trim ? 16 : swap ? extentY : extentX),
        height: spec.logicalHeight || (spec.trim ? 16 : swap ? extentX : extentY) },
      trim: spec.trim ? { x: 3, y: 2, width: 8, height: 8 } : null };
    const stage = new c.PIXI.Container(), parent = new c.PIXI.Container(); stage.addChild(parent);
    if (spec.parent) place(parent, 2.25, 3.75, 1.25, 0.8, 0.2);
    const node = sprite(texture, spec.rounded, spec.anchor); parent.addChild(node);
    place(node, spec.position, spec.position, spec.scale, spec.scale, spec.rotation);
    node.alpha = spec.alpha === undefined ? 1 : spec.alpha;
    if (spec.screen) {
      parent.children.length = 0;
      const screen = new c.ScreenSprite(), graphics = screen._graphics;
      parent.addChild(screen); screen.setColor(255, 0, 0);
      if (spec.screen === 'invisible') graphics.visible = false;
      if (spec.screen === 'unrenderable') graphics.renderable = false;
      if (spec.screen === 'alpha') { screen.alpha = 0.5; graphics.alpha = 0.5; }
      if (spec.screen === 'color') graphics.clear().beginFill(0x00ff00).drawRect(-50000, -50000, 100000, 100000);
      if (spec.screen === 'shape' || spec.screen === 'transform') graphics.clear().beginFill(0xff0000).drawRect(4, 5, 16, 17);
      if (spec.screen === 'transform') place(graphics, 2.25, 1.75, 0.8, 0.7, 0.2);
      if (spec.screen === 'tint') graphics.tint = 0x808080;
      if (spec.screen === 'fill-alpha') graphics.clear().beginFill(0xff0000, 0.5).drawRect(-50000, -50000, 100000, 100000);
      if (spec.screen === 'empty') graphics.clear();
      if (spec.screen === 'removed') screen.children.length = 0;
      if (spec.screen === 'filter') { graphics.filters = [new c.PIXI.filters.AlphaFilter(0.5)]; graphics.filterArea = new c.PIXI.Rectangle(4, 5, 16, 17); }
    }
    if (spec.child) {
      const child = sprite(texture, !!spec.childRounded);
      place(child, 7.25, -3.75, 0.5); node.addChild(child);
    }
    if (spec.clip) { stage.filters = [new c.PIXI.filters.AlphaFilter(0.5)]; stage.filterArea = new c.PIXI.Rectangle(0, 0, 24, 24); }
    const after = sprite(texture); place(after, 1, 27, 0.5); stage.addChild(after);
    native.beginFrame();
    if (spec.snapshot) {
      const target = { baseTexture: { width: 32, height: 32, resolution: spec.resolution } };
      renderer.render(stage, target);
      const snapshot = sprite({ baseTexture: target.baseTexture, _updateID: 0,
        _uvs: { uvsFloat32: new Float32Array(8) }, orig: { width: 32, height: 32 },
        frame: { x: 0, y: 0, width: 32, height: 32 } });
      renderer.render(snapshot);
    } else renderer.render(stage);
    native.renderScene();
    const actual = native.canvas.captureSceneRawPremultiplied(), expectedRow = reference.rows[i];
    assert.equal(spec.label, expectedRow.label);
    const expected = Buffer.from(expectedRow.rgba, 'base64'); assert.equal(actual.length, expected.length);
    let maxDelta = 0, outliers = 0;
    for (let p = 0; p < expected.length; p += 4) {
      const delta = Math.max(...[0, 1, 2, 3].map(channel => Math.abs(actual[p + channel] - expected[p + channel])));
      maxDelta = Math.max(maxDelta, delta); if (delta > reference.channelTolerance) outliers++;
    }
    if (outliers > reference.maxOutlierPixels) {
      failures++;
      const directory = path.join(assets, 'mismatches/pixi5-sprite-rounding'); fs.mkdirSync(directory, { recursive: true });
      for (const [name, pixels] of [['expected', expected], ['actual', actual]]) {
        fs.writeFileSync(path.join(directory, spec.label + '-' + name + '.png'), png(32 * spec.resolution, 32 * spec.resolution, pixels));
      }
    }
    console.log(spec.label + ': delta=' + maxDelta + ' outlierPixels=' + outliers);
  }
  assert.equal(failures, 0, 'stock sprite rounding mismatches retained under test-assets/mismatches');
} finally {
  for (const renderer of renderers) renderer.destroy();
  for (const handle of handles) native.canvas.release(handle);
  native.runtime.quit();
}
