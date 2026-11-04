'use strict';

(function() {
  var id = 'plugins.yanfly.enemy-atb-refresh';
  PMJS.plugins.registerOptimization('YEP_X_VisualATBGauge', {
    id: id, owner: 'pmjs-plugins/yanfly',
    fallback: 'authored enemy ATB gauge refresh checks'
  });

  function install() {
    if (!PMJS.optimizations.isEnabled(id)) return;
    var prototype = globalThis.Window_EnemyVisualATB && Window_EnemyVisualATB.prototype;
    var original = prototype && prototype.updateATBPosition;
    if (typeof original !== 'function') {
      PMJS.optimizations.refuse(id, 'enemy ATB gauge method unavailable');
      return;
    }
    if (!PMJS.methods.matchesSource(original, '58c487e44dfefa99c48880d7e7c1e6984e1f020c09cad4d226f4b7031a21005b')) {
      PMJS.optimizations.refuse(id, 'unrecognized enemy ATB gauge method composition');
      return;
    }

    prototype.updateATBPosition = function() {
      if (!this._battler) return;
      var speed = this._battler.atbSpeed();
      var charge = this._battler.atbCharge();
      // Charge and speed need independent caches, including charge-only changes.
      if (this._currentATBSpeed !== speed || this._currentATBCharge !== charge) {
        this._currentATBSpeed = speed;
        this._currentATBCharge = charge;
        this._requestRefresh = true;
      }
    };
  }

  PMJS.plugins.onLoaded('YEP_X_VisualATBGauge', 'pmjs.adapter.yanfly-visual-atb', function() {
    PMJS.phases.on('afterGuestPlugins', 'pmjs.adapter.yanfly-visual-atb', install);
  });
})();
