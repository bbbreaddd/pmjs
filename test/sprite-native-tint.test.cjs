'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const runtimeRoot = path.resolve(__dirname, '..');
const optimizationsSource = fs.readFileSync(
  path.join(runtimeRoot, 'js/pmjs-core/optimizations.js'), 'utf8');
const rendererSource = fs.readFileSync(
  path.join(runtimeRoot, 'js/pmjs-mv/renderer.js'), 'utf8');

function setupEnvironment({ config = {}, env = {}, beforeInstall } = {}) {
  const context = {
    console: { log() {} },
    PMJS_GAME_CONFIG: config,
    NativeHost: {
      runtime: {
        env(name) { return env[name]; }
      }
    },
    Graphics: {
      _renderer: null,
      _createRenderer() {},
      render() {},
      width: 640,
      height: 480
    },
    Utils: {
      isOptionValid() { return false; }
    },
    PIXI: {
      DisplayObject: function DisplayObject() {},
      BaseTexture: function BaseTexture(source) {
        this.source = source;
        this.width = source ? (source.width || 0) : 0;
        this.height = source ? (source.height || 0) : 0;
        this.scaleMode = 0;
      },
      particles: {
        ParticleContainer: function ParticleContainer() {}
      }
    }
  };

  context.Rectangle = function Rectangle(x, y, width, height) {
    this.x = x || 0;
    this.y = y || 0;
    this.width = width || 0;
    this.height = height || 0;
  };
  context.Rectangle.emptyRectangle = new context.Rectangle(0, 0, 0, 0);

  context.Bitmap = function Bitmap(w, h) {
    this.width = w || 0;
    this.height = h || 0;
    this.baseTexture = new context.PIXI.BaseTexture(this);
    this.canvas = {};
  };

  context.Sprite = function Sprite(bitmap) {
    this._bitmap = bitmap || null;
    this._frame = new context.Rectangle(0, 0, bitmap ? bitmap.width : 0, bitmap ? bitmap.height : 0);
    this._realFrame = new context.Rectangle();
    this.pivot = { x: 0, y: 0 };
    this.texture = {
      baseTexture: bitmap ? bitmap.baseTexture : null,
      frame: context.Rectangle.emptyRectangle,
      _updateID: 0
    };
    this._colorTone = [0, 0, 0, 0];
    this._blendColor = [0, 0, 0, 0];
    this.executeTintCalls = 0;
  };

  context.Sprite.prototype._needsTint = function() {
    var tone = this._colorTone;
    return tone[0] || tone[1] || tone[2] || tone[3] || this._blendColor[3] > 0;
  };

  context.Sprite.prototype._createTinter = function(w, h) {
    this._tintTexture = new context.PIXI.BaseTexture({ width: w, height: h });
    this._tintTexture.update = function() {};
  };

  context.Sprite.prototype._executeTint = function(x, y, w, h) {
    this.executeTintCalls++;
  };

  context.Sprite.prototype._refresh = function() {
    var frameX = Math.floor(this._frame.x);
    var frameY = Math.floor(this._frame.y);
    var frameW = Math.floor(this._frame.width);
    var frameH = Math.floor(this._frame.height);
    var bitmapW = this._bitmap ? this._bitmap.width : 0;
    var bitmapH = this._bitmap ? this._bitmap.height : 0;
    var realX = Math.min(Math.max(frameX, 0), bitmapW);
    var realY = Math.min(Math.max(frameY, 0), bitmapH);
    var realW = Math.min(Math.max(frameW - realX + frameX, 0), bitmapW - realX);
    var realH = Math.min(Math.max(frameH - realY + frameY, 0), bitmapH - realY);

    this._realFrame.x = realX;
    this._realFrame.y = realY;
    this._realFrame.width = realW;
    this._realFrame.height = realH;
    this.pivot.x = frameX - realX;
    this.pivot.y = frameY - realY;

    if (realW > 0 && realH > 0) {
      if (this._needsTint()) {
        this._createTinter(realW, realH);
        this._executeTint(realX, realY, realW, realH);
        this._tintTexture.update();
        this.texture.baseTexture = this._tintTexture;
        this.texture.frame = new context.Rectangle(0, 0, realW, realH);
      } else {
        if (this._bitmap) {
          this.texture.baseTexture = this._bitmap.baseTexture;
        }
        this.texture.frame = this._realFrame;
      }
    } else if (this._bitmap) {
      this.texture.frame = context.Rectangle.emptyRectangle;
    } else {
      this.texture.baseTexture.width = Math.max(
        this.texture.baseTexture.width, this._frame.x + this._frame.width);
      this.texture.baseTexture.height = Math.max(
        this.texture.baseTexture.height, this._frame.y + this._frame.height);
      this.texture.frame = this._frame;
    }
    this.texture._updateID++;
  };

  if (typeof beforeInstall === 'function') {
    beforeInstall(context);
  }

  vm.createContext(context);
  vm.runInContext(optimizationsSource, context, { filename: 'optimizations.js' });
  vm.runInContext(rendererSource, context, { filename: 'renderer.js' });
  return context;
}

test('sprite.native-tint registers and defaults to enabled', () => {
  const ctx = setupEnvironment();
  assert.equal(ctx.PMJS.optimizations.isEnabled('sprite.native-tint'), true);
  assert.equal(ctx.PMJS.optimizations.reason('sprite.native-tint'), 'enabled');
});

test('sprite.native-tint disables via PMJS_DISABLE_OPT', () => {
  const ctx = setupEnvironment({ env: { PMJS_DISABLE_OPT: 'sprite.native-tint' } });
  assert.equal(ctx.PMJS.optimizations.isEnabled('sprite.native-tint'), false);
  assert.equal(ctx.PMJS.optimizations.reason('sprite.native-tint'), 'disabled by PMJS_DISABLE_OPT');
});

test('sprite.native-tint disables via PMJS_GAME_CONFIG.disableOptimizations', () => {
  const ctx = setupEnvironment({ config: { disableOptimizations: ['sprite.native-tint'] } });
  assert.equal(ctx.PMJS.optimizations.isEnabled('sprite.native-tint'), false);
  assert.equal(ctx.PMJS.optimizations.reason('sprite.native-tint'), 'disabled by port');
});

test('default sprite without _pmjsNativeSpriteTint bypasses CPU tint for blendColor', () => {
  const ctx = setupEnvironment();
  const bitmap = new ctx.Bitmap(100, 100);
  const sprite = new ctx.Sprite(bitmap);

  // Note: sprite._pmjsNativeSpriteTint is NOT set; defaults to true
  sprite._colorTone = [0, 0, 0, 0];
  sprite._blendColor = [255, 255, 255, 64];

  sprite._refresh();

  assert.equal(sprite.executeTintCalls, 0);
  assert.equal(sprite.texture.baseTexture, bitmap.baseTexture);
  assert.equal(sprite.texture.frame, sprite._realFrame);
  assert.equal(sprite.texture.frame.width, 100);
  assert.equal(sprite.texture.frame.height, 100);
  assert.equal(sprite.texture._updateID, 1);
});

test('sprite with explicit opt-out (_pmjsNativeSpriteTint = false) falls back to stock CPU tint', () => {
  const ctx = setupEnvironment();
  const bitmap = new ctx.Bitmap(100, 100);
  const sprite = new ctx.Sprite(bitmap);

  sprite._pmjsNativeSpriteTint = false;
  sprite._colorTone = [0, 0, 0, 0];
  sprite._blendColor = [255, 255, 255, 64];

  sprite._refresh();

  assert.equal(sprite.executeTintCalls, 1);
  assert.equal(sprite.texture.baseTexture, sprite._tintTexture);
  assert.notEqual(sprite.texture.baseTexture, bitmap.baseTexture);
});

test('default sprite with non-neutral tone bypasses CPU tint', () => {
  const ctx = setupEnvironment();
  const bitmap = new ctx.Bitmap(100, 100);
  const sprite = new ctx.Sprite(bitmap);

  sprite._colorTone = [50, 0, -50, 128];
  sprite._blendColor = [0, 0, 0, 0];

  sprite._refresh();

  assert.equal(sprite.executeTintCalls, 0);
  assert.equal(sprite.texture.baseTexture, bitmap.baseTexture);
  assert.equal(sprite.texture.frame, sprite._realFrame);
  assert.equal(sprite.texture.frame.width, 100);
  assert.equal(sprite.texture.frame.height, 100);
  assert.equal(sprite.texture._updateID, 1);
});

test('default sprite with both non-neutral tone and blendColor bypasses CPU tint', () => {
  const ctx = setupEnvironment();
  const bitmap = new ctx.Bitmap(100, 100);
  const sprite = new ctx.Sprite(bitmap);

  sprite._colorTone = [50, 0, -50, 128];
  sprite._blendColor = [255, 255, 255, 64];

  sprite._refresh();

  assert.equal(sprite.executeTintCalls, 0);
  assert.equal(sprite.texture.baseTexture, bitmap.baseTexture);
  assert.equal(sprite.texture.frame, sprite._realFrame);
  assert.equal(sprite.texture.frame.width, 100);
  assert.equal(sprite.texture.frame.height, 100);
  assert.equal(sprite.texture._updateID, 1);
});

test('default sprite falls back to stock CPU tint when optimization is disabled', () => {
  const ctx = setupEnvironment({ env: { PMJS_DISABLE_OPT: 'sprite.native-tint' } });
  const bitmap = new ctx.Bitmap(100, 100);
  const sprite = new ctx.Sprite(bitmap);

  sprite._colorTone = [0, 0, 0, 0];
  sprite._blendColor = [255, 255, 255, 64];

  sprite._refresh();

  assert.equal(sprite.executeTintCalls, 1);
  assert.equal(sprite.texture.baseTexture, sprite._tintTexture);
});

test('composed Sprite._refresh wrapper installed before renderer.js is invoked and preserves tone and blend', () => {
  let wrapperCalled = 0;
  const ctx = setupEnvironment({
    beforeInstall(context) {
      const originalRefresh = context.Sprite.prototype._refresh;
      context.Sprite.prototype._refresh = function() {
        wrapperCalled++;
        return originalRefresh.apply(this, arguments);
      };
    }
  });

  const bitmap = new ctx.Bitmap(64, 64);
  const sprite = new ctx.Sprite(bitmap);
  sprite._colorTone = [68, -34, 0, 128];
  sprite._blendColor = [255, 0, 0, 64];

  sprite._refresh();

  assert.equal(wrapperCalled, 1);
  assert.equal(sprite.executeTintCalls, 0);
  assert.deepEqual(sprite._colorTone, [68, -34, 0, 128]);
  assert.deepEqual(sprite._blendColor, [255, 0, 0, 64]);
  assert.equal(sprite.texture.baseTexture, bitmap.baseTexture);
});

test('composed Sprite._refresh wrapper installed after renderer.js is invoked and preserves tone and blend', () => {
  const ctx = setupEnvironment();
  let wrapperCalled = 0;
  const originalRefresh = ctx.Sprite.prototype._refresh;
  ctx.Sprite.prototype._refresh = function() {
    wrapperCalled++;
    return originalRefresh.apply(this, arguments);
  };

  const bitmap = new ctx.Bitmap(64, 64);
  const sprite = new ctx.Sprite(bitmap);
  sprite._colorTone = [68, -34, 0, 128];
  sprite._blendColor = [255, 0, 0, 64];

  sprite._refresh();

  assert.equal(wrapperCalled, 1);
  assert.equal(sprite.executeTintCalls, 0);
  assert.deepEqual(sprite._colorTone, [68, -34, 0, 128]);
  assert.deepEqual(sprite._blendColor, [255, 0, 0, 64]);
  assert.equal(sprite.texture.baseTexture, bitmap.baseTexture);
});

test('particle sprite refreshed after attachment to ParticleContainer bypasses CPU tint', () => {
  const ctx = setupEnvironment();
  const container = new ctx.PIXI.particles.ParticleContainer();
  const bitmap = new ctx.Bitmap(64, 64);
  const sprite = new ctx.Sprite(bitmap);
  sprite.parent = container;
  sprite._colorTone = [100, 0, 0, 0];

  sprite._refresh();

  assert.equal(sprite.executeTintCalls, 0);
  assert.equal(sprite.texture.baseTexture, bitmap.baseTexture);
  assert.equal(sprite._tintTexture, undefined);
});

test('particle sprite refreshed before attachment to ParticleContainer bypasses CPU tint', () => {
  const ctx = setupEnvironment();
  const container = new ctx.PIXI.particles.ParticleContainer();
  const bitmap = new ctx.Bitmap(64, 64);
  const sprite = new ctx.Sprite(bitmap);
  sprite._colorTone = [100, 0, 0, 0];

  sprite._refresh();

  // Attached after refresh
  sprite.parent = container;

  assert.equal(sprite.executeTintCalls, 0);
  assert.equal(sprite.texture.baseTexture, bitmap.baseTexture);
  assert.equal(sprite._tintTexture, undefined);
});

test('particle sprite with explicit opt-out falls back to stock CPU tint inside ParticleContainer', () => {
  const ctx = setupEnvironment();
  const container = new ctx.PIXI.particles.ParticleContainer();
  const bitmap = new ctx.Bitmap(64, 64);
  const sprite = new ctx.Sprite(bitmap);
  sprite.parent = container;
  sprite._pmjsNativeSpriteTint = false;
  sprite._colorTone = [100, 0, 0, 0];

  sprite._refresh();

  assert.equal(sprite.executeTintCalls, 1);
  assert.equal(sprite.texture.baseTexture, sprite._tintTexture);
});

test('pixel parity: shader formula matches Canvas 2D tint within 1 LSB across tones, blends, and premultiplied alphas', () => {
  function shaderTint(pr, pg, pb, a, tone, blend) {
    if (a <= 0) return [0, 0, 0, 0];
    const alphaNorm = a / 255;
    const sr = (pr / 255) / alphaNorm;
    const sg = (pg / 255) / alphaNorm;
    const sb = (pb / 255) / alphaNorm;
    const toneA = Math.max(0, tone[3]) / 255;
    const gray = 0.299 * sr + 0.587 * sg + 0.114 * sb;
    let cr = sr * (1 - toneA) + gray * toneA;
    let cg = sg * (1 - toneA) + gray * toneA;
    let cb = sb * (1 - toneA) + gray * toneA;
    cr = Math.min(1.0, Math.max(0.0, cr + tone[0] / 255));
    cg = Math.min(1.0, Math.max(0.0, cg + tone[1] / 255));
    cb = Math.min(1.0, Math.max(0.0, cb + tone[2] / 255));
    const ba = blend[3] / 255;
    cr = cr * (1 - ba) + (blend[0] / 255) * ba;
    cg = cg * (1 - ba) + (blend[1] / 255) * ba;
    cb = cb * (1 - ba) + (blend[2] / 255) * ba;
    const outR = Math.round(cr * alphaNorm * 255);
    const outG = Math.round(cg * alphaNorm * 255);
    const outB = Math.round(cb * alphaNorm * 255);
    return [outR, outG, outB, a];
  }

  function canvasTint(r, g, b, a, tone, blend) {
    if (a <= 0) return [0, 0, 0, 0];
    const gray = 0.299 * r + 0.587 * g + 0.114 * b;
    const toneA = Math.max(0, tone[3]) / 255;
    let cr = r * (1 - toneA) + gray * toneA;
    let cg = g * (1 - toneA) + gray * toneA;
    let cb = b * (1 - toneA) + gray * toneA;
    cr = Math.min(255, Math.max(0, cr + tone[0]));
    cg = Math.min(255, Math.max(0, cg + tone[1]));
    cb = Math.min(255, Math.max(0, cb + tone[2]));
    const ba = blend[3] / 255;
    cr = cr * (1 - ba) + blend[0] * ba;
    cg = cg * (1 - ba) + blend[1] * ba;
    cb = cb * (1 - ba) + blend[2] * ba;
    const alphaNorm = a / 255;
    return [Math.round(cr * alphaNorm), Math.round(cg * alphaNorm), Math.round(cb * alphaNorm), a];
  }

  const testCases = [
    // Neutral tone + blend
    { tone: [0, 0, 0, 0], blend: [255, 255, 255, 64] },
    { tone: [0, 0, 0, 0], blend: [255, 0, 0, 128] },
    { tone: [0, 0, 0, 0], blend: [0, 255, 0, 64] },
    // Tone with no blend
    { tone: [100, 0, 0, 0], blend: [0, 0, 0, 0] },
    { tone: [-100, 0, 0, 0], blend: [0, 0, 0, 0] },
    { tone: [0, 100, -100, 0], blend: [0, 0, 0, 0] },
    { tone: [0, 0, 0, 128], blend: [0, 0, 0, 0] },
    { tone: [0, 0, 0, 255], blend: [0, 0, 0, 0] },
    { tone: [100, -80, 50, 128], blend: [0, 0, 0, 0] },
    { tone: [-255, -255, -255, 255], blend: [0, 0, 0, 0] },
    // Tone + blend combination
    { tone: [100, -80, 50, 128], blend: [255, 255, 255, 64] },
    { tone: [50, 50, 50, 64], blend: [0, 0, 255, 128] }
  ];

  for (const { tone, blend } of testCases) {
    let maxDiff = 0;
    for (let r = 0; r <= 255; r += 17) {
      for (let g = 0; g <= 255; g += 17) {
        for (let b = 0; b <= 255; b += 17) {
          for (const a of [0, 64, 128, 255]) {
            const alphaNorm = a / 255;
            const pr = Math.round(r * alphaNorm);
            const pg = Math.round(g * alphaNorm);
            const pb = Math.round(b * alphaNorm);
            const shaderResult = shaderTint(pr, pg, pb, a, tone, blend);
            const canvasResult = canvasTint(r, g, b, a, tone, blend);
            // Verify premultiplied constraint: rgb <= a
            assert.ok(shaderResult[0] <= a && shaderResult[1] <= a && shaderResult[2] <= a,
              `Premultiplied violation rgb > a: [${shaderResult}] with a=${a}`);
            const diff = Math.max(
              Math.abs(shaderResult[0] - canvasResult[0]),
              Math.abs(shaderResult[1] - canvasResult[1]),
              Math.abs(shaderResult[2] - canvasResult[2]),
              Math.abs(shaderResult[3] - canvasResult[3])
            );
            if (diff > maxDiff) maxDiff = diff;
          }
        }
      }
    }
    assert.ok(maxDiff <= 1, `Max diff ${maxDiff} > 1 for tone [${tone}] and blend [${blend}]`);
  }
});

test('picture and character sprite subclasses bypass CPU tint across multiple tone/blend updates', () => {
  const ctx = setupEnvironment();
  function Sprite_Picture() {
    ctx.Sprite.apply(this, arguments);
  }
  Sprite_Picture.prototype = Object.create(ctx.Sprite.prototype);
  Sprite_Picture.prototype.constructor = Sprite_Picture;

  const bitmap = new ctx.Bitmap(816, 624);
  const picture = new Sprite_Picture(bitmap);

  // Simulate 30 frames of tintPicture transition
  for (let frame = 0; frame <= 30; frame++) {
    const progress = frame / 30;
    picture._colorTone = [
      Math.round(-68 * progress),
      Math.round(-68 * progress),
      Math.round(0 * progress),
      Math.round(68 * progress)
    ];
    picture._refresh();
  }

  assert.equal(picture.executeTintCalls, 0);
  assert.equal(picture.texture.baseTexture, bitmap.baseTexture);
  assert.equal(picture.texture.frame, picture._realFrame);
  assert.equal(picture.texture.frame.width, 816);
  assert.equal(picture.texture.frame.height, 624);
});
