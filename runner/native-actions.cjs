'use strict';

function installActionBindings(scope) {
  const Action = scope.Game_Action, action = Action.prototype;
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
