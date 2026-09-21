NativeHost.runtime.loadScript('js/rpg_core.js');

if (typeof Bitmap !== 'function' || typeof Sprite !== 'function' ||
    typeof Graphics !== 'function' || typeof Input !== 'function') {
  throw new Error('RPG Maker core did not initialize');
}
nativeBootPhase('rpg-core-loaded');

function pmjsBitmapCanvasChanged(bitmap) {
  var canvas = bitmap && bitmap._canvas;
  if (canvas && typeof canvas._pmjsContentChanged === 'function') {
    canvas._pmjsContentChanged();
  }
}

function pmjsBitmapEstablishMaskProof(bitmap) {
  var canvas = bitmap && bitmap._canvas;
  if (!canvas || !Number.isFinite(canvas.__pmjsContentRevision)) return;
  canvas.__pmjsMaskProof = { kind: 'constant-mask-rect', x: 0, y: 0,
    width: bitmap.width, height: bitmap.height, weight: 1,
    revision: canvas.__pmjsContentRevision };
}

function pmjsBitmapIsUnitMaskFill(bitmap, x, y, width, height, color) {
  if (Number(x) !== 0 || Number(y) !== 0 || Number(width) !== bitmap.width ||
      Number(height) !== bitmap.height || typeof colorToRgba !== 'function') {
    return false;
  }
  var context = bitmap._context;
  var transform = context && context._transform;
  if (!context || Number(context.globalAlpha) !== 1 ||
      context.globalCompositeOperation !== 'source-over' ||
      !transform || transform.length !== 6 ||
      transform[0] !== 1 || transform[1] !== 0 || transform[2] !== 0 ||
      transform[3] !== 1 || transform[4] !== 0 || transform[5] !== 0 ||
      context._clipPaths && context._clipPaths.length) return false;
  var rgba = colorToRgba(color);
  return ((rgba >>> 24) & 255) === 255 && (rgba & 255) === 255;
}

// Render the supplied stage synchronously into one reusable background
// bitmap. Copying the previously presented framebuffer is observably wrong
// when snapForBackground runs after the scene update but before presentation.
Bitmap.snap = function(stage) {
  var bitmap = Bitmap.background_bitmap;
  if (!(bitmap instanceof Bitmap) || bitmap.width !== Graphics.width ||
      bitmap.height !== Graphics.height) {
    if (bitmap && typeof bitmap.destroy === 'function') bitmap.destroy();
    bitmap = Bitmap.background_bitmap = new Bitmap(Graphics.width, Graphics.height);
  }
  if (!stage) return bitmap;
  var renderer = Graphics._renderer;
  NativeHost.render.setRenderTargetSize(Graphics.width, Graphics.height);
  renderNativeStage(stage, nativeIdentityTransform, 1,
    renderer && renderer.roundPixels);
  NativeHost.render.renderToCanvas(bitmap._canvas._ensureNativeCanvas().handle);
  pmjsBitmapCanvasChanged(bitmap);
  if (stage.worldTransform && typeof stage.worldTransform.identity === 'function') {
    stage.worldTransform.identity();
  }
  if (Bitmap.useBlur) NativeHost.canvas.blur(
    bitmap._canvas._ensureNativeCanvas().handle);
  if (Bitmap.useBlur) pmjsBitmapCanvasChanged(bitmap);
  bitmap._setDirty();
  return bitmap;
};

// Blur is delegated to the native canvas to preserve its compositing state.
Bitmap.prototype.blur = function() {
  NativeHost.canvas.blur(this._canvas._ensureNativeCanvas().handle);
  pmjsBitmapCanvasChanged(this);
  this._setDirty();
};

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
    var establishesProof = pmjsBitmapIsUnitMaskFill(
      this, x, y, width, height, color);
    var result = _Bitmap_fillRect.apply(this, arguments);
    if (establishesProof) pmjsBitmapEstablishMaskProof(this);
    return result;
  };
}

// Blt avoids forcing source canvas realization when the source bitmap is a pristine image.
var _Bitmap_blt = Bitmap.prototype.blt;
if (typeof _Bitmap_blt === 'function') {
  Bitmap.prototype.blt = function(source, sx, sy, sw, sh, dx, dy, dw, dh) {
    dw = dw || sw;
    dh = dh || sh;
    if (source &&
        (typeof pmjsOptimizationEnabled !== 'function' ||
         pmjsOptimizationEnabled('bitmap.pristine-image-blt')) &&
        source._image &&
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
  var originalDrawText = Bitmap.prototype.drawText;
  var originalOutline = Bitmap.prototype._drawTextOutline;
  var originalBody = Bitmap.prototype._drawTextBody;

  function normalizedSource(fn) {
    if (typeof fn !== 'function') return '';
    try {
      return Function.prototype.toString.call(fn).replace(/\s+/g, '');
    } catch (_) {
      return '';
    }
  }

  function isStockTextPipeline(drawFn, outlineFn, bodyFn) {
    var drawSrc = normalizedSource(drawFn);
    var outlineSrc = normalizedSource(outlineFn);
    var bodySrc = normalizedSource(bodyFn);

    // Stock RPG Maker MV drawText delegates directly to _drawTextOutline and _drawTextBody
    var drawMatches = drawSrc.indexOf('this._drawTextOutline(') !== -1 &&
      drawSrc.indexOf('this._drawTextBody(') !== -1 &&
      drawSrc.indexOf('this._makeFontNameText()') !== -1 &&
      drawSrc.indexOf('this._setDirty()') !== -1;

    var outlineMatches = outlineSrc.indexOf('context.strokeText(') !== -1 &&
      outlineSrc.indexOf('this.outlineColor') !== -1;

    var bodyMatches = bodySrc.indexOf('context.fillText(') !== -1 &&
      bodySrc.indexOf('this.textColor') !== -1;

    return drawMatches && outlineMatches && bodyMatches;
  }

  // If Bitmap.prototype.drawText was already modified before PMJS installs,
  // or outline/body are non-stock, do not install the native accelerator.
  if (!isStockTextPipeline(originalDrawText, originalOutline, originalBody)) {
    return;
  }

  Bitmap.prototype.drawText = function(text, x, y, maxWidth, lineHeight, align) {
    if (this._drawTextOutline !== originalOutline ||
        this._drawTextBody !== originalBody) {
      return originalDrawText.apply(this, arguments);
    }

    text = String(text);
    if (this._blockTextDrawing || y >= this.height) return;

    x = Math.floor(x);
    y = Math.floor(y);
    maxWidth = Math.max(0, Math.floor(maxWidth || 0));
    lineHeight = Math.floor(lineHeight);

    var descriptor = this._makeFontNameText();
    var context = this._context;
    var font = contextFont({ font: descriptor });
    var measured = NativeHost.canvas.measureText(font.path, text, font.size);
    var renderedWidth = maxWidth > 0 ? Math.min(measured, maxWidth + 1) : measured;
    var tx = x;
    if (align === 'center') tx += maxWidth / 2 - renderedWidth / 2;
    else if (align === 'right') tx += maxWidth - renderedWidth;

    // The native rasterizer expects an integral baseline offset.
    var baseline = y + lineHeight -
      Math.floor((lineHeight - this.fontSize * 0.7) / 2);
    var canvas = this._canvas._ensureNativeCanvas();
    var paintAlpha = context.globalAlpha;
    if (this.outlineWidth > 0) {
      NativeHost.canvas.drawText(canvas.handle, font.path, text,
        Math.floor(tx), baseline, font.size,
        colorWithGlobalAlpha(this.outlineColor, paintAlpha),
        Math.max(0, Math.floor(this.outlineWidth)));
    }
    NativeHost.canvas.drawText(canvas.handle, font.path, text,
      Math.floor(tx), baseline, font.size,
      colorWithGlobalAlpha(this.textColor, paintAlpha), 0);
    pmjsBitmapCanvasChanged(this);
    this._setDirty();
  };
})();


Bitmap.prototype.measureTextWidth = function(text) {
  var font = contextFont({ font: this._makeFontNameText() });
  return NativeHost.canvas.measureText(font.path, String(text), font.size);
};

// Pixel queries support canvas-backed bitmaps without forcing image readback.
Bitmap.prototype.getPixel = function(x, y) {
  x = Math.floor(Number(x) || 0);
  y = Math.floor(Number(y) || 0);
  try {
    if (this._canvas && this._canvas._nativeCanvas) {
      var rgba = NativeHost.canvas.pixel(
        this._canvas._ensureNativeCanvas().handle, x, y);
      var r = (rgba >>> 24) & 255;
      var g = (rgba >>> 16) & 255;
      var b = (rgba >>> 8) & 255;
      return '#' + ('000000' + ((r << 16 | g << 8 | b) >>> 0).toString(16)).slice(-6);
    }
    if (this._context && typeof this._context.getImageData === 'function') {
      try {
        var data = this._context.getImageData(x, y, 1, 1).data;
        return '#' + ('000000' + ((data[0] << 16 | data[1] << 8 | data[2]) >>> 0).toString(16)).slice(-6);
      } catch (_) {}
    }
  } catch (_) {}
  nativeCompatibilityHit('bitmap.getPixel',
    'x=' + x + ' y=' + y + ' w=' + this.width + ' h=' + this.height);
  return '#000000';
};

Bitmap.prototype.getAlphaPixel = function(x, y) {
  x = Math.floor(Number(x) || 0);
  y = Math.floor(Number(y) || 0);
  try {
    if (this._canvas && this._canvas._nativeCanvas) {
      var pixel = NativeHost.canvas.pixel(
        this._canvas._ensureNativeCanvas().handle, x, y);
      return pixel & 255;
    }
    if (this._context && typeof this._context.getImageData === 'function') {
      try {
        return this._context.getImageData(x, y, 1, 1).data[3];
      } catch (_) {}
    }
  } catch (_) {}
  nativeCompatibilityHit('bitmap.getAlphaPixel',
    'x=' + x + ' y=' + y + ' w=' + this.width + ' h=' + this.height);
  return 0;
};

Object.defineProperty(Bitmap.prototype, 'paintOpacity', {
  configurable: true,
  get: function() {
    return this._paintOpacity === undefined ? 255 : this._paintOpacity;
  },
  set: function(value) {
    var alpha = Math.max(0, Math.min(255, Number(value) | 0));
    this._paintOpacity = alpha;
    if (this._context) this._context.globalAlpha = alpha / 255;
  }
});
