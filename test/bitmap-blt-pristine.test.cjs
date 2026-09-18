'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const runtimeRoot = path.resolve(__dirname, '..');
const optimizationsSource = fs.readFileSync(
  path.join(runtimeRoot, 'js/pmjs-core/optimizations.js'), 'utf8');
const bitmapSource = fs.readFileSync(
  path.join(runtimeRoot, 'js/pmjs-mv/bitmap.js'), 'utf8');

function setupEnvironment({ config = {}, env = {} } = {}) {
  let stockBltCalls = 0;

  function createMockCanvas(width, height) {
    const canvas = {
      tagName: 'CANVAS',
      _width: width || 0,
      _height: height || 0,
      _pmjsBitmapUrl: null,
      drawCalls: [],
      getContext(type) {
        if (type === '2d') {
          if (!canvas._context2d) {
            canvas._context2d = {
              canvas,
              globalCompositeOperation: 'source-over',
              globalAlpha: 1,
              drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh) {
                canvas.drawCalls.push({ img, sx, sy, sw, sh, dx, dy, dw, dh });
              }
            };
          }
          return canvas._context2d;
        }
        return null;
      }
    };
    Object.defineProperty(canvas, 'width', {
      get() { return canvas._width; },
      set(v) { canvas._width = v; }
    });
    Object.defineProperty(canvas, 'height', {
      get() { return canvas._height; },
      set(v) { canvas._height = v; }
    });
    return canvas;
  }

  const documentStub = {
    createElement(tag) {
      if (tag === 'canvas') return createMockCanvas();
      return { tagName: String(tag).toUpperCase() };
    }
  };

  function MockBitmap(w, h) {
    this._width = w || 0;
    this._height = h || 0;
    this._image = null;
    this.__canvas = null;
    this.__context = null;
    this._url = '';
    this._dirty = false;
    this.hue = 0;
    this._hue = 0;
  }

  Object.defineProperty(MockBitmap.prototype, 'width', {
    get() { return this._image ? (this._image.width || this._width) : this._width; },
    set(v) { this._width = v; },
    configurable: true
  });
  Object.defineProperty(MockBitmap.prototype, 'height', {
    get() { return this._image ? (this._image.height || this._height) : this._height; },
    set(v) { this._height = v; },
    configurable: true
  });

  MockBitmap.prototype._createCanvas = function(width, height) {
    this.__canvas = this.__canvas || documentStub.createElement('canvas');
    this.__context = this.__canvas.getContext('2d');
    this.__canvas.width = Math.max(width || 0, 1);
    this.__canvas.height = Math.max(height || 0, 1);
    if (this._image) {
      var w = Math.max(this._image.width || 0, 1);
      var h = Math.max(this._image.height || 0, 1);
      this.__canvas.width = w;
      this.__canvas.height = h;
      this.__context.drawImage(this._image, 0, 0);
    }
    this._setDirty();
  };

  Object.defineProperty(MockBitmap.prototype, '_canvas', {
    get() {
      if (!this.__canvas) {
        this._createCanvas();
      }
      return this.__canvas;
    },
    configurable: true
  });

  Object.defineProperty(MockBitmap.prototype, '_context', {
    get() {
      if (!this.__context) {
        this._createCanvas();
      }
      return this.__context;
    },
    configurable: true
  });

  MockBitmap.prototype._setDirty = function() {
    this._dirty = true;
  };

  MockBitmap.prototype.blt = function(source, sx, sy, sw, sh, dx, dy, dw, dh) {
    stockBltCalls++;
    dw = dw || sw;
    dh = dh || sh;
    if (sx >= 0 && sy >= 0 && sw > 0 && sh > 0 && dw > 0 && dh > 0 &&
        sx + sw <= source.width && sy + sh <= source.height) {
      this._context.globalCompositeOperation = 'source-over';
      this._context.drawImage(source._canvas, sx, sy, sw, sh, dx, dy, dw, dh);
      this._setDirty();
    }
  };

  const context = {
    console: { log() {} },
    PMJS_GAME_CONFIG: config,
    document: documentStub,
    NativeHost: {
      runtime: {
        loadScript() {},
        env(name) { return env[name]; }
      },
      render: {
        setRenderTargetSize() {},
        renderToCanvas() {}
      },
      canvas: {
        blur() {},
        measureText() { return 10; },
        drawText() {},
        pixel() { return 0; }
      }
    },
    nativeBootPhase() {},
    Bitmap: MockBitmap,
    Sprite: function Sprite() {},
    Graphics: Object.assign(function Graphics() {}, { width: 816, height: 624, _renderer: null }),
    Input: function Input() {}
  };

  vm.createContext(context);
  vm.runInContext(optimizationsSource, context, { filename: 'optimizations.js' });
  vm.runInContext(bitmapSource, context, { filename: 'bitmap.js' });

  return {
    context,
    Bitmap: context.Bitmap,
    PMJS: context.PMJS,
    getStockBltCalls: () => stockBltCalls
  };
}

test('optimization registration: registers bitmap.pristine-image-blt and defaults to enabled', () => {
  const { PMJS } = setupEnvironment();
  assert.equal(PMJS.optimizations.isEnabled('bitmap.pristine-image-blt'), true);
  assert.equal(PMJS.optimizations.reason('bitmap.pristine-image-blt'), 'enabled');
});

test('pristine image fast path: draws directly from source._image without materializing source canvas', () => {
  const { Bitmap, getStockBltCalls } = setupEnvironment();
  const dst = new Bitmap(106, 106);
  const src = new Bitmap(424, 1378);
  src._image = { width: 424, height: 1378, isMockImage: true };
  src._url = 'img/faces/MainCharacters_DreamWorld.png';

  assert.equal(src.__canvas, null, 'source __canvas must be null initially');
  dst.blt(src, 0, 0, 106, 106, 0, 0, 106, 106);

  assert.equal(src.__canvas, null, 'source __canvas must remain null after blt');
  assert.equal(dst._dirty, true, 'destination bitmap must be marked dirty');
  assert.equal(getStockBltCalls(), 0, 'stock blt must not be called on pristine fast path');

  const drawCalls = dst.__canvas.drawCalls;
  assert.equal(drawCalls.length, 1);
  assert.equal(drawCalls[0].img, src._image, 'drawImage must be called directly with source._image');
  assert.equal(drawCalls[0].sx, 0);
  assert.equal(drawCalls[0].sy, 0);
  assert.equal(drawCalls[0].sw, 106);
  assert.equal(drawCalls[0].sh, 106);
  assert.equal(drawCalls[0].dx, 0);
  assert.equal(drawCalls[0].dy, 0);
  assert.equal(drawCalls[0].dw, 106);
  assert.equal(drawCalls[0].dh, 106);
});

test('materialized/mutated canvas fallback: draws from source._canvas when __canvas exists', () => {
  const { Bitmap, getStockBltCalls } = setupEnvironment();
  const dst = new Bitmap(106, 106);
  const src = new Bitmap(424, 1378);
  src._image = { width: 424, height: 1378, isMockImage: true };
  src._url = 'img/faces/MainCharacters_DreamWorld.png';

  // Force canvas creation on source
  const materializedCanvas = src._canvas;
  assert.ok(src.__canvas, 'source __canvas must be materialized');

  dst.blt(src, 0, 0, 106, 106, 0, 0, 106, 106);

  assert.equal(getStockBltCalls(), 1, 'stock blt must be called when __canvas exists');
  const drawCalls = dst.__canvas.drawCalls;
  assert.equal(drawCalls.length, 1);
  assert.equal(drawCalls[0].img, materializedCanvas, 'drawImage must use source._canvas');
});

test('out-of-bounds fallback: delegates to stock blt and rejects draw without error', () => {
  const { Bitmap, getStockBltCalls } = setupEnvironment();
  const dst = new Bitmap(100, 100);
  const src = new Bitmap(100, 100);
  src._image = { width: 100, height: 100 };

  // Out of bounds: sx + sw (80 + 50 = 130) > src.width (100)
  dst.blt(src, 80, 0, 50, 50, 0, 0, 50, 50);
  assert.equal(getStockBltCalls(), 1, 'stock blt must be called on out-of-bounds input');
  assert.equal(dst.__canvas ? dst.__canvas.drawCalls.length : 0, 0, 'no draw call should occur');
  assert.equal(src.__canvas, null, 'source canvas must not be materialized on rejected blt');

  // Negative sx
  dst.blt(src, -10, 0, 50, 50, 0, 0, 50, 50);
  assert.equal(getStockBltCalls(), 2);
  assert.equal(dst.__canvas ? dst.__canvas.drawCalls.length : 0, 0);

  // Non-positive sw
  dst.blt(src, 0, 0, 0, 50, 0, 0, 0, 50);
  assert.equal(getStockBltCalls(), 3);
  assert.equal(dst.__canvas ? dst.__canvas.drawCalls.length : 0, 0);
});

test('hue-modified source fallback: delegates to stock blt when source has hue or _hue', () => {
  const { Bitmap, getStockBltCalls } = setupEnvironment();

  // Test source.hue
  const dst1 = new Bitmap(100, 100);
  const src1 = new Bitmap(100, 100);
  src1._image = { width: 100, height: 100 };
  src1.hue = 60;

  assert.equal(src1.__canvas, null);
  dst1.blt(src1, 0, 0, 50, 50, 0, 0, 50, 50);

  assert.equal(getStockBltCalls(), 1, 'stock blt must be called when source.hue is set');
  assert.ok(src1.__canvas, 'source __canvas must be materialized by stock blt fallback');
  assert.equal(dst1.__canvas.drawCalls.length, 1);
  assert.equal(dst1.__canvas.drawCalls[0].img, src1.__canvas, 'must draw from source canvas');

  // Test source._hue
  const dst2 = new Bitmap(100, 100);
  const src2 = new Bitmap(100, 100);
  src2._image = { width: 100, height: 100 };
  src2._hue = 120;

  assert.equal(src2.__canvas, null);
  dst2.blt(src2, 0, 0, 50, 50, 0, 0, 50, 50);

  assert.equal(getStockBltCalls(), 2, 'stock blt must be called when source._hue is set');
  assert.ok(src2.__canvas, 'source __canvas must be materialized by stock blt fallback');
  assert.equal(dst2.__canvas.drawCalls.length, 1);
  assert.equal(dst2.__canvas.drawCalls[0].img, src2.__canvas, 'must draw from source canvas');
});

test('optimization disabled: delegates to stock blt when disabled via PMJS_DISABLE_OPT or port config', () => {
  // Test via PMJS_DISABLE_OPT
  {
    const { Bitmap, PMJS, getStockBltCalls } = setupEnvironment({
      env: { PMJS_DISABLE_OPT: 'bitmap.pristine-image-blt' }
    });
    assert.equal(PMJS.optimizations.isEnabled('bitmap.pristine-image-blt'), false);
    assert.equal(PMJS.optimizations.reason('bitmap.pristine-image-blt'), 'disabled by PMJS_DISABLE_OPT');

    const dst = new Bitmap(100, 100);
    const src = new Bitmap(100, 100);
    src._image = { width: 100, height: 100 };

    assert.equal(src.__canvas, null);
    dst.blt(src, 0, 0, 50, 50, 0, 0, 50, 50);

    assert.equal(getStockBltCalls(), 1, 'stock blt must be called when optimization disabled');
    assert.ok(src.__canvas, 'source __canvas materialized by stock blt');
    assert.equal(dst.__canvas.drawCalls.length, 1);
    assert.equal(dst.__canvas.drawCalls[0].img, src.__canvas);
  }

  // Test via PMJS_GAME_CONFIG.disableOptimizations
  {
    const { Bitmap, PMJS, getStockBltCalls } = setupEnvironment({
      config: { disableOptimizations: ['bitmap.pristine-image-blt'] }
    });
    assert.equal(PMJS.optimizations.isEnabled('bitmap.pristine-image-blt'), false);
    assert.equal(PMJS.optimizations.reason('bitmap.pristine-image-blt'), 'disabled by port');

    const dst = new Bitmap(100, 100);
    const src = new Bitmap(100, 100);
    src._image = { width: 100, height: 100 };

    assert.equal(src.__canvas, null);
    dst.blt(src, 0, 0, 50, 50, 0, 0, 50, 50);

    assert.equal(getStockBltCalls(), 1, 'stock blt must be called when optimization disabled by port');
    assert.ok(src.__canvas, 'source __canvas materialized by stock blt');
    assert.equal(dst.__canvas.drawCalls.length, 1);
    assert.equal(dst.__canvas.drawCalls[0].img, src.__canvas);
  }
});

test('URL attribution: lazily created canvases receive _pmjsBitmapUrl from source bitmap _url', () => {
  const { Bitmap } = setupEnvironment();

  // With URL
  const bmp1 = new Bitmap(120, 120);
  bmp1._url = 'img/characters/MainCharacters.png';
  assert.equal(bmp1.__canvas, null);
  const canvas1 = bmp1._canvas;
  assert.ok(canvas1);
  assert.equal(canvas1._pmjsBitmapUrl, 'img/characters/MainCharacters.png');

  // Without URL
  const bmp2 = new Bitmap(120, 120);
  assert.equal(bmp2.__canvas, null);
  const canvas2 = bmp2._canvas;
  assert.ok(canvas2);
  assert.equal(canvas2._pmjsBitmapUrl, null);
});
