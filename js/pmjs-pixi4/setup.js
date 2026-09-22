nativeBootPhase('adapter-ready');
var pmjsMvRuntimeGame = globalThis.PMJS_RUNTIME_GAME;
NativeHost.runtime.loadScript(pmjsMvRuntimeGame ?
  pmjsMvRuntimeGame.pixiPath : 'js/libs/pixi.js');
if (!globalThis.PIXI || typeof PIXI.Container !== 'function') {
  throw new Error('Pixi object model did not initialize');
}
if (pmjsMvRuntimeGame && PIXI.VERSION !== pmjsMvRuntimeGame.pixiVersion) {
  throw new Error('inspected Pixi ' + pmjsMvRuntimeGame.pixiVersion +
    ' but loaded ' + PIXI.VERSION);
}
NativeHost.runtime.loadScript(pmjsMvRuntimeGame ?
  pmjsMvRuntimeGame.pixiTilemapPath : 'js/libs/pixi-tilemap.js');
// Retain compiled tile layers to avoid per-tile JS/native calls every frame.
if (PIXI.tilemap && PIXI.tilemap.RectTileLayer) {
  (function() {
    var proto = PIXI.tilemap.RectTileLayer.prototype;
    var clear = proto.clear;
    proto.clear = function() {
      this._pmjsNativeGeneration = (this._pmjsNativeGeneration || 0) + 1;
      return clear.apply(this, arguments);
    };
    var destroy = proto.destroy;
    proto.destroy = function() {
      if (this._pmjsNativeLayer) {
        NativeHost.render.releaseTileLayer(this._pmjsNativeLayer);
        this._pmjsNativeLayer = 0;
      }
      return destroy && destroy.apply(this, arguments);
    };
  })();
}
if (PIXI.mesh && PIXI.mesh.Mesh) {
  (function() {
    var proto = PIXI.mesh.Mesh.prototype;
    var destroy = proto.destroy;
    proto.destroy = function() {
      if (this.__pmjsNativeMesh) {
        NativeHost.render.releaseMesh(this.__pmjsNativeMesh);
        this.__pmjsNativeMesh = 0;
      }
      return destroy && destroy.apply(this, arguments);
    };
  })();
}
if (PIXI.Graphics) {
  (function() {
    var destroy = PIXI.Graphics.prototype.destroy;
    PIXI.Graphics.prototype.destroy = function() {
      var canvas = this.__pmjsGraphicsCanvas;
      var maskCanvas = this.__pmjsGraphicsMaskCanvas;
      if (canvas) canvas._releaseNativeCanvas();
      if (maskCanvas && maskCanvas !== canvas) maskCanvas._releaseNativeCanvas();
      this.__pmjsGraphicsCanvas = null;
      this.__pmjsGraphicsMaskCanvas = null;
      return destroy && destroy.apply(this, arguments);
    };
  })();
}
if (PIXI.Texture) {
  (function() {
    var destroy = PIXI.Texture.prototype.destroy;
    PIXI.Texture.prototype.destroy = function() {
      if (this.__pmjsTilingCanvas) {
        this.__pmjsTilingCanvas._releaseNativeCanvas();
        this.__pmjsTilingCanvas = null;
      }
      return destroy && destroy.apply(this, arguments);
    };
  })();
}
function installNativePictureTilingSprite() {
  var Original = PIXI.extras && PIXI.extras.PictureTilingSprite;
  if (!Original || Original.__pmjsNativeTilingSprite) return;
  function PictureTilingSprite(texture) {
    Original.call(this, texture);
    // pixi-picture labels both sprite classes as "picture". Preserve the
    // tiling leaf identity so PictureTilingSprite reaches tiled rendering.
    this.pluginName = 'tilingsprite';
  }
  PictureTilingSprite.prototype = Object.create(Original.prototype);
  PictureTilingSprite.prototype.constructor = PictureTilingSprite;
  PictureTilingSprite.__pmjsNativeTilingSprite = true;
  PIXI.extras.PictureTilingSprite = PictureTilingSprite;
}
function releaseNativeRenderCanvas(baseTexture) {
  var renderTargets = baseTexture && baseTexture._glRenderTargets;
  if (renderTargets) {
    Object.keys(renderTargets).forEach(function(key) {
      var target = renderTargets[key];
      if (target && typeof target.destroy === 'function') target.destroy();
      delete renderTargets[key];
    });
  }
  var source = baseTexture && baseTexture.__pmjsRenderCanvas;
  if (!source) return;
  source._releaseNativeCanvas();
  baseTexture.__pmjsRenderCanvas = null;
  if (baseTexture.source === source) baseTexture.source = null;
}
if (PIXI.BaseTexture) {
  (function() {
    var destroy = PIXI.BaseTexture.prototype.destroy;
    PIXI.BaseTexture.prototype.destroy = function() {
      var source = this.source;
      var result = destroy && destroy.apply(this, arguments);
      if (source && source._pmjsOwnedTextureSource &&
          source instanceof NativeImage) source.src = '';
      return result;
    };
  })();
}
if (PIXI.BaseRenderTexture) {
  (function() {
    var destroy = PIXI.BaseRenderTexture.prototype.destroy;
    PIXI.BaseRenderTexture.prototype.destroy = function() {
      releaseNativeRenderCanvas(this);
      return destroy && destroy.apply(this, arguments);
    };
  })();
}
NativeHost.runtime.loadScript('js/libs/pixi-picture.js');
installNativePictureTilingSprite();
NativeHost.runtime.loadScript('js/libs/lz-string.js');
NativeHost.runtime.loadScript('js/libs/iphone-inline-video.browser.js');
