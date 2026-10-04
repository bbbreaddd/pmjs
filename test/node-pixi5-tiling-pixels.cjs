'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const crypto = require('node:crypto');
const { createContext, runModule } = require('./helpers/pixi5-context.cjs');
const { tilingScenario } = require('./helpers/tiling-scenario.cjs');
const { png } = require('./helpers/png.cjs');
const native = require(path.resolve(process.argv[2])), assets = path.resolve(process.argv[3]);
const reference = require('./assets/reference/pixi5-tiling.json');
assert.equal(reference.pixi, '5.3.12');
assert.equal(reference.mipmap, 'OFF');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
assert.equal(hash(path.join(__dirname, 'helpers/tiling-scenario.cjs')), reference.scenarioSha256);
assert.equal(hash(path.join(__dirname, '../tools/generate-pixi5-tiling-reference.cjs')), reference.generatorSha256);
native.initialize({ gameRoot: assets, width: 32, height: 24, windowTitle: 'Pixi 5 tiling' });
const handles = new Set();
try {
  const { context: c } = createContext();
  c.NativeHost.render = native.render; c.NativeHost.scene.submit = native.scene.submit;
  Object.assign(c.NativeHost.scene.schema, native.scene.schema);
  c.CanvasElement = class {
    constructor() { this._width = 0; this._height = 0; this.__pmjsContentRevision = 0; }
    get width() { return this._width; }
    set width(value) { this._width = value; this._releaseNativeCanvas(); }
    get height() { return this._height; }
    set height(value) { this._height = value; this._releaseNativeCanvas(); }
    _ensureNativeCanvas() {
      if (!this._nativeCanvas) {
        this._nativeCanvas = native.canvas.create(this.width, this.height);
        handles.add(this._nativeCanvas.handle);
      }
      return this._nativeCanvas;
    }
    _releaseNativeCanvas() {
      if (!this._nativeCanvas) return;
      native.canvas.release(this._nativeCanvas.handle); handles.delete(this._nativeCanvas.handle);
      this._nativeCanvas = null;
    }
    _pmjsContentChanged() { this.__pmjsContentRevision++; }
    getContext() {
      return { drawImage: (source, ...args) => {
        const region = args.length === 8 ? args : [0, 0, source.width, source.height,
          args[0], args[1], source.width, source.height];
        native.canvas.drawImage(this._ensureNativeCanvas().handle,
          source._ensureNativeCanvas().handle, ...region, 1);
      } };
    }
  };
  c.PIXI.filters = { AlphaFilter: class {
    constructor(alpha = 1) { this.alpha = alpha; this.enabled = true; this.program = 'stock-alpha'; }
    apply() {}
  } };
  c.PIXI.Texture = class {
    constructor(baseTexture, frame) { Object.assign(this, { baseTexture, frame, valid: true }); }
    destroy(destroyBase) {
      if (destroyBase) throw new Error('this fixture retains the shared base');
      this.valid = false; this.baseTexture = null; this.frame = null;
    }
  };
  runModule(c, 'js/pmjs-core/methods.js');
  runModule(c, 'js/pmjs-pixi5/scene.js');
  runModule(c, 'js/pmjs-pixi5/filters.js');
  runModule(c, 'js/pmjs-pixi5/renderer.js');
  c.PMJS.methods.install();
  const renderer = new c.PIXI.Renderer({ width: 32, height: 24, transparent: true });
  const actual = tilingScenario({ capture(rgba, width, height, options) {
    const canvas = new c.CanvasElement(); canvas.width = width; canvas.height = height;
    native.canvas.writePixels(canvas._ensureNativeCanvas().handle, 0, 0, width, height, new Uint8Array(rgba));
    const texture = { valid: true,
      baseTexture: { resource: { source: canvas }, width, height, resolution: 1,
        scaleMode: options.linear ? c.PIXI.SCALE_MODES.LINEAR : c.PIXI.SCALE_MODES.NEAREST },
      frame: options.atlas ? { x: 2, y: 2, width: 3, height: 3 } : { x: 0, y: 0, width, height } };
    const stage = new c.PIXI.Container(), tiling = new c.PIXI.TilingSprite(texture, 20, 16);
    Object.assign(tiling.transform.localTransform, { tx: 8, ty: 6 });
    [tiling.anchor.x, tiling.anchor.y] = options.anchor || [0, 0];
    [tiling.tilePosition.x, tiling.tilePosition.y] = options.tilePosition || [0, 0];
    [tiling.tileScale.x, tiling.tileScale.y] = options.tileScale || [1, 1];
    [tiling.tileTransform.pivot.x, tiling.tileTransform.pivot.y] = options.pivot || [0, 0];
    tiling.uvRespectAnchor = !!options.uvRespectAnchor; stage.addChild(tiling);
    if (options.alpha !== undefined) {
      stage.filters = [new c.PIXI.filters.AlphaFilter(options.alpha)];
      stage.filterArea = new c.PIXI.Rectangle(0, 0, options.clip ? 18 : 32, options.clip ? 14 : 24);
    }
    native.beginFrame();
    if (options.repaint || options.reframe) {
      renderer.render(stage); native.renderScene();
      if (options.repaint) {
        const fill = Array.from({ length: width * height * 4 }, (_, i) => [40, 80, 160, 255][i % 4]);
        native.canvas.writePixels(canvas._ensureNativeCanvas().handle, 0, 0, width, height, new Uint8Array(fill));
        canvas._pmjsContentChanged();
      } else texture.frame = { x: 3, y: 1, width: 3, height: 3 };
      native.beginFrame();
    }
    if (options.snapshot) {
      const target = { baseTexture: { width: 32, height: 24, resolution: 1 } };
      renderer.render(stage, target);
      const source = renderer.extract.canvas(target), result = new c.PIXI.Sprite({
        baseTexture: { resource: { source }, resolution: 1 },
        frame: { x: 0, y: 0, width: 32, height: 24 } });
      result.anchor = { x: 0, y: 0 }; renderer.render(result);
    } else renderer.render(stage);
    native.renderScene();
    return Buffer.from(native.canvas.captureSceneRawPremultiplied());
  } });
  let failures = 0;
  assert.equal(actual.length, reference.rows.length);
  for (const [i, row] of actual.entries()) {
    const expected = Buffer.from(reference.rows[i].rgba, 'base64');
    assert.equal(row.label, reference.rows[i].label);
    let maxDelta = 0, outliers = 0;
    for (let p = 0; p < expected.length; p += 4) {
      const delta = Math.max(...[0, 1, 2, 3].map(ch => Math.abs(row.pixels[p + ch] - expected[p + ch])));
      maxDelta = Math.max(maxDelta, delta);
      if (delta > reference.rows[i].channelTolerance) outliers++;
    }
    if (outliers > reference.maxOutlierPixels) {
      failures++;
      const directory = path.join(assets, 'mismatches/pixi5-tiling'); fs.mkdirSync(directory, { recursive: true });
      for (const [name, pixels] of [['expected', expected], ['actual', row.pixels]]) {
        fs.writeFileSync(path.join(directory, row.label + '-' + name + '.png'), png(32, 24, pixels));
      }
    }
    console.log(row.label + ': delta=' + maxDelta + ' outlierPixels=' + outliers);
  }
  const source = new c.CanvasElement(); source.width = 8; source.height = 8;
  native.canvas.writePixels(source._ensureNativeCanvas().handle, 0, 0, 8, 8,
    new Uint8Array(Array.from({ length: 256 }, (_, i) => [40, 80, 160, 255][i % 4])));
  const texture = new c.PIXI.Texture({ resource: { source }, width: 8, height: 8, resolution: 1 },
    { x: 2, y: 2, width: 3, height: 3 });
  const retained = new c.PIXI.TilingSprite(texture, 20, 16);
  native.beginFrame(); renderer.render(retained);
  const crop = texture.__pmjsPixi5TilingCanvas, cropHandle = crop._nativeCanvas.handle;
  texture.destroy(false);
  assert.equal(crop._nativeCanvas, null, 'explicit Texture destruction releases PMJS crop ownership');
  assert.equal(texture.__pmjsPixi5TilingCanvas, undefined);
  assert.throws(() => native.canvas.readPixels(cropHandle, 0, 0, 1, 1), /invalid|unknown|not found/);
  assert.deepEqual(Array.from(native.canvas.readPixels(source._nativeCanvas.handle, 0, 0, 1, 1)), [40, 80, 160, 255]);
  native.renderScene();
  assert.deepEqual(Array.from(native.canvas.captureSceneRawPremultiplied().subarray(0, 4)), [40, 80, 160, 255],
    'a queued draw retains its pixels after crop ownership is released');
  assert.equal(native.scene.schema.clampedTilingSampling, true);
  const invalidMetadata = new Uint32Array([0, 0xffffffff, 0, 0xffffff, 0, 32768, 0]);
  const invalidValues = new Float32Array(41); invalidValues.set([1, 0, 0, 1, 0, 0, 1]);
  assert.throws(() => native.scene.submit(native.scene.schema.version, invalidMetadata, invalidValues, 1), /invalid|rejected/,
    'tiling clamp flags are rejected on another node kind');
  assert.equal(failures, 0, 'stock Pixi tiling pixel mismatches retained under test-assets/mismatches');
} finally {
  for (const handle of handles) native.canvas.release(handle);
  native.runtime.quit();
}
