'use strict';

(function() {
  PMJS.pixi5.registerRenderContract(Sprite_Animation.prototype, {
    encode: function(animation) {
      // Stock _render draws only a live Effekseer handle; timing/flash-only
      // animations still update through their original engine methods.
      if (animation._targets.length && animation._handle && animation._handle.exists) {
        PMJS.compat.hit('render.effekseer', animation.constructor.name);
        throw new Error('native MZ Effekseer rendering is unavailable');
      }
      return { kind: 0, resource: 0 };
    }
  });
  PMJS.methods.wrap({ key: 'mz.effect.load', id: 'pmjs-mz.animations',
    getTarget: function() { return EffectManager; }, method: 'load',
    wrap: function(original) {
      return function(filename) {
        if (filename && !Graphics.effekseer) {
          PMJS.compat.hit('render.effekseer', filename);
          throw new Error('native MZ Effekseer loading is unavailable: ' + filename);
        }
        return original.apply(this, arguments);
      };
    }
  });
})();
