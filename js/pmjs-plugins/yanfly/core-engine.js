'use strict';

PMJS.phases.on('afterGuestPlugins', 'pmjs.plugins.yanfly.core-transforms', function() {
  if (!globalThis.Yanfly || !Yanfly.Core || typeof Sprite !== 'function') return;
  var predecessor = Yanfly.Core.Sprite_updateTransform;
  var method = Sprite.prototype.updateTransform;
  // Reviewed YEP_CoreEngine 1.31 wrapper.
  var reviewed = ['866ba21d861bf698e1a5ef3d034a58f8453b55fe618be6596beb29cd6b473429'];
  if (!PMJS.methods.matchesSource(method, reviewed)) return;
  pmjsPixiRenderPreflight.registerTransformEquivalent(method, predecessor, function(node) {
    node.worldTransform.tx = Math.floor(node.worldTransform.tx);
    node.worldTransform.ty = Math.floor(node.worldTransform.ty);
  }, function() { return Yanfly.Core.Sprite_updateTransform === predecessor; }, true);
});
PMJS.phases.on('afterGuestPlugins', 'pmjs.plugins.yanfly.core-character-presentation', function() {
  var presentation = PMJS.mv && PMJS.mv.characterPresentation;
  if (!presentation || !globalThis.Yanfly || !Yanfly.Core ||
      typeof Sprite_Character !== 'function') return;
  var method = Sprite_Character.prototype.updateHalfBodySprites;
  var predecessor = Yanfly.Core.Sprite_Character_updateHalfBodySprites;
  if (typeof method !== 'function') return;
  // Reviewed YEP_CoreEngine 1.31 wrapper.
  var reviewedHalfBody = ['dc65b8c8604adc6a5d1af43015c944195f69dfb3e24e39cb19ee2a766a15a9a4'];
  if (!PMJS.methods.matchesSource(method, reviewedHalfBody)) return;
  // Yanfly changes the bush sprites, not the main character frame.
  presentation.registerHalfBodyEquivalent(method, predecessor, function() {
    return Yanfly.Core.Sprite_Character_updateHalfBodySprites === predecessor;
  });
});
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
(function() {
  var id = 'plugins.yanfly.core-number-format';
  var localeString = Number.prototype.toLocaleString;
  var NumberFormat = Intl.NumberFormat;
  var formatGetter = Object.getOwnPropertyDescriptor(NumberFormat.prototype, 'format').get;
  PMJS.plugins.registerOptimization('YEP_CoreEngine', {
    id: id, owner: 'pmjs-plugins/yanfly', fallback: 'ordinary numeric locale formatting'
  });
  PMJS.plugins.onLoaded('YEP_CoreEngine', id, function() {
    PMJS.phases.on('afterGuestPlugins', id, function() {
      if (!PMJS.optimizations.isEnabled(id)) return;
      var original = globalThis.Yanfly && Yanfly.Util && Yanfly.Util.toGroup;
      var expected = ['dd7535c98792b225ccac00208f5db22411fde8d1ea79fbf5025b37c51756f850'];
      if (!PMJS.methods.matchesSource(original, expected)) {
        PMJS.optimizations.refuse(id, 'unrecognized numeric grouping method'); return;
      }
      var format, calls = 0;
      PMJS.plugins.numberFormat = { diagnostics: function() { return { formatted: calls }; } };
      Yanfly.Util.toGroup = function(value) {
        if (typeof value === 'string' || !Yanfly.Param.DigitGroup) return value;
        if (typeof value !== 'number' || Number.prototype.toLocaleString !== localeString ||
            Intl.NumberFormat !== NumberFormat) return original.apply(this, arguments);
        if (!format) format = formatGetter.call(new NumberFormat('en'));
        calls++;
        return format(value);
      };
    });
  });
})();
