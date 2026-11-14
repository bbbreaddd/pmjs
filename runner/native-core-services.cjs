'use strict';

function installCoreServices(runtime, engine) {
  const scope = runtime.scope;
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
