'use strict';

PMJS.phases.on('beforePlugins', 'pmjs.adapter.olivia-animated-pictures', function() {
  PMJS.plugins.interceptLoad('Olivia_AnimatedPictures', 'plugins/olivia/animated-pictures', function(next, context) {
    var source = NativeHost.fs.readText(context.path);
    var marker = '/* pmjs: bind callback to requested bitmap */';
    if (!source) return next();
    if (PMJS.methods.matchesText(source, '2057fd676895274f066736bb04eed93333ed3177b69ccfdb118f4e537468abf1')) {
      var demoBefore = `if(this[_0x530c('0x27')]){this[_0x530c('0x26')][_0x530c('0x17')](this[_0x530c('0x2b')][_0x530c('0x18')](this));}else{this['bitmap'][_0x530c('0x17')](this[_0x530c('0x35')][_0x530c('0x18')](this));}`;
      if (!source.includes(demoBefore)) return next();
      var demoAfter = `var requestedBitmap = this.bitmap; ${marker} requestedBitmap[_0x530c('0x17')](function(){ if (this.bitmap !== requestedBitmap) return; if(this[_0x530c('0x27')]) this[_0x530c('0x2b')](); else this[_0x530c('0x35')](); }.bind(this));`;
      return NativeHost.runtime.runScript(source.replace(demoBefore, demoAfter));
    }
    if (!PMJS.methods.matchesText(source, [
      '0a3937d2aaf270f45fd86093f42b59cbdca1579f19ebed898729adec0e769f77',
      'a1e3bb3d6861ed8901ddf19fa91bbd8dfc9923d1f813b4a92f0ceec431354905'
    ])) return next();
    var newline = source.includes('\r\n') ? '\r\n' : '\n';
    var before = [
      '  if (this._isAnimatedPicture) {',
      '    this.bitmap.addLoadListener(this.updateAnimatedPictureFrame.bind(this));',
      '  } else {',
      '    this.bitmap.addLoadListener(this.resetFrame.bind(this));',
      '  }',
    ].join(newline);
    if (!source.includes(before)) return next();
    var after = [
      `  var requestedBitmap = this.bitmap; ${marker}`,
      '  requestedBitmap.addLoadListener(function () {',
      '    if (this.bitmap !== requestedBitmap) return;',
      '    if (this._isAnimatedPicture) this.updateAnimatedPictureFrame();',
      '    else this.resetFrame();',
      '  }.bind(this));',
    ].join(newline);
    return NativeHost.runtime.runScript(source.replace(before, after));
  });
});
