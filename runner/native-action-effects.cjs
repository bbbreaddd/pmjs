'use strict';
// RPG Maker MV behavior: Copyright (c) 2015 KADOKAWA CORPORATION./YOJI OJIMA.
// MIT license: third_party/rpg-maker-mv.LICENSE.

function installActionEffects(Action) {
  const action = Action.prototype;
  action.apply = function(target) {
      var result = target.result();
      this.subject().clearResult();
      result.clear();
      result.used = this.testApply(target);
      result.missed = (result.used && Math.random() >= this.itemHit(target));
      result.evaded = (!result.missed && Math.random() < this.itemEva(target));
      result.physical = this.isPhysical();
      result.drain = this.isDrain();
      if (result.isHit()) {
          if (this.item().damage.type > 0) {
              result.critical = (Math.random() < this.itemCri(target));
              var value = this.makeDamageValue(target, result.critical);
              this.executeDamage(target, value);
          }
          this.item().effects.forEach(function(effect) {
              this.applyItemEffect(target, effect);
          }, this);
          this.applyItemUserEffect(target);
      }
  };

  action.makeDamageValue = function(target, critical) {
      var item = this.item();
      var baseValue = this.evalDamageFormula(target);
      var value = baseValue * this.calcElementRate(target);
      if (this.isPhysical()) {
          value *= target.pdr;
      }
      if (this.isMagical()) {
          value *= target.mdr;
      }
      if (baseValue < 0) {
          value *= target.rec;
      }
      if (critical) {
          value = this.applyCritical(value);
      }
      value = this.applyVariance(value, item.damage.variance);
      value = this.applyGuard(value, target);
      value = Math.round(value);
      return value;
  };

  action.applyCritical = function(damage) {
      return damage * 3;
  };

  action.applyVariance = function(damage, variance) {
      var amp = Math.floor(Math.max(Math.abs(damage) * variance / 100, 0));
      var v = Math.floor(Math.random() * (amp + 1)) + Math.floor(Math.random() * (amp + 1)) - amp;
      return damage >= 0 ? damage + v : damage - v;
  };

  action.applyGuard = function(damage, target) {
      return damage / (damage > 0 && target.isGuard() ? 2 * target.grd : 1);
  };

  action.applyItemEffect = function(target, effect) {
      switch (effect.code) {
      case Action.EFFECT_RECOVER_HP:
          this.itemEffectRecoverHp(target, effect);
          break;
      case Action.EFFECT_RECOVER_MP:
          this.itemEffectRecoverMp(target, effect);
          break;
      case Action.EFFECT_GAIN_TP:
          this.itemEffectGainTp(target, effect);
          break;
      case Action.EFFECT_ADD_STATE:
          this.itemEffectAddState(target, effect);
          break;
      case Action.EFFECT_REMOVE_STATE:
          this.itemEffectRemoveState(target, effect);
          break;
      case Action.EFFECT_ADD_BUFF:
          this.itemEffectAddBuff(target, effect);
          break;
      case Action.EFFECT_ADD_DEBUFF:
          this.itemEffectAddDebuff(target, effect);
          break;
      case Action.EFFECT_REMOVE_BUFF:
          this.itemEffectRemoveBuff(target, effect);
          break;
      case Action.EFFECT_REMOVE_DEBUFF:
          this.itemEffectRemoveDebuff(target, effect);
          break;
      case Action.EFFECT_SPECIAL:
          this.itemEffectSpecial(target, effect);
          break;
      case Action.EFFECT_GROW:
          this.itemEffectGrow(target, effect);
          break;
      case Action.EFFECT_LEARN_SKILL:
          this.itemEffectLearnSkill(target, effect);
          break;
      case Action.EFFECT_COMMON_EVENT:
          this.itemEffectCommonEvent(target, effect);
          break;
      }
  };

  action.itemEffectRecoverHp = function(target, effect) {
      var value = (target.mhp * effect.value1 + effect.value2) * target.rec;
      if (this.isItem()) {
          value *= this.subject().pha;
      }
      value = Math.floor(value);
      if (value !== 0) {
          target.gainHp(value);
          this.makeSuccess(target);
      }
  };

  action.itemEffectRecoverMp = function(target, effect) {
      var value = (target.mmp * effect.value1 + effect.value2) * target.rec;
      if (this.isItem()) {
          value *= this.subject().pha;
      }
      value = Math.floor(value);
      if (value !== 0) {
          target.gainMp(value);
          this.makeSuccess(target);
      }
  };

  action.itemEffectGainTp = function(target, effect) {
      var value = Math.floor(effect.value1);
      if (value !== 0) {
          target.gainTp(value);
          this.makeSuccess(target);
      }
  };

  action.itemEffectAddState = function(target, effect) {
      if (effect.dataId === 0) {
          this.itemEffectAddAttackState(target, effect);
      } else {
          this.itemEffectAddNormalState(target, effect);
      }
  };

  action.itemEffectAddAttackState = function(target, effect) {
      this.subject().attackStates().forEach(function(stateId) {
          var chance = effect.value1;
          chance *= target.stateRate(stateId);
          chance *= this.subject().attackStatesRate(stateId);
          chance *= this.lukEffectRate(target);
          if (Math.random() < chance) {
              target.addState(stateId);
              this.makeSuccess(target);
          }
      }.bind(this), target);
  };

  action.itemEffectAddNormalState = function(target, effect) {
      var chance = effect.value1;
      if (!this.isCertainHit()) {
          chance *= target.stateRate(effect.dataId);
          chance *= this.lukEffectRate(target);
      }
      if (Math.random() < chance) {
          target.addState(effect.dataId);
          this.makeSuccess(target);
      }
  };

  action.itemEffectRemoveState = function(target, effect) {
      var chance = effect.value1;
      if (Math.random() < chance) {
          target.removeState(effect.dataId);
          this.makeSuccess(target);
      }
  };

  action.itemEffectAddBuff = function(target, effect) {
      target.addBuff(effect.dataId, effect.value1);
      this.makeSuccess(target);
  };

  action.itemEffectAddDebuff = function(target, effect) {
      var chance = target.debuffRate(effect.dataId) * this.lukEffectRate(target);
      if (Math.random() < chance) {
          target.addDebuff(effect.dataId, effect.value1);
          this.makeSuccess(target);
      }
  };

  action.itemEffectRemoveBuff = function(target, effect) {
      if (target.isBuffAffected(effect.dataId)) {
          target.removeBuff(effect.dataId);
          this.makeSuccess(target);
      }
  };

  action.itemEffectRemoveDebuff = function(target, effect) {
      if (target.isDebuffAffected(effect.dataId)) {
          target.removeBuff(effect.dataId);
          this.makeSuccess(target);
      }
  };

  action.itemEffectSpecial = function(target, effect) {
      if (effect.dataId === Action.SPECIAL_EFFECT_ESCAPE) {
          target.escape();
          this.makeSuccess(target);
      }
  };

  action.itemEffectGrow = function(target, effect) {
      target.addParam(effect.dataId, Math.floor(effect.value1));
      this.makeSuccess(target);
  };

  action.itemEffectLearnSkill = function(target, effect) {
      if (target.isActor()) {
          target.learnSkill(effect.dataId);
          this.makeSuccess(target);
      }
  };

  action.itemEffectCommonEvent = function(target, effect) {
  };
}

module.exports = { installActionEffects };
