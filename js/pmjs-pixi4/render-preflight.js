(function() {
  globalThis.PMJS = globalThis.PMJS || {};
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

  var nativeBaselineContracts = {
    ShaderTilemap: 'container', WindowLayer: 'container',
    ToneSprite: 'container', ScreenSprite: 'screensprite',
    MVTilingSprite: 'tilingsprite', MVSprite: 'sprite',
    Window: 'container', Tilemap: 'container', Weather: 'container',
    Stage: 'container', PictureTilingSprite: 'tilingsprite',
    TilingSprite: 'tilingsprite',
    BitmapText: { kind: 'container', prepare: function(node) {
      if (typeof node.validate === 'function') node.validate();
    } },
    Text: { kind: 'sprite', prepare: function(node, resolution) {
      if (node.resolution !== resolution) {
        node.resolution = resolution;
        node.dirty = true;
      }
      if (typeof node.updateText === 'function') node.updateText(true);
    } },
    RectTileLayer: 'recttilelayer', ParticleContainer: 'container',
    Mesh: { kind: 'mesh', prepare: function(node) {
      if (typeof node.refresh === 'function') node.refresh();
    } }, Graphics: 'graphics', Sprite: 'sprite',
    Container: 'container'
  };
  var baselineMethods = {};
  var baselineEffectiveMethods = {};
  var baselineCachedRender = PIXI.DisplayObject &&
    PIXI.DisplayObject.prototype._renderCachedWebGL;
  classNames.forEach(function(name) {
    var proto = knownClasses[name] && knownClasses[name].prototype;
    if (!proto) return;
    baselineMethods[name] = {};
    baselineEffectiveMethods[name] = {
      renderWebGL: proto.renderWebGL,
      _renderWebGL: proto._renderWebGL
    };
    renderMethods.forEach(function(method) {
      baselineMethods[name][method] =
        Object.prototype.hasOwnProperty.call(proto, method) ? proto[method] :
          undefined;
    });
  });

  var contractCache = new WeakMap();
  var preparationCache = new WeakMap();
  PMJS.rendererContracts = {
    prepare: function(node, resolution) {
      var proto = Object.getPrototypeOf(node);
      if (proto && preparationCache.has(proto)) {
        var cachedPreparation = preparationCache.get(proto);
        if (cachedPreparation) cachedPreparation(node, resolution);
        return;
      }
      var preparation = null;
      for (var index = 0; index < classNames.length; index++) {
        var name = classNames[index];
        var ctor = knownClasses[name];
        if (typeof ctor !== 'function' || !(node instanceof ctor)) continue;
        var contract = nativeBaselineContracts[name];
        preparation = contract && contract.prepare || null;
        break;
      }
      if (proto) preparationCache.set(proto, preparation);
      if (preparation) preparation(node, resolution);
    },
    prove: function(node, kind, originalWebgl) {
      var webgl = arguments.length > 2 ? originalWebgl : node.renderWebGL;
      var inner = node._renderWebGL;
      var own = Object.prototype.hasOwnProperty.call(node, 'renderWebGL') ||
        Object.prototype.hasOwnProperty.call(node, '_renderWebGL');
      var proto = Object.getPrototypeOf(node);
      var cached = !own && proto && contractCache.get(proto);
      if (cached && cached.kind === kind && cached.webgl === webgl &&
          cached.inner === inner) {
        return cached.reason;
      }
      var expected = null;
      var baselineKind = null;
      classNames.some(function(name) {
        var ctor = knownClasses[name];
        if (typeof ctor !== 'function' || !(node instanceof ctor)) return false;
        expected = baselineEffectiveMethods[name];
        var contract = nativeBaselineContracts[name];
        baselineKind = contract && (contract.kind || contract) || null;
        return true;
      });
      var reason = '';
      if (expected && baselineKind !== kind) {
        reason = baselineKind ? 'native representation mismatch' :
          'no native semantic contract';
      } else if (expected) {
        if (webgl !== expected.renderWebGL) reason = 'renderWebGL';
        else if (inner !== expected._renderWebGL) reason = '_renderWebGL';
      } else if (kind === 'recttilelayer' &&
          typeof webgl !== 'function' && typeof inner !== 'function') {

        reason = '';
      } else {
        reason = 'no native semantic contract';
      }
      if (!own && proto) contractCache.set(proto, {
        kind: kind, webgl: webgl, inner: inner, reason: reason
      });
      return reason;
    },
    proveCached: function(node, kind) {
      if (typeof baselineCachedRender !== 'function') {
        return this.prove(node, kind);
      }
      if (node.renderWebGL !== baselineCachedRender ||
          node._renderCachedWebGL !== baselineCachedRender) {
        return 'cached renderWebGL';
      }
      var cacheData = node._cacheData;
      if (!cacheData || typeof cacheData.originalRenderWebGL !== 'function') {
        return 'cached original renderWebGL unavailable';
      }
      return this.prove(node, kind, cacheData.originalRenderWebGL);
    }
  };

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
      nativeCompatibilityObserved('render.rendererPluginRegistration', name);
    });
    report.renderMethodOverrides.forEach(function(name) {
      nativeCompatibilityObserved('render.renderMethodOverride', name);
    });
    return report;
  }

  globalThis.pmjsPixiRenderPreflight = { scan: scan, report: report };
})();

