'use strict';

function installBattlerBindings(scope, engine, session, handles, createArray) {
  const base = scope.Game_BattlerBase.prototype, battler = scope.Game_Battler.prototype;
  const invoke = (object, method, ...args) => engine.actorInvoke(session, handles.get(object), method, args);
  const read = (object, field) => createArray(engine.battlerArray(handles.get(object), field));
  const write = (object, field, value) => engine.battlerArray(handles.get(object), field, value);
  const mutations = new Set(['copyWithin', 'fill', 'pop', 'push', 'reverse', 'shift', 'sort', 'splice', 'unshift']);
  function defineArrays(prototype, entries, owner = object => object) {
    for (const [property, field] of entries) {
      const views = new WeakMap();
      Object.defineProperty(prototype, property, {
        configurable: true, enumerable: true,
        get() {
          if (!views.has(this)) {
            const object = owner(this), target = createArray([]);
            const nativeKey = key => key === 'length' || (typeof key === 'string' && /^(0|[1-9][0-9]*)$/.test(key));
            const sync = () => { const values = read(object, field); Array.prototype.splice.call(target, 0, target.length, ...values); return target; };
            let view;
            view = new Proxy(target, {
              get(target, key, receiver) {
                if (!nativeKey(key) && Object.hasOwn(target, key)) return Reflect.get(target, key, receiver);
                if (mutations.has(key)) return (...args) => {
                  const values = read(object, field), result = values[key](...args);
                  write(object, field, values);
                  return result === values ? view : result;
                };
                sync(); return Reflect.get(target, key, receiver);
              },
              set(target, key, value) {
                if (!nativeKey(key)) return Reflect.set(target, key, value);
                const values = read(object, field); Reflect.set(values, key, value); write(object, field, values); return true;
              },
              deleteProperty(target, key) {
                if (!nativeKey(key)) return Reflect.deleteProperty(target, key);
                const values = read(object, field); Reflect.deleteProperty(values, key); write(object, field, values); return true;
              },
              ownKeys() { sync(); return Reflect.ownKeys(target); },
              has(target, key) { sync(); return Reflect.has(target, key); },
              getOwnPropertyDescriptor(target, key) { sync(); return Reflect.getOwnPropertyDescriptor(target, key); },
              defineProperty() { throw new TypeError('Battler arrays do not support custom property descriptors'); },
              preventExtensions() { throw new TypeError('Battler arrays must remain extensible'); }
            });
            views.set(this, view);
          }
          return views.get(this);
        },
        set(value) { write(owner(this), field, value); }
      });
    }
  }
  defineArrays(base, ['states', 'buffs', 'buffTurns', 'paramPlus'].map(field => ['_' + field, field]));
  const results = new WeakMap();
  battler.result = function() {
    if (!results.has(this)) {
      const object = this, result = Object.create(scope.Game_ActionResult.prototype);
      for (const name of ['used', 'missed', 'evaded', 'physical', 'drain', 'critical', 'success', 'hpAffected', 'hpDamage', 'mpDamage', 'tpDamage'])
        Object.defineProperty(result, name, { configurable: true, enumerable: true,
          get() { return engine.entityField(handles.get(object), 'result.' + name); },
          set(value) { engine.entityField(handles.get(object), 'result.' + name, value); }
        });
      defineArrays(result, ['addedStates', 'removedStates', 'addedBuffs', 'addedDebuffs', 'removedBuffs'].map(field => [field, 'result.' + field]), () => object);
      results.set(object, result);
    }
    return results.get(this);
  };
  battler.clearResult = function() { this.result().clear(); };
  Object.defineProperty(base, '_hidden', { configurable: true,
    get() { return engine.entityField(handles.get(this), 'hidden'); },
    set(value) { engine.entityField(handles.get(this), 'hidden', value); }
  });
  for (const field of ['hp', 'mp', 'tp']) Object.defineProperty(base, '_' + field, {
    configurable: true, get() { return engine.entityField(handles.get(this), field); },
    set(value) { engine.entityField(handles.get(this), field, value); }
  });
  base.restriction = function() { return invoke(this, 'restriction'); };
  for (const method of ['refresh', 'recoverAll', 'eraseState', 'resetStateCounts'])
    base[method] = function(...args) { invoke(this, method, ...args); };
  for (const method of ['addState', 'removeState']) battler[method] = function(id) { invoke(this, method, id); };
  base.states = function() { return this._states.map(id => scope.$dataStates[id]); };
  base.isStateAffected = function(id) { return this._states.includes(id); };
  base.deathStateId = function() { return 1; };
  base.guardSkillId = function() { return 2; };
  base.isDeathStateAffected = function() { return this.isStateAffected(this.deathStateId()); };
  base.isHidden = function() { return this._hidden; };
  base.isAppeared = function() { return !this.isHidden(); };
  base.hide = function() { this._hidden = true; };
  base.appear = function() { this._hidden = false; };
  base.isAlive = function() { return this.isAppeared() && !this.isDeathStateAffected(); };
  base.isDead = function() { return this.isAppeared() && this.isDeathStateAffected(); };
  base.isRestricted = function() { return this.isAppeared() && this.restriction() > 0; };
  base.canMove = function() { return this.isAppeared() && this.restriction() < 4; };
  base.isConfused = function() { return this.isAppeared() && this.restriction() >= 1 && this.restriction() <= 3; };
  base.confusionLevel = function() { return this.isConfused() ? this.restriction() : 0; };
  base.hpRate = function() { return this.hp / this.mhp; };
  base.mpRate = function() { return this.mmp > 0 ? this.mp / this.mmp : 0; };
  base.tpRate = function() { return this.tp / this.maxTp(); };
  base.die = function() { this._hp = 0; this._states = []; this._buffs.fill(0); this._buffTurns.fill(0); };
  base.revive = function() { if (this._hp === 0) this._hp = 1; };
  base.updateBuffTurns = function() { for (let i = 0; i < this._buffTurns.length; ++i) if (this._buffTurns[i] > 0) --this._buffTurns[i]; };
  base.setHp = function(value) { this._hp = value; this.refresh(); };
  base.setMp = function(value) { this._mp = value; this.refresh(); };
  base.setTp = function(value) { this._tp = value; this.refresh(); };
  for (const [id, name] of ['mhp', 'mmp', 'atk', 'def', 'mat', 'mdf', 'agi', 'luk'].entries())
    Object.defineProperty(base, name, { configurable: true, get() { return this.param(id); } });
  for (const [id, name] of ['hit', 'eva', 'cri', 'cev', 'mev', 'mrf', 'cnt', 'hrg', 'mrg', 'trg'].entries())
    Object.defineProperty(base, name, { configurable: true, get() { return this.xparam(id); } });
  for (const [id, name] of ['tgr', 'grd', 'rec', 'pha', 'mcr', 'tcr', 'pdr', 'mdr', 'fdr', 'exr'].entries())
    Object.defineProperty(base, name, { configurable: true, get() { return this.sparam(id); } });
  base.paramBuffRate = function(id) { return 1 + this._buffs[id] * 0.25; };
  base.paramMin = function(id) { return id === 1 ? 0 : 1; };
  base.paramMax = function(id) { return id === 0 ? 999999 : id === 1 ? 9999 : 999; };
  base.paramBase = function() { return 0; };
  base.paramPlus = function(id) { return this._paramPlus[id]; };
  base.param = function(id) {
    const value = (this.paramBase(id) + this.paramPlus(id)) * this.paramRate(id) * this.paramBuffRate(id);
    return Math.round(Math.max(this.paramMin(id), Math.min(this.paramMax(id), value)));
  };
  scope.Game_Actor.prototype.paramMax = function(id) { return id === 0 ? 9999 : base.paramMax.call(this, id); };
  const constants = { TRAIT_ELEMENT_RATE: 11, TRAIT_DEBUFF_RATE: 12, TRAIT_STATE_RATE: 13, TRAIT_STATE_RESIST: 14,
    TRAIT_PARAM: 21, TRAIT_XPARAM: 22, TRAIT_SPARAM: 23, TRAIT_ATTACK_ELEMENT: 31, TRAIT_ATTACK_STATE: 32,
    TRAIT_ATTACK_SPEED: 33, TRAIT_ATTACK_TIMES: 34, TRAIT_STYPE_ADD: 41, TRAIT_STYPE_SEAL: 42,
    TRAIT_SKILL_ADD: 43, TRAIT_SKILL_SEAL: 44, TRAIT_EQUIP_WTYPE: 51, TRAIT_EQUIP_ATYPE: 52,
    TRAIT_EQUIP_LOCK: 53, TRAIT_EQUIP_SEAL: 54, TRAIT_SLOT_TYPE: 55, TRAIT_ACTION_PLUS: 61,
    TRAIT_SPECIAL_FLAG: 62, TRAIT_COLLAPSE_TYPE: 63, TRAIT_PARTY_ABILITY: 64,
    FLAG_ID_AUTO_BATTLE: 0, FLAG_ID_GUARD: 1, FLAG_ID_SUBSTITUTE: 2, FLAG_ID_PRESERVE_TP: 3,
    ICON_BUFF_START: 32, ICON_DEBUFF_START: 48 };
  Object.assign(scope.Game_BattlerBase, constants);
  base.traitObjects = function() { return this.states(); };
  base.allTraits = function() { return this.traitObjects().flatMap(object => object.traits || []); };
  base.traits = function(code) { return this.allTraits().filter(trait => trait.code === code); };
  base.traitsWithId = function(code, id) { return this.traits(code).filter(trait => trait.dataId === id); };
  base.traitsPi = function(code, id) { return this.traitsWithId(code, id).reduce((result, trait) => result * trait.value, 1); };
  base.traitsSum = function(code, id) { return this.traitsWithId(code, id).reduce((result, trait) => result + trait.value, 0); };
  base.traitsSumAll = function(code) { return this.traits(code).reduce((result, trait) => result + trait.value, 0); };
  base.traitsSet = function(code) { return createArray(new Set(this.traits(code).map(trait => trait.dataId))); };
  base.xparam = function(id) { return this.traitsSum(constants.TRAIT_XPARAM, id); };
  base.sparam = function(id) { return this.traitsPi(constants.TRAIT_SPARAM, id); };
  base.paramRate = function(id) { return this.traitsPi(constants.TRAIT_PARAM, id); };
  for (const [name, code] of Object.entries({ elementRate: 11, debuffRate: 12, stateRate: 13 }))
    base[name] = function(id) { return this.traitsPi(code, id); };
  for (const [name, code] of Object.entries({ stateResistSet: 14, attackElements: 31, attackStates: 32, addedSkillTypes: 41,
    addedSkills: 43 })) base[name] = function() { return this.traitsSet(code); };
  for (const [name, code] of Object.entries({ isStateResist: 14, isSkillTypeSealed: 42, isSkillSealed: 44,
    isEquipWtypeOk: 51, isEquipAtypeOk: 52, isEquipTypeLocked: 53, isEquipTypeSealed: 54 }))
    base[name] = function(id) { return this.traitsSet(code).includes(id); };
  base.attackStatesRate = function(id) { return this.traitsSum(constants.TRAIT_ATTACK_STATE, id); };
  base.attackSpeed = function() { return this.traitsSumAll(constants.TRAIT_ATTACK_SPEED); };
  base.attackTimesAdd = function() { return Math.max(this.traitsSumAll(constants.TRAIT_ATTACK_TIMES), 0); };
  base.slotType = function() { return Math.max(0, ...this.traitsSet(constants.TRAIT_SLOT_TYPE)); };
  base.isDualWield = function() { return this.slotType() === 1; };
  base.actionPlusSet = function() { return this.traits(constants.TRAIT_ACTION_PLUS).map(trait => trait.value); };
  base.specialFlag = function(id) { return this.traitsSet(constants.TRAIT_SPECIAL_FLAG).includes(id); };
  base.partyAbility = function(id) { return this.traitsSet(constants.TRAIT_PARTY_ABILITY).includes(id); };
  base.collapseType = function() { return Math.max(0, ...this.traitsSet(constants.TRAIT_COLLAPSE_TYPE)); };
  base.isAutoBattle = function() { return this.specialFlag(constants.FLAG_ID_AUTO_BATTLE); };
  base.isGuard = function() { return this.specialFlag(constants.FLAG_ID_GUARD) && this.canMove(); };
  base.isSubstitute = function() { return this.specialFlag(constants.FLAG_ID_SUBSTITUTE) && this.canMove(); };
  base.isPreserveTp = function() { return this.specialFlag(constants.FLAG_ID_PRESERVE_TP); };
  base.stateIcons = function() { return this.states().map(state => state.iconIndex).filter(index => index > 0); };
  base.buffIconIndex = function(level, id) { return level > 0 ? constants.ICON_BUFF_START + (level - 1) * 8 + id : level < 0 ? constants.ICON_DEBUFF_START + (-level - 1) * 8 + id : 0; };
  base.buffIcons = function() { return this._buffs.map((level, id) => this.buffIconIndex(level, id)).filter(index => index > 0); };
  base.allIcons = function() { return this.stateIcons().concat(this.buffIcons()); };
  base.skillMpCost = function(skill) { return Math.floor(skill.mpCost * this.mcr); };
  base.skillTpCost = function(skill) { return skill.tpCost; };
  base.canPaySkillCost = function(skill) { return this._mp >= this.skillMpCost(skill) && this._tp >= this.skillTpCost(skill); };
  base.paySkillCost = function(skill) { this._mp -= this.skillMpCost(skill); this._tp -= this.skillTpCost(skill); };
  base.isOccasionOk = function(item) { return item.occasion === 0 || item.occasion === (scope.$gameParty.inBattle() ? 1 : 2); };
  base.meetsUsableItemConditions = function(item) { return this.canMove() && this.isOccasionOk(item); };
  base.isSkillWtypeOk = function() { return true; };
  base.meetsSkillConditions = function(skill) { return this.meetsUsableItemConditions(skill) && this.isSkillWtypeOk(skill) && this.canPaySkillCost(skill) && !this.isSkillSealed(skill.id) && !this.isSkillTypeSealed(skill.stypeId); };
  base.meetsItemConditions = function(item) { return this.meetsUsableItemConditions(item) && scope.$gameParty.hasItem(item); };
  base.canUse = function(item) { return scope.DataManager.isSkill(item) ? this.meetsSkillConditions(item) : scope.DataManager.isItem(item) ? this.meetsItemConditions(item) : false; };
  base.canAttack = function() { return this.canUse(scope.$dataSkills[this.attackSkillId()]); };
  base.canGuard = function() { return this.canUse(scope.$dataSkills[this.guardSkillId()]); };
  base.canEquip = function(item) { return scope.DataManager.isWeapon(item) ? this.isEquipWtypeOk(item.wtypeId) && !this.isEquipTypeSealed(item.etypeId) : scope.DataManager.isArmor(item) ? this.isEquipAtypeOk(item.atypeId) && !this.isEquipTypeSealed(item.etypeId) : false; };
  base.addParam = function(id, value) { this._paramPlus[id] += value; this.refresh(); };

  const actor = scope.Game_Actor.prototype, enemy = scope.Game_Enemy.prototype;
  defineArrays(actor, [['_skills', 'skills']]);
  for (const field of ['level', 'nickname', 'profile', 'characterName', 'characterIndex', 'faceName', 'faceIndex', 'battlerName']) {
    Object.defineProperty(actor, '_' + field, { configurable: true,
      get() { return engine.entityField(handles.get(this), field); },
      set(value) { engine.entityField(handles.get(this), field, value); }
    });
    if (field === 'level') Object.defineProperty(actor, 'level', { configurable: true, get() { return this._level; } });
    else actor[field] = function() { return this['_' + field]; };
  }
  for (const name of ['Name', 'Nickname', 'Profile']) actor['set' + name] = function(value) { this['_' + name[0].toLowerCase() + name.slice(1)] = value; };
  actor.setCharacterImage = function(name, index) { this._characterName = name; this._characterIndex = index; };
  actor.setFaceImage = function(name, index) { this._faceName = name; this._faceIndex = index; };
  actor.setBattlerImage = function(name) { this._battlerName = name; };
  actor.equips = function() { const kinds = read(this, 'equipKinds'); return read(this, 'equips').map((id, i) => id > 0 ? scope[kinds[i] === 1 ? '$dataWeapons' : '$dataArmors'][id] : null); };
  actor.weapons = function() { return this.equips().filter(item => scope.DataManager.isWeapon(item)); };
  actor.armors = function() { return this.equips().filter(item => scope.DataManager.isArmor(item)); };
  actor.hasWeapon = function(item) { return this.weapons().includes(item); };
  actor.hasArmor = function(item) { return this.armors().includes(item); };
  actor.isEquipped = function(item) { return this.equips().includes(item); };
  actor.discardEquip = function(item) { const index = this.equips().indexOf(item); if (index >= 0) { const values = read(this, 'equips'); values[index] = 0; write(this, 'equips', values); } };
  actor.traitObjects = function() { return base.traitObjects.call(this).concat(this.actor(), this.currentClass(), this.equips().filter(Boolean)); };
  enemy.traitObjects = function() { return base.traitObjects.call(this).concat(this.enemy()); };
  actor.paramBase = function(id) { return this.currentClass().params[id][this._level]; };
  actor.paramPlus = function(id) { return base.paramPlus.call(this, id) + this.equips().reduce((sum, item) => sum + (item ? item.params[id] : 0), 0); };
  enemy.paramBase = function(id) { return this.enemy().params[id]; };
  actor.skills = function() { return createArray(new Set(read(this, 'skills').concat(this.addedSkills()))).sort((a, b) => a - b).map(id => scope.$dataSkills[id]); };
  actor.isLearnedSkill = function(id) { return read(this, 'skills').includes(id); };
  actor.learnSkill = function(id) { write(this, 'skills', [...new Set(read(this, 'skills').concat(id))].sort((a, b) => a - b)); };
  actor.forgetSkill = function(id) { write(this, 'skills', read(this, 'skills').filter(value => value !== id)); };
  actor.maxLevel = function() { return this.actor().maxLevel; };
  actor.isMaxLevel = function() { return this._level >= this.maxLevel(); };
  actor.isClass = function(value) { return this.currentClass() === value; };
  actor.isSkillWtypeOk = function(skill) { return (!skill.requiredWtypeId1 && !skill.requiredWtypeId2) || this.weapons().some(item => item.wtypeId === skill.requiredWtypeId1 || item.wtypeId === skill.requiredWtypeId2); };
  enemy.isSpriteVisible = function() { return true; };
}

module.exports = { installBattlerBindings };
