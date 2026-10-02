(function() {
  var rendererPlugins = PIXI.WebGLRenderer &&
    PIXI.WebGLRenderer.__plugins || {};
  var baselinePlugins = Object.assign({}, rendererPlugins);
  var knownClasses = {
    ShaderTilemap: globalThis.ShaderTilemap,
    WindowLayer: globalThis.WindowLayer,
    ToneSprite: globalThis.ToneSprite,
    ScreenSprite: globalThis.ScreenSprite,
    MVTilingSprite: globalThis.TilingSprite,
    MVSprite: globalThis.Sprite,
    Window: globalThis.Window,
    Tilemap: globalThis.Tilemap,
    Weather: globalThis.Weather,
    Stage: globalThis.Stage,
    PictureTilingSprite: PIXI.extras && PIXI.extras.PictureTilingSprite,
    TilingSprite: PIXI.extras && PIXI.extras.TilingSprite,
    BitmapText: PIXI.extras && PIXI.extras.BitmapText,
    Text: PIXI.Text,
    RectTileLayer: PIXI.tilemap && PIXI.tilemap.RectTileLayer,
    CompositeRectTileLayer: PIXI.tilemap && PIXI.tilemap.CompositeRectTileLayer,
    ParticleContainer: PIXI.particles && PIXI.particles.ParticleContainer,
    Mesh: PIXI.mesh && PIXI.mesh.Mesh,
    Graphics: PIXI.Graphics,
    Sprite: PIXI.Sprite,
    Container: PIXI.Container,
    DisplayObject: PIXI.DisplayObject
  };
  var renderMethods = ['renderWebGL', '_renderWebGL',
    'renderCanvas', '_renderCanvas'];
  var classNames = Object.keys(knownClasses);

  var baselineMethods = {};
  var baselineWebGLMethods = new WeakMap();
  var cachedWebGL = PIXI.DisplayObject &&
    PIXI.DisplayObject.prototype._renderCachedWebGL;
  var emptyMethods = {};
  classNames.forEach(function(name) {
    var proto = knownClasses[name] && knownClasses[name].prototype;
    if (!proto) return;
    baselineWebGLMethods.set(proto, {
      renderWebGL: proto.renderWebGL,
      _renderWebGL: proto._renderWebGL,
      // These stock entry points draw directly without dispatching the leaf hook.
      callsLeaf: name !== 'WindowLayer' && name !== 'ParticleContainer' &&
        name !== 'RectTileLayer' && name !== 'CompositeRectTileLayer'
    });
    baselineMethods[name] = {};
    renderMethods.forEach(function(method) {
      baselineMethods[name][method] =
        Object.prototype.hasOwnProperty.call(proto, method) ? proto[method] :
          undefined;
    });
  });

  function unsupportedMethod(node) {
    var proto = Object.getPrototypeOf(node);
    var baseline;
    while (proto && !(baseline = baselineWebGLMethods.get(proto))) {
      proto = Object.getPrototypeOf(proto);
    }
    baseline = baseline || emptyMethods;
    var renderWebGL = node.renderWebGL;
    if (cachedWebGL && node._cacheAsBitmap && renderWebGL === cachedWebGL) {
      // A realized cache draws its snapshot, not the original node's hooks.
      if (!node.__pmjsBuildingBitmapCache && node._cacheData &&
          node._cacheData.sprite) return null;
      renderWebGL = node._cacheData && node._cacheData.originalRenderWebGL;
    }
    if (renderWebGL !== baseline.renderWebGL) return 'renderWebGL';
    if (baseline.callsLeaf !== false &&
        node._renderWebGL !== baseline._renderWebGL) return '_renderWebGL';
    return null;
  }

  function check(node) {
    var method = unsupportedMethod(node);
    if (method) {
      PMJS.compat.hit('render.render-method',
        (node.constructor && node.constructor.name || 'node') + '.' + method);
    }
  }

  var report = { rendererPlugins: [], renderMethodOverrides: [] };
  function scan() {
    var currentPlugins = PIXI.WebGLRenderer &&
      PIXI.WebGLRenderer.__plugins || {};
    report.rendererPlugins = Object.keys(currentPlugins).filter(function(name) {
      return currentPlugins[name] !== baselinePlugins[name];
    }).sort();
    report.renderMethodOverrides = [];
    Object.keys(baselineMethods).forEach(function(name) {
      var proto = knownClasses[name] && knownClasses[name].prototype;
      renderMethods.forEach(function(method) {
        var current = Object.prototype.hasOwnProperty.call(proto, method) ?
          proto[method] : undefined;
        if (current !== baselineMethods[name][method]) {
          report.renderMethodOverrides.push(name + '.' + method);
        }
      });
    });
    report.rendererPlugins.forEach(function(name) {
      PMJS.compat.observed('render.rendererPluginRegistration', name);
    });
    report.renderMethodOverrides.forEach(function(name) {
      PMJS.compat.observed('render.renderMethodOverride', name);
    });
    return report;
  }

  globalThis.pmjsPixiRenderPreflight = { scan: scan, report: report,
    unsupportedMethod: unsupportedMethod, check: check };
})();
