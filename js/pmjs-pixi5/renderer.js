'use strict';

(function() {
  function createRenderer(options) {
    options = Object.assign({
      width: 800,
      height: 600,
      resolution: 1,
      backgroundColor: 0,
      transparent: false,
      clearBeforeRender: true,
      autoDensity: false
    }, options || {});
    var resolution = Math.max(0.000001, Number(options.resolution) || 1);
    function renderTextureCanvas(renderTexture) {
      var base = renderTexture && renderTexture.baseTexture;
      if (!base) throw new Error('native RenderTexture has no base texture');
      var targetResolution = Math.max(0.000001,
        Number(base.resolution) || 1);
      var targetWidth = Math.max(1, Math.ceil(base.width * targetResolution));
      var targetHeight = Math.max(1, Math.ceil(base.height * targetResolution));
      var target = base.__pmjsPixi5RenderCanvas;
      if (!target) {
        target = base.__pmjsPixi5RenderCanvas = new CanvasElement();
      }
      if (target.width !== targetWidth) target.width = targetWidth;
      if (target.height !== targetHeight) target.height = targetHeight;
      return target;
    }

    var renderer = {
      type: PIXI.RENDERER_TYPE.WEBGL,
      options: options,
      view: options.view || document.createElement('canvas'),
      resolution: resolution,
      screen: new PIXI.Rectangle(0, 0, 0, 0),
      width: 0,
      height: 0,
      backgroundColor: Number(options.backgroundColor) >>> 0 & 0xffffff,
      transparent: !!options.transparent,
      clearBeforeRender: options.clearBeforeRender !== false,
      roundPixels: !!options.roundPixels,
      gl: {
        isContextLost: function() { return false; },
        flush: function() {}
      },
      render: function(stage, renderTexture) {
        if (!stage) return;
        if (renderTexture) {
          var target = renderTextureCanvas(renderTexture);
          var targetResolution = Math.max(0.000001,
            Number(renderTexture.baseTexture.resolution) || 1);
          NativeHost.render.setRenderTargetSize(target.width, target.height);
          globalThis.pmjsPixi5RenderScene(stage, null, targetResolution);
          NativeHost.render.renderToCanvas(target._ensureNativeCanvas().handle);
          if (typeof target._pmjsContentChanged === 'function') {
            target._pmjsContentChanged();
          }
          return;
        }
        NativeHost.render.setScreenRenderSize(this.width, this.height);
        var background = this.clearBeforeRender && !this.transparent ?
          this.backgroundColor : null;
        globalThis.pmjsPixi5RenderScene(stage, background, this.resolution);
      },
      resize: function(width, height) {
        this.screen.width = Math.max(0, Number(width) || 0);
        this.screen.height = Math.max(0, Number(height) || 0);
        this.width = Math.max(1, Math.floor(this.screen.width * this.resolution));
        this.height = Math.max(1, Math.floor(this.screen.height * this.resolution));
        this.view.width = this.width;
        this.view.height = this.height;
        if (options.autoDensity && this.view.style) {
          this.view.style.width = this.screen.width + 'px';
          this.view.style.height = this.screen.height + 'px';
        }
        NativeHost.render.setScreenRenderSize(this.width, this.height);
      },
      destroy: function(removeView) {
        if (removeView && this.view && this.view.parentNode) {
          this.view.parentNode.removeChild(this.view);
        }
        this.view = null;
      }
    };
    renderer.extract = {
      renderer: renderer,
      canvas: function(target) {
        if (target && target.baseTexture) return renderTextureCanvas(target);
        var capture = new CanvasElement();
        capture.width = renderer.width;
        capture.height = renderer.height;
        capture._nativeCanvas = NativeHost.canvas.captureScene();
        if (typeof capture._pmjsContentChanged === 'function') {
          capture._pmjsContentChanged();
        }
        return capture;
      }
    };
    renderer.resize(options.width, options.height);
    return renderer;
  }

  var OriginalRenderer = PIXI.Renderer;
  function NativeRenderer(options) {
    var renderer = createRenderer(options);
    if (Object.setPrototypeOf && OriginalRenderer && OriginalRenderer.prototype) {
      Object.setPrototypeOf(renderer, NativeRenderer.prototype);
    }
    return renderer;
  }
  if (OriginalRenderer && OriginalRenderer.prototype) {
    NativeRenderer.prototype = Object.create(OriginalRenderer.prototype);
    NativeRenderer.prototype.constructor = NativeRenderer;
    Object.setPrototypeOf(NativeRenderer, OriginalRenderer);
  }
  NativeRenderer.create = createRenderer;

  var OriginalApplication = PIXI.Application;
  function NativeApplication(options) {
    options = Object.assign({ forceCanvas: false }, options || {});
    this.renderer = createRenderer(options);
    this.stage = new PIXI.Container();
    OriginalApplication._plugins.forEach(function(plugin) {
      plugin.init.call(this, options);
    }, this);
  }
  NativeApplication.prototype = Object.create(OriginalApplication.prototype);
  NativeApplication.prototype.constructor = NativeApplication;
  Object.setPrototypeOf(NativeApplication, OriginalApplication);
  NativeApplication._plugins = OriginalApplication._plugins;

  PIXI.Renderer = NativeRenderer;
  PIXI.autoDetectRenderer = createRenderer;
  PIXI.Application = NativeApplication;
})();
