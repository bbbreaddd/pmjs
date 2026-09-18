Graphics._createRenderer = function() {
  // Let the port finalize plugin-owned renderer settings before replacement.
  try {
    if (typeof globalThis.__pmjsBeforeCreateRenderer === 'function') {
      globalThis.__pmjsBeforeCreateRenderer.call(this);
    }
  } catch (_) {}
  this._renderer = createNativePixiRenderer(this._width, this._height, {
    view: this._canvas,
    resolution: 1,
    autoResize: false
  });
};

// MV's browser renderer skips future renderer calls when one frame takes over
// 15ms. Chromium keeps the previous compositor image in that case; pmjs owns
// the physical frame loop, so an omitted call otherwise becomes an empty
// command packet that clears the native scene target to black. Scheduling and
// cadence belong to the native host—always produce the requested scene frame.
Graphics.render = function(stage) {
  if (stage) {
    this._renderer.render(stage);
    if (this._renderer.gl && this._renderer.gl.flush) this._renderer.gl.flush();
  }
  this._skipCount = 0;
  this._rendered = true;
  this.frameCount = (this.frameCount + 1) % 1024;
};
Graphics.isFontLoaded = function() { return true; };
var originalIsOptionValid = Utils.isOptionValid;
Utils.isOptionValid = function(name) {
  return (!globalThis.AudioContext && name === 'noaudio') ||
    originalIsOptionValid.call(this, name);
};

var nativeFilterDescriptor = PIXI.DisplayObject &&
  Object.getOwnPropertyDescriptor(PIXI.DisplayObject.prototype, 'filters');
if (nativeFilterDescriptor && typeof nativeFilterDescriptor.get === 'function' &&
    nativeFilterDescriptor.configurable) {
  var nativeFilterGetter = nativeFilterDescriptor.get;
  nativeFilterDescriptor.get = function() {
    var filters = nativeFilterGetter.call(this);
    if (globalThis.__pmjsTrace && __pmjsTrace.active()) {
      __pmjsTrace.count('filters_getter_calls', 1);
      if (Array.isArray(this._filters)) __pmjsTrace.count('filters_slice_calls', 1);
    }
    return filters;
  };
  Object.defineProperty(PIXI.DisplayObject.prototype, 'filters',
    nativeFilterDescriptor);
}

// Capture provenance at the point MV has successfully produced tinted pixels.
// The wrapper is diagnostic-only while the bounded trace is active.
if (globalThis.Sprite && Sprite.prototype &&
    typeof Sprite.prototype._executeTint === 'function' &&
    !Sprite.prototype._pmjsTraceExecuteTint) {
  var nativeOriginalExecuteTint = Sprite.prototype._executeTint;
  Sprite.prototype._executeTint = function(x, y, width, height) {
    var result = nativeOriginalExecuteTint.apply(this, arguments);
    if (globalThis.__pmjsTrace && __pmjsTrace.active() && this._canvas) {
      var output = this._canvas._ensureNativeCanvas ?
        this._canvas._ensureNativeCanvas() : this._canvas._nativeCanvas;
      var outputResource = __pmjsTrace.revision(output, 'canvas', true);
      var bitmapSource = this._bitmap && this._bitmap.baseTexture &&
        this._bitmap.baseTexture.source;
      var sourceNative = bitmapSource &&
        (bitmapSource._nativeImage || bitmapSource._nativeCanvas);
      var sourceResource = __pmjsTrace.revision(sourceNative,
        bitmapSource && bitmapSource._nativeCanvas ? 'canvas' : 'image');
      __pmjsTrace.event('tint', 'mv.cpu-tint-complete', {
        objectId: __pmjsTrace.id(this, 'display-object'),
        sourceId: sourceResource.id,
        sourceRevision: sourceResource.revision,
        outputId: outputResource.id,
        outputRevision: outputResource.revision,
        x: x, y: y, width: width, height: height,
        colorTone: this._colorTone && Array.prototype.slice.call(this._colorTone),
        blendColor: this._blendColor && Array.prototype.slice.call(this._blendColor)
      });
    }
    return result;
  };
  Sprite.prototype._pmjsTraceExecuteTint = true;
}

if (typeof PMJS !== 'undefined' && PMJS.optimizations &&
    typeof PMJS.optimizations.register === 'function') {
  PMJS.optimizations.register({
    id: 'sprite.native-tint',
    owner: 'pmjs-mv',
    fallback: 'Stock Canvas 2D Sprite._executeTint pixel passes'
  });
}

function installNativeSpriteTint() {
  if (typeof Sprite === 'undefined' || !Sprite.prototype ||
      typeof Sprite.prototype._refresh !== 'function' ||
      Sprite.prototype._pmjsNativeSpriteTintInstalled) {
    return false;
  }
  var stockRefresh = Sprite.prototype._refresh;
  var neutralTone = [0, 0, 0, 0];
  var neutralBlend = [0, 0, 0, 0];
  Sprite.prototype._refresh = function() {
    if (this._pmjsNativeSpriteTint !== false &&
        (typeof pmjsOptimizationEnabled !== 'function' ||
         pmjsOptimizationEnabled('sprite.native-tint'))) {
      var tone = this._colorTone;
      var blend = this._blendColor;
      var hasTone = tone && (tone[0] || tone[1] || tone[2] || tone[3]);
      var hasBlend = blend && blend[3] > 0;
      if (hasTone || hasBlend) {
        this._colorTone = neutralTone;
        this._blendColor = neutralBlend;
        try {
          return stockRefresh.apply(this, arguments);
        } finally {
          this._colorTone = tone;
          this._blendColor = blend;
        }
      }
    }
    return stockRefresh.apply(this, arguments);
  };
  Sprite.prototype._pmjsNativeSpriteTintInstalled = true;
  return true;
}

installNativeSpriteTint();
globalThis.pmjsInstallNativeSpriteTint = installNativeSpriteTint;
