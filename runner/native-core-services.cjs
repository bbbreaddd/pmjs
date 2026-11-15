'use strict';
const { installCoreUtilities, installToneFilter } = require('./native-core-utilities.cjs');
const { installAudioElement } = require('./native-audio-element.cjs');
const { installFilterCompiler } = require('./native-filter-compiler.cjs');

function installCoreServices(runtime, engine) {
  const scope = runtime.scope;
  installToneFilter(runtime);
  installFilterCompiler(runtime);
  if (scope.Sprite && scope.PIXI?.filters?.VoidFilter && !scope.Sprite.voidFilter)
    scope.Sprite.voidFilter = new scope.PIXI.filters.VoidFilter();
  if (scope.WindowLayer && scope.PIXI?.filters?.VoidFilter && !scope.WindowLayer.voidFilter)
    scope.WindowLayer.voidFilter = new scope.PIXI.filters.VoidFilter();
  if(scope.Image && scope.nativeImageFromResource) scope.Bitmap?.bindImages({ create: () => new scope.Image(), fromResource: scope.nativeImageFromResource });
  scope.Bitmap?.bindPixi(scope.PIXI, scope.PMJS?.fonts);
  if (!scope.ResourceHandler) installCoreUtilities(runtime);
  if (scope.WebAudio && scope.EventTarget) installAudioElement(scope);
  if (scope.PIXI?.Point) {
    function Point(x, y) { this.initialize(x, y); }
    Point.prototype = Object.create(scope.PIXI.Point.prototype);
    Point.prototype.constructor = Point;
    Point.prototype.initialize = function(x, y) { scope.PIXI.Point.call(this, x, y); };
    scope.Point = Point;
  }
  if (scope.PIXI?.Rectangle) {
    function Rectangle() { this.initialize.apply(this, arguments); }
    Rectangle.prototype = Object.create(scope.PIXI.Rectangle.prototype);
    Rectangle.prototype.constructor = Rectangle;
    Rectangle.prototype.initialize = function(...args) { scope.PIXI.Rectangle.apply(this, args); };
    Rectangle.emptyRectangle = new Rectangle(0, 0, 0, 0);
    scope.Rectangle = Rectangle;
  }
  if (scope.WebAudio) Object.defineProperty(scope.WebAudio, 'masterVolume', { configurable: true,
    get() { return engine.coreService('audioMasterVolume'); }, set(value) { scope.WebAudio.setMasterVolume(value); }
  });
  if (scope.WebAudio && scope.PMJS?.rpgmaker?.audio) {
    Object.defineProperty(scope.WebAudio,'_context',{ configurable:true,get() { return scope.PMJS.rpgmaker.audio.clock; } });
    Object.defineProperty(scope.WebAudio,'_masterVolume',{ configurable:true,get() { return engine.coreService('audioMasterVolume'); },set(value) { scope.WebAudio.setMasterVolume(value); } });
  }
  const Decrypter = scope.Decrypter;
  for (const field of ['hasEncryptedImages', 'hasEncryptedAudio']) Object.defineProperty(Decrypter, field, {
    configurable: true, get() { return engine.coreService(field); }, set(value) { engine.coreService(field, value); }
  });
  if (scope.Utils) {
    scope.Utils._supportPassiveEvent = null;
    scope.Utils.isSupportPassiveEvent = function() {
      if (typeof this._supportPassiveEvent === 'boolean') return this._supportPassiveEvent;
      let supported = false;
      scope.window.addEventListener('test', null, Object.defineProperty({}, 'passive', { get() { supported = true; } }));
      return (this._supportPassiveEvent = supported);
    };
  }
}
module.exports = { installCoreServices };
