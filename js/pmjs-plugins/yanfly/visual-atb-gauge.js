'use strict';

PMJS.plugins.optimizeMethod({
  plugin: 'YEP_X_VisualATBGauge', id: 'plugins.yanfly.enemy-atb-refresh',
  owner: 'pmjs-plugins/yanfly', fallback: 'authored enemy ATB gauge refresh checks',
  phaseKey: 'pmjs.adapter.yanfly-visual-atb',
  getTarget: function() { return globalThis.Window_EnemyVisualATB && Window_EnemyVisualATB.prototype; },
  method: 'updateATBPosition',
  recognized: '58c487e44dfefa99c48880d7e7c1e6984e1f020c09cad4d226f4b7031a21005b',
  unavailableReason: 'enemy ATB gauge method unavailable',
  refusalReason: 'unrecognized enemy ATB gauge method composition',
  replace: function() {
    return function() {
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
});
