function createNativePixiRenderer(width, height, options) {
  if (width && typeof width === 'object') {
    options = width;
    width = options.width;
    height = options.height;
  } else {
    options = Object.assign({ width: width, height: height }, options || {});
  }
  options = Object.assign({}, PIXI.settings && PIXI.settings.RENDER_OPTIONS || {
    width: 800, height: 600, resolution: 1, transparent: false,
    autoResize: false, antialias: false, preserveDrawingBuffer: false,
    clearBeforeRender: true, backgroundColor: 0, roundPixels: false,
    legacy: false
  }, options);
  width = Math.max(1, Number(options.width) || 800);
  height = Math.max(1, Number(options.height) || 600);
  options.width = width;
  options.height = height;
  var resolution = Math.max(0.000001, Number(options.resolution) || 1);
  var backingWidth = Math.max(1, Math.floor(width * resolution));
  var backingHeight = Math.max(1, Math.floor(height * resolution));
  var textureUnitCount = 32;
  var renderer = {
    type: PIXI.RENDERER_TYPE.WEBGL,
    options: options,
    width: backingWidth,
    height: backingHeight,
    resolution: resolution,
    CONTEXT_UID: ++nativeRendererContextUid,
    view: options.view || document.createElement('canvas'),
    autoResize: !!options.autoResize,
    blendModes: [],
    preserveDrawingBuffer: !!options.preserveDrawingBuffer,
    antialias: !!options.antialias,
    clearBeforeRender: options.clearBeforeRender !== false,
    transparent: !!options.transparent,
    roundPixels: !!options.roundPixels,
    legacy: !!options.legacy,
    powerPreference: options.powerPreference,
    _backgroundColor: Number(options.backgroundColor) >>> 0 || 0x000000,
    _backgroundColorString: '#000000',
    _backgroundColorRgb: [0, 0, 0],
    _backgroundColorRgba: new Float32Array([0, 0, 0,
      options.transparent ? 0 : 1]),
    _lastObjectRendered: null,
    _tempDisplayObjectParent: PIXI.DisplayObject ? new PIXI.DisplayObject() : null,
    stage: null,
    screen: new PIXI.Rectangle(0, 0, width, height),
    rootRenderTarget: null,
    renderingToScreen: true,

    emptyRenderer: { flush: function() {}, start: function() {},
      stop: function() {} },
    currentRenderer: null,
    _nextTextureLocation: 0,
    _activeShader: null,
    _activeVao: null,
    _transform: null,
    boundTextures: new Array(textureUnitCount),
    emptyTextures: new Array(textureUnitCount),
    gl: { isContextLost: function() { return false; }, flush: function() {} },
    setObjectRenderer: function(nextRenderer) {
      if (this.currentRenderer === nextRenderer) return;
      if (this.currentRenderer && typeof this.currentRenderer.stop === 'function') {
        this.currentRenderer.stop();
      }
      this.currentRenderer = nextRenderer || this.emptyRenderer;
      if (this.currentRenderer && typeof this.currentRenderer.start === 'function') {
        this.currentRenderer.start();
      }
    },
    flush: function() {
      if (this.currentRenderer && typeof this.currentRenderer.flush === 'function') {
        this.currentRenderer.flush();
      }
      this.currentRenderer = this.emptyRenderer;
    },
    setBlendMode: function(blendMode) {
      this.state.setBlendMode(blendMode);
      return this;
    },
    setTransform: function(matrix) {
      this._transform = matrix || null;
      this.rootRenderTarget.transform = this._transform;
      return this;
    },
    bindRenderTexture: function(renderTexture, transform) {
      this.renderTexture.bind(renderTexture || null);
      var target = this._activeRenderTarget;
      target.transform = transform || null;
      var targetResolution = Math.max(0.000001,
        Number(target.resolution) || 1);
      NativeHost.render.setRenderTargetSize(
        Math.max(1, Math.ceil(target.size.width * targetResolution)),
        Math.max(1, Math.ceil(target.size.height * targetResolution)));
      return this;
    },
    bindRenderTarget: function(renderTarget) {
      this._activeRenderTarget = renderTarget || this.rootRenderTarget;
      var target = this._activeRenderTarget;
      var targetResolution = Math.max(0.000001,
        Number(target.resolution) || 1);
      var targetSize = target.size || target;
      NativeHost.render.setRenderTargetSize(
        Math.max(1, Math.ceil(targetSize.width * targetResolution)),
        Math.max(1, Math.ceil(targetSize.height * targetResolution)));
      return this;
    },
    clear: function(clearColor) {
      var color = clearColor || this._backgroundColorRgba;
      NativeHost.render.setClearColor(Number(color[0]) || 0,
        Number(color[1]) || 0, Number(color[2]) || 0,
        color[3] === undefined ? 1 : Number(color[3]) || 0);
      return this;
    },
    clearRenderTexture: function(renderTexture, clearColor) {
      if (!renderTexture || !renderTexture.baseTexture) return this;
      var base = renderTexture.baseTexture;
      var resolution = Math.max(0.000001, Number(base.resolution) || 1);
      var target = base.__pmjsRenderCanvas;
      if (!target) {
        target = base.__pmjsRenderCanvas = new CanvasElement();
        base.source = target;
      }
      target.width = Math.max(1, Math.ceil(base.width * resolution));
      target.height = Math.max(1, Math.ceil(base.height * resolution));
      var context = target.getContext('2d');
      context.clearRect(0, 0, target.width, target.height);
      if (clearColor && clearColor[3] > 0) {
        context.fillStyle = 'rgba(' + Math.round(clearColor[0] * 255) + ',' +
          Math.round(clearColor[1] * 255) + ',' +
          Math.round(clearColor[2] * 255) + ',' + clearColor[3] + ')';
        context.fillRect(0, 0, target.width, target.height);
      }
      return this;
    },
    bindShader: function(shader) {
      this._activeShader = shader || null;
      if (shader) nativeCompatibilityHit('renderer.shader-bind',
        shader.constructor && shader.constructor.name || 'Shader');
      return this;
    },
    createVao: function() {
      var renderer = this;
      return {
        addIndex: function() { return this; },
        addAttribute: function() { return this; },
        clear: function() { return this; },
        bind: function() { return this; },
        unbind: function() { return this; },
        draw: function() {
          nativeCompatibilityHit('renderer.vao-draw', 'direct');
          return this;
        },
        destroy: function() {
          if (renderer._activeVao === this) renderer._activeVao = null;
        }
      };
    },
    bindVao: function(vao) {
      this._activeVao = vao || null;
      return this;
    },
    reset: function() {
      this.setObjectRenderer(null);
      this._activeShader = null;
      this._activeVao = null;
      this._transform = null;
      this.state.resetToDefault();
      this.renderTexture.bind(null);
      return this;
    },
    _initContext: function() {
      this._activeShader = null;
      this._activeVao = null;
      this._nextTextureLocation = 0;
      this.boundTextures.fill(null);
      this.state.resetToDefault();
      this.bindRenderTarget(this.rootRenderTarget);
      if (typeof this.emit === 'function') this.emit('context', this.gl);
      return this;
    },
    handleContextLost: function(event) {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
    },
    handleContextRestored: function() {
      this.textureManager.removeAll();
      this.filterManager.emptyPool();
      this._initContext();
    },
    bindTexture: function(texture, location, forceLocation) {
      var base = texture && (texture.baseTexture || texture);
      if (!base) return -1;
      if (this.textureManager) this.textureManager.trackTexture(base);
      if (!forceLocation) {
        var existing = this.boundTextures.indexOf(base);
        if (existing >= 0) return existing;
        if (location === undefined || location === null) {
          this._nextTextureLocation++;
          this._nextTextureLocation %= this.boundTextures.length;
          location = this.boundTextures.length - this._nextTextureLocation - 1;
        }
      } else {
        location = location || 0;
      }
      location = Math.max(0, Math.min(textureUnitCount - 1, location | 0));
      this.boundTextures[location] = base;
      base._glTextures = base._glTextures || {};
      var glTexture = base._glTextures[this.CONTEXT_UID];
      if (!glTexture) {
        var source = base.source;
        var nativeSource = source && (source._nativeImage || source._nativeCanvas);
        glTexture = base._glTextures[this.CONTEXT_UID] = {
          texture: nativeSource || null,
          touched: this.textureGC.count,
          width: 0,
          height: 0,
          scaleMode: base.scaleMode,
          wrapMode: base.wrapMode,
          enableLinearScaling: function() { this.scaleMode = PIXI.SCALE_MODES.LINEAR; },
          enableNearestScaling: function() { this.scaleMode = PIXI.SCALE_MODES.NEAREST; },
          enableWrapClamp: function() { this.wrapMode = PIXI.WRAP_MODES.CLAMP; },
          enableWrapRepeat: function() { this.wrapMode = PIXI.WRAP_MODES.REPEAT; },
          enableWrapMirrorRepeat: function() {
            this.wrapMode = PIXI.WRAP_MODES.MIRRORED_REPEAT;
          },
          bind: function() { return this; },
          upload: function() { return this; },
          destroy: function() { this.texture = null; }
        };
      }
      var currentSource = base.source;
      glTexture.texture = currentSource &&
        (currentSource._nativeImage || currentSource._nativeCanvas) || null;
      glTexture.width = Number(base.realWidth) ||
        (Number(base.width) || 0) * (Number(base.resolution) || 1);
      glTexture.height = Number(base.realHeight) ||
        (Number(base.height) || 0) * (Number(base.resolution) || 1);
      glTexture.scaleMode = base.scaleMode;
      glTexture.wrapMode = base.wrapMode;
      glTexture._updateID = base._updateID;
      glTexture.touched = this.textureGC.count;
      base.touched = this.textureGC.count;
      return location;
    },
    unbindTexture: function(texture) {
      var base = texture && (texture.baseTexture || texture);
      for (var index = 0; index < this.boundTextures.length; index++) {
        if (this.boundTextures[index] === base) this.boundTextures[index] = null;
      }
    },
    render: function(stage, renderTexture, clear, transform,
        skipUpdateTransform) {
      if (!this._pmjsPreparingBitmapCache) {
        this._pmjsPreparingBitmapCache = true;
        try {
          prepareNativeBitmapCaches(stage, this);
        } finally {
          this._pmjsPreparingBitmapCache = false;
        }
      }
      this.stage = stage;
      this._lastObjectRendered = stage;
      this.renderingToScreen = !renderTexture;
      this._nextTextureLocation = 0;
      if (typeof this.emit === 'function') this.emit('prerender');
      nativeSceneBackgroundColor = !renderTexture && this.clearBeforeRender &&
        !this.transparent ? this._backgroundColor : null;
      if (renderTexture) {
        var base = renderTexture.baseTexture;
        if (!base || base.width <= 0 || base.height <= 0) {
          throw new Error('native RenderTexture has invalid dimensions');
        }
        var resolution = Math.max(0.000001, Number(base.resolution) || 1);
        var targetWidth = Math.ceil(base.width * resolution);
        var targetHeight = Math.ceil(base.height * resolution);
        var target = base.__pmjsRenderCanvas;
        if (!target) {
          target = new CanvasElement();
          target.width = targetWidth;
          target.height = targetHeight;
          base.__pmjsRenderCanvas = target;
          base.source = target;
        } else if (target.width !== targetWidth || target.height !== targetHeight) {
          target.width = targetWidth;
          target.height = targetHeight;
        }
        if (clear === false) {
          NativeHost.render.image(target._ensureNativeCanvas().handle,
            1, 0, 0, 1, 0, 0, 0, 0, targetWidth, targetHeight,
            1, 0xffffff, 0);
        }
        NativeHost.render.setRenderTargetSize(targetWidth, targetHeight);
        var resolutionTransform = { a: resolution, b: 0, c: 0,
          d: resolution, tx: 0, ty: 0 };
        renderNativeStage(stage, transform ?
          nativeComposeTransform(resolutionTransform, transform) :
          resolutionTransform, resolution, this.roundPixels,
          skipUpdateTransform);
        NativeHost.render.renderToCanvas(target._ensureNativeCanvas().handle);
        target._pmjsContentChanged();
        this.textureGC.update();
        if (typeof this.emit === 'function') this.emit('postrender');
        return;
      }
      var screenWidth = this.width;
      var screenHeight = this.height;
      NativeHost.render.setScreenRenderSize(screenWidth, screenHeight);
      var screenTransform = { a: this.resolution, b: 0, c: 0,
        d: this.resolution, tx: 0, ty: 0 };
      renderNativeStage(stage, transform ?
        nativeComposeTransform(screenTransform, transform) : screenTransform,
        this.resolution, this.roundPixels, skipUpdateTransform);
      var video = Graphics._video;
      if (video && video._nativeCanvas && video.style.opacity > 0) {
        NativeHost.render.image(video._nativeCanvas.handle,
          screenWidth / video.videoWidth, 0, 0,
          screenHeight / video.videoHeight, 0, 0,
          0, 0, video.videoWidth, video.videoHeight, 1, 0xffffff, 0);
      }
      this.textureGC.update();
      if (typeof this.emit === 'function') this.emit('postrender');
    },
    extract: {
      base64: function(target) {
        return this.canvas(target).toDataURL();
      },
      image: function(target) {
        var canvas = this.canvas(target);
        var image = new Image();
        image._src = canvas.toDataURL();
        image._nativeCanvas = canvas;
        image.width = image.naturalWidth = canvas.width;
        image.height = image.naturalHeight = canvas.height;
        image.complete = true;
        return image;
      },
      canvas: function(target) {
        var renderCanvas = target && target.baseTexture &&
          target.baseTexture.__pmjsRenderCanvas;
        if (renderCanvas) {
          var renderResolution = Math.max(0.000001,
            Number(target.baseTexture.resolution) || 1);
          var frame = target.frame;
          if (!frame) frame = { x: 0, y: 0,
            width: target.baseTexture.width, height: target.baseTexture.height };
          var cropWidth = Math.ceil(frame.width * renderResolution);
          var cropHeight = Math.ceil(frame.height * renderResolution);
          var croppedCanvas = new CanvasElement();
          croppedCanvas.width = cropWidth;
          croppedCanvas.height = cropHeight;
          NativeHost.canvas.writePixels(croppedCanvas._ensureNativeCanvas().handle,
            0, 0, cropWidth, cropHeight, NativeHost.canvas.readPixels(
              renderCanvas._ensureNativeCanvas().handle,
              Math.floor(frame.x * renderResolution),
              Math.floor(frame.y * renderResolution), cropWidth, cropHeight));
          croppedCanvas._pmjsContentChanged();
          return croppedCanvas;
        }
        if (PIXI.RenderTexture && target instanceof PIXI.RenderTexture) {
          renderCanvas = new CanvasElement();
          var targetResolution = Math.max(0.000001,
            Number(target.baseTexture.resolution) || 1);
          renderCanvas.width = Math.ceil(target.baseTexture.width * targetResolution);
          renderCanvas.height = Math.ceil(target.baseTexture.height * targetResolution);
          target.baseTexture.__pmjsRenderCanvas = renderCanvas;
          target.baseTexture.source = renderCanvas;
          return this.canvas(target);
        }
        if (!target) {
          var screenCanvas = new CanvasElement();
          screenCanvas.width = this.renderer.width;
          screenCanvas.height = this.renderer.height;
          screenCanvas._nativeCanvas = trackNativeResource(
            NativeHost.canvas.captureScene(), 'canvas');
          screenCanvas._pmjsContentChanged();
          return screenCanvas;
        }
        var renderTexture = this.renderer.generateTexture(target);
        var width = Math.ceil(renderTexture.width *
          (Number(renderTexture.baseTexture.resolution) || 1));
        var height = Math.ceil(renderTexture.height *
          (Number(renderTexture.baseTexture.resolution) || 1));
        var pixels = this.pixels(renderTexture);
        var canvas = new CanvasElement();
        canvas.width = width;
        canvas.height = height;
        NativeHost.canvas.writePixels(canvas._ensureNativeCanvas().handle,
          0, 0, width, height, pixels);
        canvas._pmjsContentChanged();
        renderTexture.destroy(true);
        return canvas;
      },
      pixels: function(target) {
        if (!target) {
          var capture = NativeHost.canvas.captureScene();
          try {
            return NativeHost.canvas.readPixels(capture.handle, 0, 0,
              this.renderer.width, this.renderer.height);
          } finally {
            if (typeof releaseNativeResource === 'function') {
              releaseNativeResource(capture, 'canvas');
            } else {
              NativeHost.canvas.release(capture.handle);
            }
          }
        }
        var generated = null;
        var renderTexture = target;
        if (PIXI.RenderTexture && target instanceof PIXI.RenderTexture &&
            !target.baseTexture.__pmjsRenderCanvas) {
          this.canvas(target);
        } else if (!target.baseTexture || !target.baseTexture.__pmjsRenderCanvas) {
          generated = this.renderer.generateTexture(target);
          renderTexture = generated;
        }
        var canvas = renderTexture.baseTexture.__pmjsRenderCanvas;
        var resolution = Math.max(0.000001,
          Number(renderTexture.baseTexture.resolution) || 1);
        try {
          return NativeHost.canvas.readPixels(canvas._ensureNativeCanvas().handle,
            Math.floor(renderTexture.frame.x * resolution),
            Math.floor(renderTexture.frame.y * resolution),
            Math.ceil(renderTexture.width * resolution),
            Math.ceil(renderTexture.height * resolution));
        } finally {
          if (generated) generated.destroy(true);
        }
      }
    },
    generateTexture: function(displayObject, scaleMode, resolution, region) {
      region = region || displayObject.getLocalBounds();
      var renderTexture = PIXI.RenderTexture.create(region.width | 0,
        region.height | 0, scaleMode, resolution);
      this.render(displayObject, renderTexture, false,
        { a: 1, b: 0, c: 0, d: 1, tx: -region.x, ty: -region.y });
      return renderTexture;
    },
    generateTextureGpu: function(displayObject, scaleMode, resolution, region) {
      resolution = Math.max(0.000001, Number(resolution) || 1);
      region = region || displayObject.getLocalBounds();
      prepareNativeBitmapCaches(displayObject, this);
      var targetWidth = Math.max(1, Math.ceil(region.width * resolution));
      var targetHeight = Math.max(1, Math.ceil(region.height * resolution));
      this.stage = displayObject;
      this._lastObjectRendered = displayObject;
      this.renderingToScreen = false;
      this._nextTextureLocation = 0;
      if (typeof this.emit === 'function') this.emit('prerender');
      NativeHost.render.setRenderTargetSize(targetWidth, targetHeight);
      var resolutionTransform = { a: resolution, b: 0, c: 0,
        d: resolution, tx: -region.x * resolution, ty: -region.y * resolution };
      renderNativeStage(displayObject, resolutionTransform, resolution,
        this.roundPixels);
      var resource = NativeHost.render.renderToImage(targetWidth, targetHeight);
      var source = nativeImageFromResource(resource);
      var baseTexture = new PIXI.BaseTexture(source, scaleMode, resolution);
      baseTexture.width = region.width;
      baseTexture.height = region.height;
      baseTexture.realWidth = targetWidth;
      baseTexture.realHeight = targetHeight;
      var texture = new PIXI.Texture(baseTexture,
        new PIXI.Rectangle(0, 0, region.width, region.height));
      this.textureGC.update();
      if (typeof this.emit === 'function') this.emit('postrender');
      return texture;
    },
    resize: function(width, height) {
      this.screen.width = Number(width) || 0;
      this.screen.height = Number(height) || 0;
      this.width = Math.max(1, Math.floor(this.screen.width * this.resolution));
      this.height = Math.max(1, Math.floor(this.screen.height * this.resolution));
      if (this.view) {
        this.view.width = this.width;
        this.view.height = this.height;
        if (this.autoResize && this.view.style) {
          this.view.style.width = this.screen.width + 'px';
          this.view.style.height = this.screen.height + 'px';
        }
      }
      this.rootRenderTarget.resolution = this.resolution;
      this.rootRenderTarget.resize(width, height);
    },
    textureGC: null,
    destroy: function(removeView) {
      this.flush();
      Object.keys(this.plugins || {}).forEach(function(name) {
        var plugin = this.plugins[name];
        if (plugin && typeof plugin.destroy === 'function') plugin.destroy();
        this.plugins[name] = null;
      }, this);
      this.maskManager.destroy();
      this.filterManager.destroy();
      this.renderTexture.destroy();
      this.stencilManager.destroy();
      this.textureManager.destroy();
      this.rootRenderTarget.destroy();
      this.state.destroy();
      this.boundTextures.length = 0;
      if (this.view && typeof this.view.removeEventListener === 'function') {
        this.view.removeEventListener('webglcontextlost', this.handleContextLost,
          false);
        this.view.removeEventListener('webglcontextrestored',
          this.handleContextRestored, false);
      }
      if (removeView && this.view && this.view.parentNode) {
        this.view.parentNode.removeChild(this.view);
      }
      if (typeof this.removeAllListeners === 'function') this.removeAllListeners();
      this._lastObjectRendered = null;
      this._tempDisplayObjectParent = null;
      this.state = null;
      this.view = null;
      this.gl = null;
    }
  };
  renderer.currentRenderer = renderer.emptyRenderer;
  if (PIXI.utils && typeof PIXI.utils.EventEmitter === 'function') {
    PIXI.utils.EventEmitter.call(renderer);
  }
  renderer.rootRenderTarget = createNativeRenderTarget(renderer, width, height,
    resolution, true);
  renderer.handleContextLost = renderer.handleContextLost.bind(renderer);
  renderer.handleContextRestored = renderer.handleContextRestored.bind(renderer);
  if (renderer.view && typeof renderer.view.addEventListener === 'function') {
    renderer.view.addEventListener('webglcontextlost', renderer.handleContextLost,
      false);
    renderer.view.addEventListener('webglcontextrestored',
      renderer.handleContextRestored, false);
  }
  renderer.state = {
    activeState: new Uint8Array(16),
    defaultState: new Uint8Array(16),
    stackIndex: 0,
    stack: [],
    blendMode: 0,
    blend: true,
    depthTest: false,
    frontFace: false,
    cullFace: false,
    push: function() {
      this.stack[this.stackIndex++] = new Uint8Array(this.activeState);
    },
    pop: function() {
      if (!this.stackIndex) return;
      this.setState(this.stack[--this.stackIndex]);
    },
    setState: function(state) {
      if (!state) return;
      this.setBlend(state[0]);
      this.setDepthTest(state[1]);
      this.setFrontFace(state[2]);
      this.setCullFace(state[3]);
      this.setBlendMode(state[4]);
    },
    set: function(state) { this.setState(state); },
    setBlend: function(value) {
      this.blend = !!value;
      this.activeState[0] = this.blend ? 1 : 0;
    },
    setBlendMode: function(mode) {
      this.blendMode = Number(mode) || 0;
      this.activeState[4] = this.blendMode;
    },
    setDepthTest: function(value) {
      this.depthTest = !!value;
      this.activeState[1] = this.depthTest ? 1 : 0;
    },
    setFrontFace: function(value) {
      this.frontFace = !!value;
      this.activeState[2] = this.frontFace ? 1 : 0;
    },
    setCullFace: function(value) {
      this.cullFace = !!value;
      this.activeState[3] = this.cullFace ? 1 : 0;
    },
    resetAttributes: function() {},
    resetToDefault: function() {
      this.activeState.fill(0);
      this.stackIndex = 0;
      this.blendMode = 0;
      this.setBlend(true);
      this.setDepthTest(false);
      this.setFrontFace(false);
      this.setCullFace(false);
      this.setBlendMode(0);
    },
    destroy: function() {
      this.stack.length = 0;
      this.activeState = null;
      this.defaultState = null;
    }
  };
  renderer.state.defaultState[0] = 1;
  renderer.state.resetToDefault();
  for (var textureIndex = 0; textureIndex < textureUnitCount; textureIndex++) {
    renderer.boundTextures[textureIndex] = null;
    renderer.emptyTextures[textureIndex] = PIXI.Texture.EMPTY &&
      PIXI.Texture.EMPTY.baseTexture || null;
  }
  renderer.textureManager = {
    renderer: renderer,
    gl: renderer.gl,
    _managedTextures: [],

    bindTexture: function() {},
    getTexture: function() {},
    trackTexture: function(base) {
      if (base && this._managedTextures.indexOf(base) < 0) {
        this._managedTextures.push(base);
      }
      if (base && typeof base.on === 'function') {
        base.__pmjsTextureDisposeListeners =
          base.__pmjsTextureDisposeListeners || {};
        if (!base.__pmjsTextureDisposeListeners[this.renderer.CONTEXT_UID]) {
          var manager = this;
          var dispose = function() { manager.destroyTexture(base); };
          base.__pmjsTextureDisposeListeners[this.renderer.CONTEXT_UID] = dispose;
          base.on('dispose', dispose);
        }
      }
    },
    updateTexture: function(texture, location) {
      var base = texture && (texture.baseTexture || texture);
      this.trackTexture(base);
      return this.renderer.bindTexture(base, location, true);
    },
    destroyTexture: function(texture) {
      this.renderer.unbindTexture(texture);
      var base = texture && (texture.baseTexture || texture);
      if (base && base._glTextures) {
        var glTexture = base._glTextures[this.renderer.CONTEXT_UID];
        if (glTexture && typeof glTexture.destroy === 'function') glTexture.destroy();
        delete base._glTextures[this.renderer.CONTEXT_UID];
      }
      var listeners = base && base.__pmjsTextureDisposeListeners;
      var listener = listeners && listeners[this.renderer.CONTEXT_UID];
      if (listener && typeof base.off === 'function') base.off('dispose', listener);
      if (listeners) delete listeners[this.renderer.CONTEXT_UID];
      var managedIndex = this._managedTextures.indexOf(base);
      if (managedIndex >= 0) this._managedTextures.splice(managedIndex, 1);
    },
    removeAll: function() {
      var textures = this._managedTextures.slice();
      for (var index = 0; index < textures.length; index++) {
        this.destroyTexture(textures[index]);
      }
      this.renderer.boundTextures.fill(null);
    },
    destroy: function() {
      this.removeAll();
      this.renderer = null;
    }
  };
  renderer.textureManager.managedTextures = renderer.textureManager._managedTextures;
  renderer.textureGC = new NativeTextureGarbageCollector(renderer);
  renderer._activeRenderTarget = renderer.rootRenderTarget;
  renderer.stencilManager = {
    renderer: renderer,
    gl: renderer.gl,
    stencilMaskStack: [],
    pushStencil: function(mask) { this.stencilMaskStack.push(mask); },
    popStencil: function() { return this.stencilMaskStack.pop(); },
    setMaskStack: function(stack) { this.stencilMaskStack = stack || []; },
    _useCurrent: function() { return this.stencilMaskStack.length; },
    _getBitwiseMask: function() {
      return (1 << this.stencilMaskStack.length) - 1;
    },
    onContextChange: function() { this.gl = this.renderer.gl; },
    destroy: function() {
      this.stencilMaskStack.length = 0;
      this.renderer = null;
      this.gl = null;
    }
  };
  renderer.maskManager = new NativeMaskManager(renderer);
  renderer.filterManager = new NativeFilterManager(renderer);
  renderer.renderTexture = new NativeRenderTextureManager(renderer);
  Object.defineProperty(renderer, 'backgroundColor', {
    configurable: true,
    get: function() { return this._backgroundColor; },
    set: function(value) {
      value = Number(value) >>> 0;
      this._backgroundColor = value & 0xffffff;
      this._backgroundColorString = '#' +
        ('000000' + this._backgroundColor.toString(16)).slice(-6);
      this._backgroundColorRgb[0] = (this._backgroundColor >> 16 & 255) / 255;
      this._backgroundColorRgb[1] = (this._backgroundColor >> 8 & 255) / 255;
      this._backgroundColorRgb[2] = (this._backgroundColor & 255) / 255;
      this._backgroundColorRgba[0] = this._backgroundColorRgb[0];
      this._backgroundColorRgba[1] = this._backgroundColorRgb[1];
      this._backgroundColorRgba[2] = this._backgroundColorRgb[2];
      this._backgroundColorRgba[3] = this.transparent ? 0 : 1;
    }
  });
  renderer.backgroundColor = renderer._backgroundColor;
  renderer.extract.renderer = renderer;
  renderer.plugins = installNativeRendererPlugins(renderer);
  renderer.resize(width, height);
  return renderer;
}

var OriginalPixiWebGLRenderer = PIXI.WebGLRenderer;
var NativePixiWebGLRenderer = function(width, height, options) {
  var renderer = createNativePixiRenderer(width, height, options);
  if (Object.setPrototypeOf) Object.setPrototypeOf(renderer,
    NativePixiWebGLRenderer.prototype);
  return renderer;
};
NativePixiWebGLRenderer.prototype = OriginalPixiWebGLRenderer.prototype;
NativePixiWebGLRenderer.prototype.constructor = NativePixiWebGLRenderer;
Object.keys(OriginalPixiWebGLRenderer).forEach(function(key) {
  NativePixiWebGLRenderer[key] = OriginalPixiWebGLRenderer[key];
});
PIXI.WebGLRenderer = NativePixiWebGLRenderer;
PIXI.autoDetectRenderer = function(width, height, options) {
  return new NativePixiWebGLRenderer(width, height, options);
};
