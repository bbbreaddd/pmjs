NativeHost.runtime.loadScript('js/rpg_core.js');

if (typeof Bitmap !== 'function' || typeof Sprite !== 'function' ||
    typeof Graphics !== 'function' || typeof Input !== 'function') {
  throw new Error('RPG Maker core did not initialize');
}
nativeBootPhase('rpg-core-loaded');

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
  if (stage.worldTransform && typeof stage.worldTransform.identity === 'function') {
    stage.worldTransform.identity();
  }
  if (Bitmap.useBlur) NativeHost.canvas.blur(
    bitmap._canvas._ensureNativeCanvas().handle);
  bitmap._setDirty();
  return bitmap;
};

// Blur is delegated to the native canvas to preserve its compositing state.
Bitmap.prototype.blur = function() {
  NativeHost.canvas.blur(this._canvas._ensureNativeCanvas().handle);
  this._setDirty();
};

// MV text uses one native draw while the Canvas API remains available to plugins.
Bitmap.prototype.drawText = function(text, x, y, maxWidth, lineHeight, align) {
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
  this._setDirty();
};

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
