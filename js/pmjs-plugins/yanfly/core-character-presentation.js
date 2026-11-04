'use strict';

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
