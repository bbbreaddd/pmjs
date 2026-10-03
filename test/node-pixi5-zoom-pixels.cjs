'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const crypto = require('node:crypto');
const { createZoomContext } = require('./helpers/zoom-blur-context.cjs');
const { zoomBlurScenario } = require('./helpers/zoom-blur-scenario.cjs');
const { png } = require('./helpers/png.cjs');
const native = require(path.resolve(process.argv[2]));
const assets = path.resolve(process.argv[3]);
const reference = require('./assets/reference/pixi5-zoom-blur.json');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
assert.equal(hash(path.join(__dirname, 'helpers/zoom-blur-scenario.cjs')), reference.scenarioSha256);
assert.equal(hash(path.join(__dirname, 'assets/pixi-filters/zoom-blur-3.1.0.js')), reference.pluginSha256);
assert.equal(hash(path.join(__dirname, '../tools/generate-pixi5-zoom-reference.cjs')), reference.generatorSha256);
native.initialize({ gameRoot: assets, width: 32, height: 24, windowTitle: 'Pixi 5 ZoomBlur' });
const handles = new Set();
try {
  const f = createZoomContext(), c = f.context;
  c.NativeHost.render = native.render; c.NativeHost.scene.submit = native.scene.submit;
  Object.assign(c.NativeHost.scene.schema, native.scene.schema);
  c.CanvasElement = class {
    constructor() { this.width = 0; this.height = 0; }
    _ensureNativeCanvas() {
      if (!this._nativeCanvas) {
        this._nativeCanvas = native.canvas.create(this.width, this.height);
        handles.add(this._nativeCanvas.handle);
      }
      return this._nativeCanvas;
    }
    getContext() {
      return { drawImage: source => native.canvas.drawImage(this._ensureNativeCanvas().handle,
        source._ensureNativeCanvas().handle, 0, 0, source.width, source.height,
        0, 0, this.width, this.height, 1) };
    }
    _pmjsContentChanged() {}
  };
  const renderer = new c.PIXI.Renderer({ width: 32, height: 24, transparent: true });
  function sprite(canvas) {
    const s = new c.PIXI.Sprite({ baseTexture: { resource: { source: canvas }, resolution: 1 },
      frame: { x: 0, y: 0, width: 32, height: 24 }, orig: { width: 32, height: 24 } });
    s.anchor = { x: 0, y: 0 }; return s;
  }
  const actual = zoomBlurScenario({ capture(rgba, options, snapshot) {
    const canvas = new c.CanvasElement(); canvas.width = 32; canvas.height = 24;
    native.canvas.writePixels(canvas._ensureNativeCanvas().handle, 0, 0, 32, 24, rgba);
    const stage = new c.PIXI.Container(); stage.addChild(sprite(canvas));
    stage.filterArea = new c.PIXI.Rectangle(0, 0, 32, 24);
    stage.filters = [new c.PIXI.filters.ZoomBlurFilter(options)];
    if (options.alpha !== undefined) stage.filters.unshift(new c.PIXI.filters.AlphaFilter(options.alpha));
    native.beginFrame();
    if (snapshot) {
      const target = { baseTexture: { width: 32, height: 24, resolution: 1 } };
      renderer.render(stage, target);
      const result = new c.PIXI.Container(); result.addChild(sprite(renderer.extract.canvas(target)));
      renderer.render(result);
    } else renderer.render(stage);
    native.renderScene();
    return Buffer.from(native.canvas.captureSceneRawPremultiplied());
  } });
  assert.equal(actual.length, reference.rows.length);
  let failures = 0;
  for (const [index, row] of actual.entries()) {
    const expected = Buffer.from(reference.rows[index].rgba, 'base64');
    assert.equal(row.label, reference.rows[index].label);
    let maxDelta = 0, outliers = 0;
    for (let p = 0; p < expected.length; p += 4) {
      const delta = Math.max(...[0, 1, 2, 3].map(ch => Math.abs(row.pixels[p + ch] - expected[p + ch])));
      maxDelta = Math.max(maxDelta, delta);
      if (delta > reference.rows[index].channelTolerance) outliers++;
    }
    if (outliers > reference.maxOutlierPixels) {
      failures++;
      const directory = path.join(assets, 'mismatches/pixi5-zoom-blur'); fs.mkdirSync(directory, { recursive: true });
      for (const [name, pixels] of [['expected', expected], ['actual', row.pixels]]) {
        fs.writeFileSync(path.join(directory, row.label + '-' + name + '.png'), png(32, 24, pixels));
      }
    }
    console.log(row.label + ': delta=' + maxDelta + ' outlierPixels=' + outliers);
  }
  assert.equal(failures, 0, 'stock ZoomBlur pixel mismatches retained under test-assets/mismatches');
} finally {
  for (const handle of handles) native.canvas.release(handle);
  native.runtime.quit();
}
