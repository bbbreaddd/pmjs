'use strict';

function installCoreServices(runtime, engine) {
  const scope = runtime.scope;
  if (scope.PIXI?.Point) {
    function Point(x, y) { this.initialize(x, y); }
    Point.prototype = Object.create(scope.PIXI.Point.prototype);
    Point.prototype.constructor = Point;
    Point.prototype.initialize = function(x, y) { scope.PIXI.Point.call(this, x, y); };
    scope.Point = Point;
  }
  if (scope.WebAudio && scope.PMJS?.rpgmaker?.audio) {
    Object.defineProperty(scope.WebAudio,'_context',{ configurable:true,get() { return scope.PMJS.rpgmaker.audio.clock; } });
    Object.defineProperty(scope.WebAudio,'_masterVolume',{ configurable:true,get() { return engine.coreService('audioMasterVolume'); },set(value) { scope.WebAudio.setMasterVolume(value); } });
  }
  function Decrypter() { throw new Error('Decrypter is a static class'); }
  Object.assign(Decrypter, {
    SIGNATURE: '5250474d56000000', VER: '000301', REMAIN: '0000000000', _headerlength: 16,
    readEncryptionkey() { engine.coreService('readEncryptionkey', scope.$dataSystem); }
  });
  for (const method of ['extToEncryptExt', 'checkImgIgnore', 'decryptArrayBuffer', 'cutArrayHeader'])
    Decrypter[method] = (...args) => engine.coreService(method, ...args);
  for (const field of ['hasEncryptedImages', 'hasEncryptedAudio']) Object.defineProperty(Decrypter, field, {
    configurable: true, get() { return engine.coreService(field); }, set(value) { engine.coreService(field, value); }
  });
  Object.defineProperty(Decrypter, '_encryptionKey', { configurable: true, get() { return engine.coreService('encryptionKey'); } });
  scope.Decrypter = Decrypter;
}
module.exports = { installCoreServices };
