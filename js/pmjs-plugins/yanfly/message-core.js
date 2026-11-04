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
      // Reviewed YEP_MessageCore 1.19 measurement path.
      var expectedBody = ['804a24c50bf504ffbd22f3ace97615df230de185b62142f81724943769ced5e5', 'e3261a21d77d5bc56ec8f2f6c72ba7a7a6323aadd57cb025904111bb4aa7dda5'];
      if (!PMJS.methods.matchesSource(measure, expectedBody) ||
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
          PMJS.optimizations.reportFallback(id, 'message contents or Bitmap text methods unsupported');
          return measure.apply(this, arguments);
        }
        var ownOutline = Object.getOwnPropertyDescriptor(contents, '_drawTextOutline');
        var ownBody = Object.getOwnPropertyDescriptor(contents, '_drawTextBody');
        if ((ownOutline && (!ownOutline.writable || !ownOutline.configurable)) ||
            (ownBody && (!ownBody.writable || !ownBody.configurable)) ||
            !Object.isExtensible(contents)) {
          PMJS.optimizations.reportFallback(id, 'message contents cannot temporarily replace text drawing methods');
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
