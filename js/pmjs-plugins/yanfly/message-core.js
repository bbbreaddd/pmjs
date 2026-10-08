'use strict';

PMJS.plugins.registerOptimization('YEP_MessageCore', {
  id: 'plugins.yanfly.message-word-wrap-measure',
  owner: 'pmjs-plugins/yanfly',
  fallback: 'ordinary YEP word-wrap measurement drawing'
});

(function() {
  var id = 'plugins.yanfly.message-word-wrap-measure';
  var windowProto = typeof Window_Base !== 'undefined' && Window_Base.prototype;
  var bitmapProto = typeof Bitmap !== 'undefined' && Bitmap.prototype;
  var outline = bitmapProto && bitmapProto._drawTextOutline;
  var body = bitmapProto && bitmapProto._drawTextBody;

  PMJS.plugins.onLoaded('YEP_MessageCore', 'pmjs.yanfly.message-core', function() {
    PMJS.phases.on('afterGuestPlugins', 'pmjs.yanfly.message-core', function() {
      if (!PMJS.optimizations.isEnabled(id)) return;
      var measure = windowProto && windowProto.textWidthExCheck;
      var measureSource = typeof measure === 'function'
        ? Function.prototype.toString.call(measure).replace(/\s+/g, '') : '';
      var expectedBody = '5589e1927afd0452c8f047fcb0348523a9b28a2c3b2709fb48ba1b6e6bc271fb';
      var measureBody = measureSource.slice(measureSource.indexOf('{') + 1,
        measureSource.lastIndexOf('}'));
      var digest = globalThis.__pmjsBuiltinRequire &&
        globalThis.__pmjsBuiltinRequire('crypto').createHash('sha256')
          .update(measureBody).digest('hex');
      if (digest !== expectedBody ||
          typeof outline !== 'function' || typeof body !== 'function' ||
          bitmapProto._drawTextOutline !== outline ||
          bitmapProto._drawTextBody !== body) {
        PMJS.optimizations.refuse(id, 'unrecognized YEP measurement or Bitmap drawing methods');
        return;
      }

      // Keep the final drawText wrappers and their font side effects; suppress
      // only the raster leaves for the complete YEP measurement operation.
      windowProto.textWidthExCheck = function() {
        var contents = this.contents;
        if (!contents ||
            contents._drawTextOutline !== outline || contents._drawTextBody !== body) {
          return measure.apply(this, arguments);
        }
        var ownOutline = Object.getOwnPropertyDescriptor(contents, '_drawTextOutline');
        var ownBody = Object.getOwnPropertyDescriptor(contents, '_drawTextBody');
        if ((ownOutline && (!ownOutline.writable || !ownOutline.configurable)) ||
            (ownBody && (!ownBody.writable || !ownBody.configurable)) ||
            !Object.isExtensible(contents)) {
          return measure.apply(this, arguments);
        }
        contents._drawTextOutline = contents._drawTextBody = function() {};
        try {
          return measure.apply(this, arguments);
        } finally {
          if (ownOutline) Object.defineProperty(contents, '_drawTextOutline', ownOutline);
          else delete contents._drawTextOutline;
          if (ownBody) Object.defineProperty(contents, '_drawTextBody', ownBody);
          else delete contents._drawTextBody;
        }
      };
    });
  });
})();
