'use strict';
// RPG Maker MV behavior: Copyright (c) 2015 KADOKAWA CORPORATION./YOJI OJIMA.
// MIT license: third_party/rpg-maker-mv.LICENSE.

const { installActionEffects } = require('./native-action-effects.cjs');

function installActionBindings(scope, evaluateFormula) {
  const Action = scope.Game_Action, action = Action.prototype;
  installActionEffects(Action);
  action.isValid = function() { return (this._forcing && this.item()) || this.subject().canUse(this.item()); };
  action.evalDamageFormula = function(target) { return evaluateFormula.call(this, this.item(), this.subject(), target, scope.$gameVariables._data); };
  action.numRepeats = function() {
      let repeats = this.item().repeats;
      if (this.isAttack()) {
          repeats += this.subject().attackTimesAdd();
      }
      return Math.floor(repeats);
  };
  action.makeTargets = function() {
      let targets = [];
      if (!this._forcing && this.subject().isConfused()) {
          targets = [this.confusionTarget()];
      } else if (this.isForOpponent()) {
          targets = this.targetsForOpponents();
      } else if (this.isForFriend()) {
          targets = this.targetsForFriends();
      }
      return this.repeatTargets(targets);
  };
  action.repeatTargets = function(targets) {
      const repeatedTargets = [];
      let repeats = this.numRepeats();
      for (let i = 0; i < targets.length; i++) {
          let target = targets[i];
          if (target) {
              for (let j = 0; j < repeats; j++) {
                  repeatedTargets.push(target);
              }
          }
      }
      return repeatedTargets;
  };
  action.confusionTarget = function() {
      switch (this.subject().confusionLevel()) {
      case 1:
          return this.opponentsUnit().randomTarget();
      case 2:
          if (Math.floor(Math.random() * 2) === 0) {
              return this.opponentsUnit().randomTarget();
          }
          return this.friendsUnit().randomTarget();
      default:
          return this.friendsUnit().randomTarget();
      }
  };
  action.targetsForOpponents = function() {
      let targets = [];
      const unit = this.opponentsUnit();
      if (this.isForRandom()) {
          for (let i = 0; i < this.numTargets(); i++) {
              targets.push(unit.randomTarget());
          }
      } else if (this.isForOne()) {
          if (this._targetIndex < 0) {
              targets.push(unit.randomTarget());
          } else {
              targets.push(unit.smoothTarget(this._targetIndex));
          }
      } else {
          targets = unit.aliveMembers();
      }
      return targets;
  };
  action.targetsForFriends = function() {
      let targets = [];
      const unit = this.friendsUnit();
      if (this.isForUser()) {
          return [this.subject()];
      } else if (this.isForDeadFriend()) {
          if (this.isForOne()) {
              targets.push(unit.smoothDeadTarget(this._targetIndex));
          } else {
              targets = unit.deadMembers();
          }
      } else if (this.isForOne()) {
          if (this._targetIndex < 0) {
              targets.push(unit.randomTarget());
          } else {
              targets.push(unit.smoothTarget(this._targetIndex));
          }
      } else {
          targets = unit.aliveMembers();
      }
      return targets;
  };
  action.testApply = function(target) {
      return (this.isForDeadFriend() === target.isDead() &&
              (scope.$gameParty.inBattle() || this.isForOpponent() ||
              (this.isHpRecover() && target.hp < target.mhp) ||
              (this.isMpRecover() && target.mp < target.mmp) ||
              (this.hasItemAnyValidEffects(target))));
  };
  action.hasItemAnyValidEffects = function(target) {
      return this.item().effects.some(function(effect) {
          return this.testItemEffect(target, effect);
      }, this);
  };
  action.testItemEffect = function(target, effect) {
      switch (effect.code) {
      case Action.EFFECT_RECOVER_HP:
          return target.hp < target.mhp || effect.value1 < 0 || effect.value2 < 0;
      case Action.EFFECT_RECOVER_MP:
          return target.mp < target.mmp || effect.value1 < 0 || effect.value2 < 0;
      case Action.EFFECT_ADD_STATE:
          return !target.isStateAffected(effect.dataId);
      case Action.EFFECT_REMOVE_STATE:
          return target.isStateAffected(effect.dataId);
      case Action.EFFECT_ADD_BUFF:
          return !target.isMaxBuffAffected(effect.dataId);
      case Action.EFFECT_ADD_DEBUFF:
          return !target.isMaxDebuffAffected(effect.dataId);
      case Action.EFFECT_REMOVE_BUFF:
          return target.isBuffAffected(effect.dataId);
      case Action.EFFECT_REMOVE_DEBUFF:
          return target.isDebuffAffected(effect.dataId);
      case Action.EFFECT_LEARN_SKILL:
          return target.isActor() && !target.isLearnedSkill(effect.dataId);
      default:
          return true;
      }
  };
  action.executeDamage = function(target, value) {
      const result = target.result();
      if (value === 0) {
          result.critical = false;
      }
      if (this.isHpEffect()) {
          this.executeHpDamage(target, value);
      }
      if (this.isMpEffect()) {
          this.executeMpDamage(target, value);
      }
  };
  action.executeHpDamage = function(target, value) {
      if (this.isDrain()) {
          value = Math.min(target.hp, value);
      }
      this.makeSuccess(target);
      target.gainHp(-value);
      if (value > 0) {
          target.onDamage(value);
      }
      this.gainDrainedHp(value);
  };
  action.executeMpDamage = function(target, value) {
      if (!this.isMpRecover()) {
          value = Math.min(target.mp, value);
      }
      if (value !== 0) {
          this.makeSuccess(target);
      }
      target.gainMp(-value);
      this.gainDrainedMp(value);
  };
  action.gainDrainedHp = function(value) {
      if (this.isDrain()) {
         let gainTarget = this.subject();
         if (this._reflectionTarget !== undefined) {
              gainTarget = this._reflectionTarget;
          }
         gainTarget.gainHp(value);
      }
  };
  action.gainDrainedMp = function(value) {
      if (this.isDrain()) {
         let gainTarget = this.subject();
         if (this._reflectionTarget !== undefined) {
             gainTarget = this._reflectionTarget;
         }
         gainTarget.gainMp(value);
      }
  };
  const items = new WeakMap();
  Object.defineProperty(action, '_item', { configurable: true,
    get() {
      if (!items.has(this)) {
        const owner = this, item = Object.create(scope.Game_Item.prototype);
        Object.defineProperties(item, {
          _itemId: { configurable: true, enumerable: true, get() { return owner._itemId; }, set(value) { owner._itemId = value; } },
          _dataClass: { configurable: true, enumerable: true, get() { return owner._itemId ? owner._isItem ? 'item' : 'skill' : ''; }, set(value) { owner._isItem = value === 'item'; if (!value) owner._itemId = 0; } }
        });
        items.set(this, item);
      }
      return items.get(this);
    },
    set(value) { this._isItem = value._dataClass === 'item'; this._itemId = value._itemId; }
  });
  Object.assign(Action, { EFFECT_RECOVER_HP: 11, EFFECT_RECOVER_MP: 12, EFFECT_GAIN_TP: 13, EFFECT_ADD_STATE: 21,
    EFFECT_REMOVE_STATE: 22, EFFECT_ADD_BUFF: 31, EFFECT_ADD_DEBUFF: 32, EFFECT_REMOVE_BUFF: 33, EFFECT_REMOVE_DEBUFF: 34,
    EFFECT_SPECIAL: 41, EFFECT_GROW: 42, EFFECT_LEARN_SKILL: 43, EFFECT_COMMON_EVENT: 44, SPECIAL_EFFECT_ESCAPE: 0,
    HITTYPE_CERTAIN: 0, HITTYPE_PHYSICAL: 1, HITTYPE_MAGICAL: 2 });
  action.isAttack = function() { return this.item() === scope.$dataSkills[this.subject().attackSkillId()]; };
  action.isGuard = function() { return this.item() === scope.$dataSkills[this.subject().guardSkillId()]; };
  action.setAttack = function() { this.setSkill(this.subject().attackSkillId()); };
  action.setGuard = function() { this.setSkill(this.subject().guardSkillId()); };
  action.setItemObject = function(item) { if (scope.DataManager.isSkill(item)) this.setSkill(item.id); else this.setItem(item.id); };
  action.setEnemyAction = function(value) { if (value) this.setSkill(value.skillId); else this.clear(); };
  action.checkItemScope = function(scopes) { return !!this.item() && scopes.includes(this.item().scope); };
  action.checkDamageType = function(types) { return !!this.item() && types.includes(this.item().damage.type); };
  for (const [method, scopes] of Object.entries({ isForOpponent: [1, 2, 3, 4, 5, 6], isForFriend: [7, 8, 9, 10, 11],
    isForDeadFriend: [9, 10], isForUser: [11], isForOne: [1, 3, 7, 9, 11], isForRandom: [3, 4, 5, 6], isForAll: [2, 8, 10], needsSelection: [1, 7, 9] }))
    action[method] = function() { return this.checkItemScope(scopes); };
  for (const [method, types] of Object.entries({ isHpEffect: [1, 3, 5], isMpEffect: [2, 4, 6], isDamage: [1, 2], isRecover: [3, 4], isDrain: [5, 6], isHpRecover: [3], isMpRecover: [4] }))
    action[method] = function() { return this.checkDamageType(types); };
  action.numTargets = function() { return this.isForRandom() ? this.item().scope - 2 : 0; };
  action.isCertainHit = function() { return this.item().hitType === Action.HITTYPE_CERTAIN; };
  action.isPhysical = function() { return this.item().hitType === Action.HITTYPE_PHYSICAL; };
  action.isMagical = function() { return this.item().hitType === Action.HITTYPE_MAGICAL; };
  action.itemCri = function(target) { return this.item().damage.critical ? this.subject().cri * (1 - target.cev) : 0; };
  action.lukEffectRate = function(target) { return Math.max(1 + (this.subject().luk - target.luk) * 0.001, 0); };
  action.elementsMaxRate = function(target, elements) { return elements.length ? Math.max(...elements.map(id => target.elementRate(id))) : 1; };
  action.calcElementRate = function(target) { const id = this.item().damage.elementId; return id < 0 ? this.elementsMaxRate(target, this.subject().attackElements()) : target.elementRate(id); };
  action.makeSuccess = function(target) { target.result().success = true; };
  action.applyGlobal = function() { for (const effect of this.item().effects) if (effect.code === Action.EFFECT_COMMON_EVENT) scope.$gameTemp.reserveCommonEvent(effect.dataId); };
  action.applyItemUserEffect = function() { this.subject().gainSilentTp(Math.floor(this.item().tpGain * this.subject().tcr)); };
  scope.Game_Battler.prototype.gainSilentTp = function(value) { this.setTp(this.tp + value); };
  const actor = scope.Game_Actor.prototype, base = scope.Game_Battler.prototype;
  actor.hasNoWeapons = function() { return this.weapons().length === 0; };
  actor.bareHandsElementId = function() { return 1; };
  actor.attackElements = function() { const elements = base.attackElements.call(this); if (this.hasNoWeapons() && !elements.includes(this.bareHandsElementId())) elements.push(this.bareHandsElementId()); return elements; };
}

module.exports = { installActionBindings };
