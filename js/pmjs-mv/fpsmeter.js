'use strict';

(function() {
  if (typeof globalThis.FPSMeter === 'function') return;

  var fpsMeterPath = 'js/libs/fpsmeter.js';
  var fullPath = typeof gamePath === 'function' ? gamePath(fpsMeterPath) : fpsMeterPath;

  if (typeof NativeHost !== 'undefined' && NativeHost.fs && NativeHost.runtime &&
      typeof NativeHost.fs.exists === 'function' && NativeHost.fs.exists(fullPath)) {
    NativeHost.runtime.loadScript(fpsMeterPath);
    if (typeof globalThis.FPSMeter !== 'function') {
      throw new Error("Game library '" + fpsMeterPath + "' executed but did not define globalThis.FPSMeter");
    }
    return;
  }

  function FPSMeterStub(options) {
    this.options = options || {};
  }
  FPSMeterStub.prototype.tickStart = function() { return this; };
  FPSMeterStub.prototype.tick = function() { return this; };
  FPSMeterStub.prototype.show = function() { return this; };
  FPSMeterStub.prototype.hide = function() { return this; };
  FPSMeterStub.prototype.toggle = function() { return this; };
  FPSMeterStub.prototype.pause = function() { return this; };
  FPSMeterStub.prototype.resume = function() { return this; };
  FPSMeterStub.prototype.destroy = function() { return this; };

  globalThis.FPSMeter = FPSMeterStub;
  if (typeof window !== 'undefined') window.FPSMeter = FPSMeterStub;
})();
