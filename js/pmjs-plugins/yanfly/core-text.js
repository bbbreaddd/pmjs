'use strict';

(function() {
  var id = 'plugins.yanfly.core-native-text';
  PMJS.plugins.registerOptimization('YEP_CoreEngine', {
    id: id, owner: 'pmjs-plugins/yanfly', fallback: 'captured MV Canvas text drawing'
  });

  PMJS.plugins.onLoaded('YEP_CoreEngine', 'pmjs.adapter.yanfly-core-text', function() {
    PMJS.phases.on('afterGuestPlugins', 'pmjs.adapter.yanfly-core-text', function() {
      if (!PMJS.optimizations.isEnabled(id)) return;
      var core = globalThis.Yanfly && Yanfly.Core;
      var bitmap = PMJS.mv && PMJS.mv.bitmap;
      var font = typeof Bitmap !== 'undefined' && Bitmap.prototype._makeFontNameText;
      // MV 1.6.1 font builder and YEP_MessageCore 1.19 bold-font wrapper.
      var stockFontHash = ['d5b3e2ff852f5ddb1d2cf0f225ff65d89406c63215200153772b03144e5e4237'];
      var boldFontHash = ['bedb42165c2f90a3d3060c79b67dcadf46c9619308578463b936805f134b5ede', 'b72754a5d6ebdfcba8b1c9fd5843ee1a2b52dfac2ae992c19ef311ad0b4a0183'];
      var fontStillValid;
      if (!PMJS.methods.matchesSource(font, stockFontHash)) {
        var message = globalThis.Yanfly && Yanfly.Message;
        var predecessor = message && message.Bitmap_makeFontNameText;
        if (!PMJS.methods.matchesSource(font, boldFontHash) || !PMJS.methods.matchesSource(predecessor, stockFontHash)) {
          PMJS.optimizations.refuse(id, 'unrecognized Bitmap font method composition');
          return;
        }
        fontStillValid = function() {
          return Yanfly.Message === message && message.Bitmap_makeFontNameText === predecessor;
        };
      }
      var draw = core && bitmap && typeof bitmap.createNativeDrawText === 'function' &&
        bitmap.createNativeDrawText(core.Bitmap_drawText, font, fontStillValid, id);
      if (typeof draw !== 'function') {
        PMJS.optimizations.refuse(id, 'unrecognized captured Bitmap text drawing contract');
        return;
      }
      // Keep plugin wrappers and their side effects above the captured MV leaf.
      core.Bitmap_drawText = draw;
    });
  });
})();
