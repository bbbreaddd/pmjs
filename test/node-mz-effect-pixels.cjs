'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { createMzContext, runModule } = require('./helpers/mz-context.cjs');
const { effectPixelScenario } = require('./helpers/effect-pixel-scenario.cjs');
const { writeEffectFixtures } = require('./effect-fixtures.cjs');
const { png } = require('./helpers/png.cjs');
const native = require(path.resolve(process.argv[2]));
const assetRoot = path.resolve(process.argv[3]);
const referenceRoot = path.join(__dirname, 'assets/reference/mz-effects');
const reference = JSON.parse(fs.readFileSync(path.join(referenceRoot, 'provenance.json')));
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
assert.equal(hash(path.join(__dirname, 'helpers/effect-pixel-scenario.cjs')), reference.scenarioSha256);
assert.equal(hash(path.join(referenceRoot, reference.audio.file)), reference.audio.sha256);
assert.equal(hash(path.join(__dirname, '../tools/generate-mz-effect-reference.cjs')), reference.generatorSha256);
assert.equal(hash(path.join(__dirname, 'effect-fixtures.cjs')), reference.fixtureGeneratorSha256);
assert.equal(hash(path.join(__dirname, 'helpers/png.cjs')), reference.pngEncoderSha256);
writeEffectFixtures(assetRoot);
assert.equal(hash(path.join(assetRoot, 'effects/Model/block.efkmodel')), reference.modelSha256);
native.initialize({ gameRoot: assetRoot, width: 64, height: 64, windowTitle: 'MZ renderer families' });

async function verify() {
  const f = createMzContext();
  const { context } = f;
  // Independent bounds for this fixture's unrotated containers and sprites.
  context.PIXI.Container.prototype.getBounds = function() {
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    function collect(node, x, y) {
      const transform = node.transform.localTransform;
      x += transform.tx; y += transform.ty;
      if (node.texture) {
        const frame = node.texture.orig;
        const startX = x - node.anchor.x * frame.width;
        const startY = y - node.anchor.y * frame.height;
        left = Math.min(left, startX); top = Math.min(top, startY);
        right = Math.max(right, startX + frame.width); bottom = Math.max(bottom, startY + frame.height);
      }
      node.children.forEach(child => collect(child, x, y));
    }
    collect(this, 0, 0);
    return Number.isFinite(left) ? new context.PIXI.Rectangle(left, top, right - left, bottom - top) :
      new context.PIXI.Rectangle(0, 0, 0, 0);
  };
  context.NativeHost.effects = native.effects;
  context.NativeHost.render = native.render;
  Object.assign(context.NativeHost.scene.schema, native.scene.schema);
  context.NativeHost.scene.submit = native.scene.submit;
  const canvases = new Set();
  class Canvas {
    constructor() { this.width = 0; this.height = 0; }
    _ensureNativeCanvas() {
      if (!this._nativeCanvas) {
        this._nativeCanvas = native.canvas.create(this.width, this.height);
        canvases.add(this._nativeCanvas.handle);
      }
      return this._nativeCanvas;
    }
    getContext() {
      return { drawImage: source => {
        native.canvas.drawImage(this._ensureNativeCanvas().handle, source._ensureNativeCanvas().handle,
          0, 0, source.width, source.height, 0, 0, this.width, this.height, 1);
      } };
    }
    _pmjsContentChanged() {}
  }
  context.CanvasElement = Canvas;
  context.PIXI.filters = { AlphaFilter: class {
    constructor(alpha = 1) { this.alpha = alpha; this.program = 'alpha'; }
    apply() {}
  } };
  runModule(context, 'js/pmjs-pixi5/filters.js');
  runModule(context, 'js/pmjs-mz/effects.js');
  // Independent producer implementing the stock viewport/projection/reset contract.
  context.Sprite_Animation.prototype._render = function(renderer) {
    renderer.batch.flush(); renderer.geometry.reset();
    const fx = context.Graphics.effekseer;
    fx.setProjectionMatrix([this._mirror ? -1 : 1, 0, 0, 0, 0, -1, 0, 0,
      0, 0, 1, -4096 / renderer.view.height, 0, 0, 0, 1]);
    fx.setCameraMatrix([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -10, 1]);
    const target = this._targets[0];
    renderer.gl.viewport(target.x - 2048, target.y - 2048, 4096, 4096);
    fx.beginDraw(); fx.drawHandle(this._handle); fx.endDraw();
    renderer.gl.viewport(0, 0, renderer.view.width, renderer.view.height);
    renderer.texture.reset(); renderer.geometry.reset(); renderer.state.reset();
    renderer.shader.reset(); renderer.framebuffer.reset();
  };
  runModule(context, 'js/pmjs-mz/animations.js');
  context.PMJS.methods.install();
  const renderer = new context.PIXI.Renderer({ width: 64, height: 64, transparent: true });
  const fx = context.effekseer.createContext(); fx.init();
  context.Graphics.effekseer = fx;
  const factory = {
    container: () => new context.PIXI.Container(),
    rectangle: (...args) => new context.PIXI.Rectangle(...args),
    alpha: value => new context.PIXI.filters.AlphaFilter(value),
    move(target, x, y) {
      Object.assign(target, { x, y });
      Object.assign(target.transform.localTransform, { tx: x, ty: y });
    },
    solid(width, height, color, x, y) {
      const canvas = native.canvas.create(width, height); canvases.add(canvas.handle);
      const rgba = Buffer.from(color.slice(1), 'hex');
      const pixels = Buffer.alloc(width * height * 4);
      for (let i = 0; i < pixels.length; i += 4) pixels.set([...rgba, 255], i);
      native.canvas.writePixels(canvas.handle, 0, 0, width, height, pixels);
      const sprite = f.sprite(canvas.handle, x, y, width, height);
      Object.assign(sprite, { x, y });
      return sprite;
    },
    animation(handle, target) {
      const animation = new context.Sprite_Animation();
      // Stock Sprite_Animation's zero-sized sprite still contributes its origin to parent bounds.
      animation.texture = { orig: { width: 0, height: 0 } };
      animation.anchor = { x: 0, y: 0 };
      animation._handle = handle; animation._targets = [target];
      return animation;
    }
  };
  function capture(stage) {
    native.beginFrame(); renderer.render(stage); native.renderScene();
    return Array.from(native.canvas.captureSceneRawPremultiplied());
  }
  const fixture = { factory, fx, capture,
    scale: name => reference.effects[name].handleScale || 1,
    rotation: name => reference.effects[name].rotationX || 0,
    dynamic: name => !!reference.effects[name].dynamic,
    trigger: name => reference.effects[name].trigger,
    seek: name => !!reference.effects[name].seek,
    async load(name) {
      const entry = reference.effects[name];
      const file = path.join(assetRoot, 'effects', entry.file);
      assert.equal(hash(file), entry.sha256);
      const effect = fx.loadEffect('effects/' + entry.file, entry.scale);
      await Promise.resolve(); assert.equal(effect.isLoaded, true);
      return effect;
    },
    snapshot(stage, width, height) {
      const texture = { baseTexture: { width, height, resolution: 1 } };
      native.beginFrame(); renderer.render(stage, texture);
      const canvas = renderer.extract.canvas(texture);
      const presentation = factory.container();
      presentation.addChild(f.sprite(canvas._ensureNativeCanvas().handle, 0, 0, width, height));
      return capture(presentation);
    }
  };
  try {
    const failures = [];
    const captured = {};
    for (const name of Object.keys(reference.effects)) {
      const frames = await effectPixelScenario(fixture, name);
      captured[name] = Object.fromEntries(frames.map(frame => [frame.label, frame.pixels]));
      const expected = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(referenceRoot, name + '.json.gz'))));
      assert.equal(frames.length, expected.length);
      for (let i = 0; i < frames.length; i++) {
        assert.equal(frames[i].label, expected[i].label);
        const actual = Buffer.from(frames[i].pixels);
        const stock = Buffer.from(expected[i].rgba, 'base64');
        assert.equal(actual.length, 64 * 64 * 4);
        assert.equal(stock.length, actual.length);
        let maxDelta = 0, outliers = 0;
        for (let j = 0; j < actual.length; j += 4) {
          let delta = 0;
          for (let channel = 0; channel < 4; channel++) delta = Math.max(delta, Math.abs(actual[j + channel] - stock[j + channel]));
          maxDelta = Math.max(maxDelta, delta);
          if (delta > reference.channelTolerance) outliers++;
        }
        if (outliers > reference.maxOutlierPixels) {
          const output = path.join(assetRoot, 'mismatches/mz-effects', name);
          fs.mkdirSync(output, { recursive: true });
          fs.writeFileSync(path.join(output, frames[i].label + '-actual.png'), png(64, 64, actual));
          fs.writeFileSync(path.join(output, frames[i].label + '-expected.png'), png(64, 64, stock));
          const diff = Buffer.alloc(actual.length);
          for (let j = 0; j < diff.length; j += 4) {
            for (let channel = 0; channel < 3; channel++) diff[j + channel] = Math.min(255, Math.abs(actual[j + channel] - stock[j + channel]) * 8);
            diff[j + 3] = 255;
          }
          fs.writeFileSync(path.join(output, frames[i].label + '-diff.png'), png(64, 64, diff));
          fs.writeFileSync(path.join(output, frames[i].label + '.json'), JSON.stringify({ maxDelta, outliers }));
        }
        if (outliers > reference.maxOutlierPixels) failures.push({ name, frame: frames[i].label, maxDelta, outliers });
      }
      const restored = frames.find(frame => frame.label === 'restored').pixels;
      const retained = frames.find(frame => frame.label === 'cache-release').pixels;
      if (JSON.stringify(restored) === JSON.stringify(frames.at(-1).pixels)) {
        failures.push({ name, message: 'fixture must draw visible particles' });
      }
      assert.deepEqual(restored, retained, 'cache release must retain particle drawing');
      assert.deepEqual(captured[name].transparent, captured[name].hidden,
        'zero-alpha particles must draw the same pixels as hidden particles');
      assert.notDeepEqual(captured[name].color, captured[name].transparent,
        'color controls must change visible particles');
      console.log(name + ': ' + frames.length + ' stock-reference frames compared');
    }
    assert.notDeepEqual(captured.Dynamic['frame-6'], captured.Dynamic['dynamic-input'],
      'authored dynamic inputs must move particles');
    assert.deepEqual(captured.Dynamic['frame-6'], captured.Dynamic['dynamic-restored'],
      'restoring authored inputs must restore the static fixture');
    assert.deepEqual(captured.Trigger['unrelated-trigger'], captured.TriggerIdle['unrelated-trigger']);
    assert.notDeepEqual(captured.Trigger['frame-22'], captured.TriggerIdle['frame-22'],
      'the authored trigger must change particle generation');
    assert.notDeepEqual(captured.Laser['seek-backward'], captured.Laser['seek-forward'],
      'frame seeking must change animated geometry');
    assert.deepEqual(failures, [], 'stock particle pixel comparisons');
    assert.deepEqual(f.hits, []);
  } finally {
    context.effekseer.releaseContext(fx);
    for (const canvas of canvases) native.canvas.release(canvas);
  }
  assert.deepEqual(native.effects.counts(), { contexts: 0, effects: 0, handles: 0, voices: 0 });
}
verify().catch(error => { console.error(error); process.exitCode = 1; })
  .finally(() => native.runtime.quit());
