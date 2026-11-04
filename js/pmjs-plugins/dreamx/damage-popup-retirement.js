'use strict';

(function() {
  var id = 'plugins.dreamx.damage-popup-retirement';
  PMJS.plugins.registerOptimization('DreamX_Ext_VE_DamagePopup', {
    id: id, owner: 'pmjs-plugins/dreamx',
    fallback: 'authored battler-parent popup removal'
  });
  var victorLoaded = false;
  PMJS.plugins.onLoaded('VE_DamagePopup', 'pmjs.adapter.dreamx-popup-dependency', function() {
    victorLoaded = true;
  });

  PMJS.plugins.onLoaded('DreamX_Ext_VE_DamagePopup', 'pmjs.adapter.dreamx-popup-retirement', function() {
    PMJS.phases.on('afterGuestPlugins', 'pmjs.adapter.dreamx-popup-retirement', function() {
      if (!PMJS.optimizations.isEnabled(id)) return;
      var prototype = globalThis.Sprite_Battler && Sprite_Battler.prototype;
      if (!prototype || !victorLoaded ||
          !PMJS.methods.matchesSource(prototype.updateDamagePopup, '190a974ff58f3028f03bdef044abe9d14ebdc9ed3c511e4d15b92cb44c308ac2') ||
          !PMJS.methods.matchesSource(prototype.damagePopupSprite, '7ece5d64382a9a48a1f25323024af59f9e36f3286a6fca73cfb5e3d4a2d0238d')) {
        PMJS.optimizations.refuse(id, 'unrecognized popup update or reparenting composition');
        return;
      }

      prototype.updateDamagePopup = function retireDamagePopups() {
        this.setupDamagePopup();
        if (!this._damages.length) return;
        for (var i = 0; i < this._damages.length; i++) this._damages[i].update();
        var first = this._damages[0];
        if (!first.isPlaying()) {
          // DreamX moves popups above windows. Explicit retirement must use the
          // popup's current parent; detachment does not destroy its resources.
          if (first.parent) first.parent.removeChild(first);
          this._damages.shift();
        }
      };
    });
  });
})();
