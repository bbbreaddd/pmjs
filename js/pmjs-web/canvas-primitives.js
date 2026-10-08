(function() {
  function lightColor(value, alpha) {
    var rgba = colorWithGlobalAlpha(value, alpha);
    return [((rgba >>> 24) & 255) / 255, ((rgba >>> 16) & 255) / 255,
      ((rgba >>> 8) & 255) / 255, (rgba & 255) / 255];
  }

  function appendLightRecord(records, kind, bounds, center, radii, stops, alpha,
      blendMode) {
    records.push(kind, bounds[0], bounds[1], bounds[2], bounds[3],
      center[0], center[1], radii[0], radii[1], stops.length);
    for (var offsetIndex = 0; offsetIndex < 3; offsetIndex++) {
      records.push(offsetIndex < stops.length ? stops[offsetIndex].offset : 0);
    }
    for (var colorIndex = 0; colorIndex < 3; colorIndex++) {
      var color = colorIndex < stops.length ?
        lightColor(stops[colorIndex].color, alpha) : [0, 0, 0, 0];
      records.push(color[0], color[1], color[2], color[3]);
    }
    records.push(blendMode);
  }

  var surfaceFinalizer = typeof FinalizationRegistry === 'function'
    ? new FinalizationRegistry(function(handle) {
        try { NativeHost.render.releasePrimitiveSurface(handle); } catch (_) {}
      }) : null;

  globalThis.PMJS = globalThis.PMJS || {};
  PMJS.web = PMJS.web || {};
  PMJS.web.canvas = PMJS.web.canvas || {};
  PMJS.web.canvas.createPrimitiveRecorder = function(canvas) {
    if (typeof NativeHost === 'undefined' || !NativeHost.render ||
        typeof NativeHost.render.createPrimitiveSurface !== 'function' ||
        typeof NativeHost.render.renderPrimitiveSurface !== 'function' ||
        typeof NativeHost.render.releasePrimitiveSurface !== 'function') return null;
    var context = canvas && typeof canvas.getContext === 'function' && canvas.getContext('2d');
    if (!context || typeof context.fillRect !== 'function') return null;
    if (canvas._pmjsPrimitiveContent) return null;
    var surfaceWidth = canvas.width;
    var surfaceHeight = canvas.height;
    var surface = NativeHost.render.createPrimitiveSurface(surfaceWidth, surfaceHeight);
    if (surfaceFinalizer) surfaceFinalizer.register(canvas, surface.handle, canvas);
    var originalFillRect = context.fillRect;
    var originalFill = context.fill;
    var records = [];
    var replay = [];
    var priorReplay = [];
    var clearColor = [0, 0, 0, 0];
    var recording = false;
    var fallback = false;

    function replayRecordedCanvasOperations(force) {
      if (fallback || !force && !recording && canvas._nativeImage !== surface.image) return;
      fallback = true;
      delete canvas._nativeImage;
      var operations = priorReplay.concat(replay);
      priorReplay.length = 0;
      for (var index = 0; index < operations.length; index++) {
        var operation = operations[index];
        context.save();
        context.fillStyle = operation.style;
        context.globalAlpha = operation.alpha;
        context.globalCompositeOperation = operation.composite;
        context._clipPaths = [];
        context.setTransform.apply(context, operation.transform);
        originalFillRect.apply(context, operation.arguments);
        context.restore();
      }
    }

    context.fillRect = function(x, y, width, height) {
      if (!recording || fallback) {
        if (!recording && surface && canvas._nativeImage === surface.image) {
          replayRecordedCanvasOperations();
        }
        return originalFillRect.apply(this, arguments);
      }
      var transform = this._transform;
      var identity = transform && transform[0] === 1 && transform[1] === 0 &&
        transform[2] === 0 && transform[3] === 1;
      var blendMode = this.globalCompositeOperation === 'lighter' ? 1 :
        this.globalCompositeOperation === 'source-over' ? 0 : -1;
      var style = this.fillStyle;
      var supportedGradient = style && style._pmjsStyle === 'radial-gradient' &&
        style.nativeConcentric && style.stops.length > 0 && style.stops.length <= 3;
      var supportedSolid = typeof style === 'string' || typeof style === 'number';
      if (!identity || this._clipPaths && this._clipPaths.length ||
          blendMode < 0 || (!supportedGradient && !supportedSolid)) {
        replayRecordedCanvasOperations();
        return originalFillRect.apply(this, arguments);
      }
      var bounds = [x + transform[4], y + transform[5], width, height];
      var fullOpaque = supportedSolid && blendMode === 0 &&
        bounds[0] <= 0 && bounds[1] <= 0 && bounds[0] + bounds[2] >= canvas.width &&
        bounds[1] + bounds[3] >= canvas.height && lightColor(style, this.globalAlpha)[3] === 1;
      // A full opaque first fill reconstructs the surface independently. Other
      // updates must preserve existing Canvas content through its ordinary owner.
      if (replay.length === 0 && !fullOpaque) {
        replayRecordedCanvasOperations();
        return originalFillRect.apply(this, arguments);
      }
      if (replay.length === 0) priorReplay.length = 0;
      var replayStyle = supportedGradient ? Object.assign({}, style, { stops: style.stops.map(function(stop) {
        return { offset: stop.offset, color: stop.color };
      }) }) : style;
      replay.push({ style: replayStyle, alpha: this.globalAlpha,
        composite: this.globalCompositeOperation,
        transform: Array.prototype.slice.call(transform),
        arguments: Array.prototype.slice.call(arguments) });
      if (fullOpaque && replay.length === 1) {
        clearColor = lightColor(style, this.globalAlpha);
        return;
      }
      if (supportedGradient) {
        appendLightRecord(records, 1, bounds, [style.x0, style.y0],
          [style.r0, style.r1], style.stops, this.globalAlpha, blendMode);
      } else {
        appendLightRecord(records, 0, bounds, [0, 0], [0, 0],
          [{ offset: 0, color: style }], this.globalAlpha, blendMode);
      }
    };
    context.fill = function() {
      if (recording && !fallback || surface && canvas._nativeImage === surface.image) {
        replayRecordedCanvasOperations();
      }
      return originalFill.apply(this, arguments);
    };

    function record(draw) {
      if (!surface) return draw();
      priorReplay = canvas._nativeImage === surface.image ? replay.slice() : [];
      records.length = 0;
      replay.length = 0;
      clearColor = [0, 0, 0, 0];
      fallback = false;
      recording = true;
      try {
        if (canvas.width !== surfaceWidth || canvas.height !== surfaceHeight) {
          replayRecordedCanvasOperations();
        }
        var result = draw();
      } catch (error) {
        replayRecordedCanvasOperations();
        throw error;
      } finally {
        recording = false;
      }
      if (!replay.length) replayRecordedCanvasOperations();
      if (!fallback) {
        try {
          NativeHost.render.renderPrimitiveSurface(
            surface.handle, clearColor, records);
          canvas._nativeImage = surface.image;
          if (canvas._pmjsContentChanged) canvas._pmjsContentChanged();
        } catch (_) {
          replayRecordedCanvasOperations(true);
        }
      }
      return result;
    }

    var content = canvas._pmjsPrimitiveContent = {
      materialize: replayRecordedCanvasOperations,
      reset: function() {
        fallback = true;
        replay.length = priorReplay.length = 0;
        if (canvas._nativeImage === surface.image) delete canvas._nativeImage;
      }
    };
    var recordingFillRect = context.fillRect;
    var recordingFill = context.fill;
    return {
      record: record,
      destroy: function() {
        if (!surface) return;
        replayRecordedCanvasOperations();
        if (canvas._pmjsPrimitiveContent === content) delete canvas._pmjsPrimitiveContent;
        if (surfaceFinalizer) surfaceFinalizer.unregister(canvas);
        if (canvas._nativeImage === surface.image) delete canvas._nativeImage;
        if (context.fillRect === recordingFillRect) context.fillRect = originalFillRect;
        if (context.fill === recordingFill) context.fill = originalFill;
        NativeHost.render.releasePrimitiveSurface(surface.handle);
        surface = null;
      }
    };
  };
})();
