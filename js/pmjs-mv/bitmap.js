PMJS.mv = PMJS.mv || {};
PMJS.mv.bitmap = PMJS.mv.bitmap || {};
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
    renderer && renderer.roundPixels, renderer);
  pmjsBitmapCanvasChanged(bitmap);
  if (stage.worldTransform && typeof stage.worldTransform.identity === 'function') {
    stage.worldTransform.identity();
  }
  if (Bitmap.useBlur) PMJS.web.canvas.blur(bitmap._canvas);
  bitmap._setDirty();
  return bitmap;
};

(function installNativeBlur() {
  var reviewedBlur = '77eb88ca5b4dfb6af98376695d8cbf490ac594aa3b885bd51dcee77306d16078';
  var stockBlur = Bitmap.prototype.blur;
  if (typeof stockBlur !== 'function') return;
  PMJS.optimizations.register({ id: 'bitmap.native-blur', owner: 'pmjs-mv',
    fallback: 'stock MV Canvas additive blur' });
  function activateNativeBlur() {
    if (!PMJS.optimizations.isEnabled('bitmap.native-blur')) return;
    if (!PMJS.methods.matchesSource(stockBlur, reviewedBlur) || Bitmap.prototype.blur !== stockBlur) {
      PMJS.optimizations.refuse('bitmap.native-blur', 'modified Bitmap blur method');
      return;
    }
    Bitmap.prototype.blur = function() {
      var canvas = this._canvas;
      if (canvas.width !== this.width || canvas.height !== this.height) {
        PMJS.optimizations.reportFallback('bitmap.native-blur', 'bitmap and Canvas dimensions differ');
        return stockBlur.apply(this, arguments);
      }
      if (typeof PMJS.web.canvas.blurMv !== 'function' ||
          !PMJS.web.canvas.blurMv(this._context)) {
        PMJS.optimizations.reportFallback('bitmap.native-blur',
          'native MV blur unavailable or Canvas drawing state unsupported');
        return stockBlur.apply(this, arguments);
      }
      this._setDirty();
    };
  }
  if (PMJS.phases && typeof PMJS.phases.on === 'function') {
    PMJS.phases.on('afterGuestPlugins', 'pmjs.mv.native-blur', activateNativeBlur);
  } else {
    activateNativeBlur();
  }
})();

(function installNativeColorTransforms() {
  [
    ['adjustTone', 'c4b0d310063fa366854c01e7531c5cfe7b086cdb8e7b4ab245423ae9a5c837fe'],
    ['rotateHue', 'd06dfb21577dc1c8bf7a9cad27445b6689889bb3114583ada6432ea073be0d01']
  ].forEach(function(entry) {
    var name = entry[0], original = Bitmap.prototype[name];
    if (typeof original !== 'function') return;
    var id = 'bitmap.native-' + name;
    PMJS.optimizations.register({ id: id, owner: 'pmjs-mv', fallback: 'stock bitmap pixel loop' });
    function activate() {
      if (!PMJS.optimizations.isEnabled(id)) return;
      if (!PMJS.methods.matchesSource(original, entry[1]) || Bitmap.prototype[name] !== original) {
        PMJS.optimizations.refuse(id, 'modified Bitmap color method');
        return;
      }
      Bitmap.prototype[name] = function() {
        var count = name === 'adjustTone' ? 3 : 1;
        if (!(arguments[0] || count === 3 && (arguments[1] || arguments[2])) ||
            !(this.width > 0 && this.height > 0)) return;
        for (var i = 0; i < count; ++i) {
          if (typeof arguments[i] !== 'number' || !Number.isFinite(arguments[i]))
            return original.apply(this, arguments);
        }
        var context = this._context;
        if (context.canvas.width !== this.width || context.canvas.height !== this.height ||
            !PMJS.web.canvas[name](context, arguments[0], arguments[1], arguments[2])) {
          PMJS.optimizations.reportFallback(id, 'unsupported bitmap pixel context');
          return original.apply(this, arguments);
        }
        this._setDirty();
      };
    }
    if (PMJS.phases && typeof PMJS.phases.on === 'function')
      PMJS.phases.on('afterGuestPlugins', 'pmjs.mv.native-' + name, activate);
    else activate();
  });
})();

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
  // Adapters may replace a captured stock leaf while keeping outer plugin wrappers.
  PMJS.mv.bitmap.createNativeDrawText = function(originalDrawText, expectedFont, fontStillValid, optimizationId) {
    if (typeof stockDrawText !== 'function' || typeof stockOutline !== 'function' ||
        typeof stockBody !== 'function' || typeof expectedFont !== 'function' ||
        originalDrawText !== stockDrawText || Bitmap.prototype._drawTextOutline !== stockOutline ||
        Bitmap.prototype._drawTextBody !== stockBody) return null;

    optimizationId = optimizationId || 'bitmap.native-draw-text';
    return function(text, x, y, maxWidth, lineHeight, align) {
      var textType = typeof text;
      if (text !== null && textType !== 'string' && textType !== 'number' && textType !== 'boolean') {
        if (text !== undefined) PMJS.optimizations.reportFallback(optimizationId, 'text value unsupported');
        return originalDrawText.apply(this, arguments);
      }
      if (this._drawTextOutline !== stockOutline || this._drawTextBody !== stockBody ||
          this._makeFontNameText !== expectedFont || (fontStillValid && !fontStillValid())) {
        PMJS.optimizations.reportFallback(optimizationId, 'Bitmap text methods changed after installation');
        return originalDrawText.apply(this, arguments);
      }
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(lineHeight) ||
          !Number.isFinite(this.fontSize) || this.fontSize <= 0 ||
          (maxWidth && !Number.isFinite(maxWidth)) ||
          (align && align !== 'left' && align !== 'center' && align !== 'right')) {
        PMJS.optimizations.reportFallback(optimizationId, 'text dimensions, font size or alignment unsupported');
        return originalDrawText.apply(this, arguments);
      }
      var context = this._context;
      if ((!align && context.textAlign && context.textAlign !== 'left' && context.textAlign !== 'start') ||
          !PMJS.web.canvas.supportsNativeText(context, maxWidth, align,
            { outlineColor: this.outlineColor, color: this.textColor })) {
        PMJS.optimizations.reportFallback(optimizationId, 'Canvas text drawing state unsupported');
        return originalDrawText.apply(this, arguments);
      }

      text = String(text);
      var descriptor = this._makeFontNameText();
      var baseline = y + lineHeight - (lineHeight - this.fontSize * 0.7) / 2;
      var width = maxWidth || 0xffffffff;
      if (align === 'center') x += width / 2;
      else if (align === 'right') x += width;
      PMJS.web.canvas.drawNativeText(context, text, x, baseline, {
        font: descriptor, outlineColor: this.outlineColor,
        outlineWidth: this.outlineWidth, color: this.textColor, maxWidth: width, align: align
      });
      this._setDirty();
    };
  };

  function activateNativeDrawText() {
    if (!PMJS.optimizations.isEnabled('bitmap.native-draw-text')) return;
    var draw = Bitmap.prototype.drawText === stockDrawText &&
      Bitmap.prototype._makeFontNameText === stockFontName &&
      PMJS.mv.bitmap.createNativeDrawText(stockDrawText, stockFontName);
    if (typeof draw !== 'function') {
      PMJS.optimizations.refuse('bitmap.native-draw-text',
        'modified Bitmap text method composition');
      return;
    }
    Bitmap.prototype.drawText = draw;
  }
  if (PMJS.phases && typeof PMJS.phases.on === 'function') {
    PMJS.phases.on('afterGuestPlugins', 'pmjs.mv.native-draw-text',
      activateNativeDrawText);
  } else {
    activateNativeDrawText();
  }
})();


// Pixel queries support canvas-backed bitmaps without forcing image readback.
Bitmap.prototype.getPixel = function(x, y) {
  var data = PMJS.web.canvas.readPixel(this._canvas, this._context, x, y);
  if (data) {
    return '#' + ('000000' + ((data[0] << 16 | data[1] << 8 | data[2]) >>> 0).toString(16)).slice(-6);
  }
  PMJS.compat.hit('bitmap.getPixel',
    'x=' + x + ' y=' + y + ' w=' + this.width + ' h=' + this.height);
  return '#000000';
};

Bitmap.prototype.getAlphaPixel = function(x, y) {
  var data = PMJS.web.canvas.readPixel(this._canvas, this._context, x, y);
  if (data) return data[3];
  PMJS.compat.hit('bitmap.getAlphaPixel',
    'x=' + x + ' y=' + y + ' w=' + this.width + ' h=' + this.height);
  return 0;
};

// Preserve the engine's paintOpacity descriptor, including fractional values.
