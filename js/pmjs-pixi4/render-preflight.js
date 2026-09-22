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
  classNames.forEach(function(name) {
    var proto = knownClasses[name] && knownClasses[name].prototype;
    if (!proto) return;
    baselineMethods[name] = {};
    renderMethods.forEach(function(method) {
      baselineMethods[name][method] =
        Object.prototype.hasOwnProperty.call(proto, method) ? proto[method] :
          undefined;
    });
  });

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

  globalThis.pmjsPixiRenderPreflight = { scan: scan, report: report };
})();

