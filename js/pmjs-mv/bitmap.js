PMJS.mv = PMJS.mv || {};
PMJS.mv.bitmap = PMJS.mv.bitmap || {};
PMJS.mv.bitmap.createPrimitiveRecorder = function(bitmap) {
  if (!bitmap || !PMJS.web || !PMJS.web.canvas) return null;
  var recorder = PMJS.web.canvas.createPrimitiveRecorder(bitmap._canvas);
  if (!recorder) return null;
  var originalDestroy = bitmap.destroy;
  bitmap.destroy = function() {
    recorder.destroy();
    if (typeof originalDestroy === 'function') {
      return originalDestroy.apply(this, arguments);
    }
  };
  return recorder;
};

NativeHost.runtime.loadScript('js/rpg_core.js');
if (globalThis.PMJS_RUNTIME_GAME && PMJS_RUNTIME_GAME.engineVersion &&
    Utils.RPGMAKER_VERSION !== PMJS_RUNTIME_GAME.engineVersion) {
  throw new Error('inspected MV ' + PMJS_RUNTIME_GAME.engineVersion +
    ' but loaded ' + Utils.RPGMAKER_VERSION);
}

if (typeof Bitmap !== 'function' || typeof Sprite !== 'function' ||
    typeof Graphics !== 'function' || typeof Input !== 'function') {
  throw new Error('RPG Maker core did not initialize');
}
nativeBootPhase('rpg-core-loaded');

(function installDeferredBitmapSwap() {
  var descriptor = Object.getOwnPropertyDescriptor(Sprite.prototype, 'bitmap');
  if (!descriptor || !descriptor.configurable || !descriptor.get || !descriptor.set) return;
  Object.defineProperty(Sprite.prototype, 'bitmap', {
    configurable: true,
    enumerable: descriptor.enumerable,
    get: descriptor.get,
    set: function(value) {
      this._pmjsPendingBitmapSwap = null;
      var previous = descriptor.get.call(this);
      if (previous && value && previous !== value && previous._url &&
          previous._url === value._url && !previous.__canvas && !value.__canvas &&
          typeof previous.isReady === 'function' && previous.isReady() &&
          typeof value.isReady === 'function' && !value.isReady() &&
          typeof value.addLoadListener === 'function') {
        var sprite = this;
        var pending = {};
        this._pmjsPendingBitmapSwap = pending;
        value.addLoadListener(function() {
          if (sprite._pmjsPendingBitmapSwap !== pending ||
              descriptor.get.call(sprite) !== previous) return;
          sprite._pmjsPendingBitmapSwap = null;
          var frame = sprite._frame.clone();
          descriptor.set.call(sprite, value);
          // Stock _onBitmapLoad expands the frame to the entire sheet.
          sprite.setFrame(frame.x, frame.y, frame.width, frame.height);
        });
        return;
      }
      descriptor.set.call(this, value);
    }
  });
})();

function pmjsBitmapCanvasChanged(bitmap) {
  var canvas = bitmap && bitmap._canvas;
  if (canvas && typeof canvas._pmjsContentChanged === 'function') {
    canvas._pmjsContentChanged();
  }
}

// Render the supplied stage synchronously into an independently owned bitmap.
// Copying the previously presented framebuffer is observably wrong
// when snapForBackground runs after the scene update but before presentation.
Bitmap.snap = function(stage) {
  var bitmap = new Bitmap(Graphics.width, Graphics.height);
  if (!stage) return bitmap;
  var renderer = Graphics._renderer;
  PMJS.pixi4.renderStageToCanvas(stage, bitmap._canvas,
    renderer && renderer.roundPixels);
  pmjsBitmapCanvasChanged(bitmap);
  if (stage.worldTransform && typeof stage.worldTransform.identity === 'function') {
    stage.worldTransform.identity();
  }
  if (Bitmap.useBlur) PMJS.web.canvas.blur(bitmap._canvas);
  if (Bitmap.useBlur) pmjsBitmapCanvasChanged(bitmap);
  bitmap._setDirty();
  return bitmap;
};

// Keep MV's blur method: the generic native blur has different kernel and alpha semantics.

// Annotate native canvases with their source bitmap URL for diagnosis.
var _Bitmap_createCanvas = Bitmap.prototype._createCanvas;
if (typeof _Bitmap_createCanvas === 'function') {
  Bitmap.prototype._createCanvas = function(width, height) {
    if (!this.__canvas && typeof document !== 'undefined' && document.createElement) {
      this.__canvas = document.createElement('canvas');
      this.__canvas._pmjsBitmapUrl = this._url || null;
    }
    _Bitmap_createCanvas.call(this, width, height);
    if (this.__canvas && !this.__canvas._pmjsBitmapUrl) {
      this.__canvas._pmjsBitmapUrl = this._url || null;
    }
  };
}

// Register pristine blt fast path with PMJS optimizations registry.
if (typeof PMJS !== 'undefined' && PMJS.optimizations &&
    typeof PMJS.optimizations.register === 'function') {
  PMJS.optimizations.register({
    id: 'bitmap.pristine-image-blt',
    owner: 'pmjs-mv',
    fallback: 'Draw via source._canvas materialization in stock Bitmap.prototype.blt'
  });
}

var _Bitmap_fillRect = Bitmap.prototype.fillRect;
if (typeof _Bitmap_fillRect === 'function') {
  Bitmap.prototype.fillRect = function(x, y, width, height, color) {
    var bitmap = this;
    var args = arguments;
    var draw = function() { return _Bitmap_fillRect.apply(bitmap, args); };
    if (Number(x) !== 0 || Number(y) !== 0 || Number(width) !== this.width ||
        Number(height) !== this.height) return draw();
    return PMJS.web.canvas.trackMaskFill(this._context, x, y, width, height,
      color, draw);
  };
}

// Blt avoids forcing source canvas realization when the source bitmap is a pristine image.
var _Bitmap_blt = Bitmap.prototype.blt;
var _Bitmap_canvasDescriptor = Object.getOwnPropertyDescriptor(Bitmap.prototype, '_canvas');
var _Bitmap_createCanvasForBlt = Bitmap.prototype._createCanvas;
function pmjsBitmapHasStockImagePixels(source) {
  var descriptor = Object.getOwnPropertyDescriptor(Bitmap.prototype, '_canvas');
  return Object.getPrototypeOf(source) === Bitmap.prototype &&
    !Object.prototype.hasOwnProperty.call(source, '_canvas') &&
    descriptor && _Bitmap_canvasDescriptor &&
    descriptor.get === _Bitmap_canvasDescriptor.get &&
    source._createCanvas === _Bitmap_createCanvasForBlt;
}
if (typeof _Bitmap_blt === 'function') {
  Bitmap.prototype.blt = function(source, sx, sy, sw, sh, dx, dy, dw, dh) {
    dw = dw || sw;
    dh = dh || sh;
    if (source &&
        PMJS.optimizations.isEnabled('bitmap.pristine-image-blt') &&
        source._image &&
        pmjsBitmapHasStockImagePixels(source) &&
        !source.__canvas &&
        !source.hue &&
        !source._hue &&
        sx >= 0 && sy >= 0 &&
        sw > 0 && sh > 0 &&
        dw > 0 && dh > 0 &&
        sx + sw <= source.width &&
        sy + sh <= source.height) {
      this._context.globalCompositeOperation = 'source-over';
      this._context.drawImage(source._image, sx, sy, sw, sh, dx, dy, dw, dh);
      this._setDirty();
      return;
    }
    return _Bitmap_blt.apply(this, arguments);
  };
}

// MV text uses native draw only when the stock MV text pipeline is recognized
// at installation time and outline/body methods are untouched; falls back to the
// JavaScript implementation when overridden by plugins (e.g. Bitmap Fonts).
(function installNativeDrawText() {
  if (typeof Bitmap === 'undefined' || !Bitmap.prototype) return;
  PMJS.optimizations.register({ id: 'bitmap.native-draw-text', owner: 'pmjs-mv',
    fallback: 'stock MV Canvas fillText and strokeText' });
  var stockDrawText = Bitmap.prototype.drawText;
  var stockOutline = Bitmap.prototype._drawTextOutline;
  var stockBody = Bitmap.prototype._drawTextBody;
  var stockFontName = Bitmap.prototype._makeFontNameText;
  function activateNativeDrawText() {
    if (!PMJS.optimizations.isEnabled('bitmap.native-draw-text')) return;
    var originalDrawText = Bitmap.prototype.drawText;
    var originalOutline = Bitmap.prototype._drawTextOutline;
    var originalBody = Bitmap.prototype._drawTextBody;

    if (typeof stockDrawText !== 'function' || typeof stockOutline !== 'function' ||
        typeof stockBody !== 'function' || typeof stockFontName !== 'function' ||
        originalDrawText !== stockDrawText || originalOutline !== stockOutline ||
        originalBody !== stockBody || Bitmap.prototype._makeFontNameText !== stockFontName) {
      PMJS.optimizations.refuse('bitmap.native-draw-text',
        'modified Bitmap text method composition');
      return;
    }

    Bitmap.prototype.drawText = function(text, x, y, maxWidth, lineHeight, align) {
      var context = this._context;
      if (this._drawTextOutline !== originalOutline ||
          this._drawTextBody !== originalBody || this._makeFontNameText !== stockFontName ||
          !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(lineHeight) || maxWidth ||
          (align && align !== 'left') || text === undefined ||
          !PMJS.web.canvas.supportsNativeText(context)) {
        return originalDrawText.apply(this, arguments);
      }

      text = String(text);
      var descriptor = this._makeFontNameText();
      var baseline = y + lineHeight - (lineHeight - this.fontSize * 0.7) / 2;
      PMJS.web.canvas.drawNativeText(context, text, x, baseline, {
        font: descriptor, outlineColor: this.outlineColor,
        outlineWidth: this.outlineWidth, color: this.textColor
      });
      pmjsBitmapCanvasChanged(this);
      this._setDirty();
    };
  }
  if (PMJS.phases && typeof PMJS.phases.on === 'function') {
    PMJS.phases.on('afterGuestPlugins', 'pmjs.mv.native-draw-text',
      activateNativeDrawText);
  } else {
    activateNativeDrawText();
  }
})();


Bitmap.prototype.measureTextWidth = function(text) {
  return PMJS.web.canvas.measureTextWidth(text, this._makeFontNameText());
};

// Pixel queries support canvas-backed bitmaps without forcing image readback.
Bitmap.prototype.getPixel = function(x, y) {
  x = Math.floor(Number(x) || 0);
  y = Math.floor(Number(y) || 0);
  try {
    var data = PMJS.web.canvas.readPixel(this._canvas, this._context, x, y);
    if (data) {
      return '#' + ('000000' + ((data[0] << 16 | data[1] << 8 | data[2]) >>> 0).toString(16)).slice(-6);
    }
  } catch (_) {}
  PMJS.compat.hit('bitmap.getPixel',
    'x=' + x + ' y=' + y + ' w=' + this.width + ' h=' + this.height);
  return '#000000';
};

Bitmap.prototype.getAlphaPixel = function(x, y) {
  x = Math.floor(Number(x) || 0);
  y = Math.floor(Number(y) || 0);
  try {
    var data = PMJS.web.canvas.readPixel(this._canvas, this._context, x, y);
    if (data) return data[3];
  } catch (_) {}
  PMJS.compat.hit('bitmap.getAlphaPixel',
    'x=' + x + ' y=' + y + ' w=' + this.width + ' h=' + this.height);
  return 0;
};

// Preserve the engine's paintOpacity descriptor, including fractional values.
