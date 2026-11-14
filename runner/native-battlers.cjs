'use strict';
// RPG Maker MV behavior: Copyright (c) 2015 KADOKAWA CORPORATION./YOJI OJIMA.
// MIT license: third_party/rpg-maker-mv.LICENSE.
const { installEquipArray } = require('./native-equips.cjs');
const { nativeArray } = require('./native-array.cjs');
const { nativeDictionary } = require('./native-dictionary.cjs');

function installBattlerBindings(scope, engine, session, handles, createArray, createObject = () => ({}), actions) {
  const base = scope.Game_BattlerBase.prototype, battler = scope.Game_Battler.prototype;
  const invoke = (object, method, ...args) => engine.actorInvoke(session, handles.get(object), method, args);
  const actionViews = new WeakMap();
  function actionArray(object) {
    if (!actionViews.has(object)) actionViews.set(object, nativeArray(() => createArray([]),
      () => createArray(engine.battlerActions(session, handles.get(object)).map(handle => actions.wrapAction(handle))),
      values => engine.battlerActions(session, handles.get(object), values.map(value => {
        const handle = actions.actionHandles.get(value);
        if (!handle) throw new TypeError('Battler actions require Game_Action objects');
        return handle;
      }))));
    return actionViews.get(object);
  }
  Object.defineProperty(battler, '_actions', { configurable: true, enumerable: true,
    get() { return actionArray(this).view; }, set(values) { actionArray(this).replace(values); }
  });
  for (const [property, field] of [['_actionState', 'actionState'], ['_actionInputIndex', 'actionInputIndex'], ['_selected', 'selected']])
    Object.defineProperty(battler, property, { configurable: true, enumerable: true,
      get() { return invoke(this, field); }, set(value) { invoke(this, field, value); }
    });
  battler.clearActions = function() { this._actions = []; };
  battler.currentAction = function() { return this._actions[0]; };
  battler.action = function(index) { return this._actions[index]; };
  battler.numActions = function() { return this._actions.length; };
  battler.setAction = function(index, action) { this._actions[index] = action; };
  battler.removeCurrentAction = function() { this._actions.shift(); };
  battler.actionPlusSet = function() { return createArray(invoke(this, 'actionPlusSet')); };
  battler.makeActionTimes = function() { return this.actionPlusSet().reduce((count, chance) => count + (Math.random() < chance ? 1 : 0), 1); };
  battler.makeActions = function() {
    this.clearActions();
    if (this.canMove()) for (let index = 0, count = this.makeActionTimes(); index < count; ++index) this._actions.push(new scope.Game_Action(this));
  };
  battler.setActionState = function(state) { this._actionState = state; this.requestMotionRefresh(); };
  battler.isSelected = function() { return this._selected; };
  battler.select = function() { this._selected = true; };
  battler.deselect = function() { this._selected = false; };
  for (const Type of [scope.Game_Actor, scope.Game_Enemy]) Type.prototype.makeActions = function() {
    battler.makeActions.call(this);
    if (this.isActor()) this.setActionState(this.numActions() ? 'undecided' : 'waiting');
    invoke(this, 'fillActions');
    if (this.isEnemy() || this.isAutoBattle() || this.isConfused()) this.setActionState('waiting');
  };
  battler.initTp = function() { this.setTp(Math.floor(Math.random() * 25)); };
  battler.clearTp = function() { this.setTp(0); };
  battler.onBattleStart = function() { this.setActionState('undecided'); this.clearMotion(); if (!this.isPreserveTp()) this.initTp(); };
  battler.onBattleEnd = function() {
    this.clearResult(); this.removeBattleStates(); this.removeAllBuffs(); this.clearActions();
    if (!this.isPreserveTp()) this.clearTp();
    this.appear();
  };
  // These base presentation hooks intentionally have no effect in MV.
  battler.performAction = function(action) {};
  battler.performSubstitute = function(target) {};
  battler.performActionStart = function(action) { if (!action.isGuard()) this.setActionState('acting'); };
  battler.performActionEnd = function() { this.setActionState('done'); };
  scope.Game_Actor.prototype.performAction = function(action) {
    battler.performAction.call(this, action);
    if (action.isAttack()) this.performAttack();
    else if (action.isGuard()) this.requestMotion('guard');
    else if (action.isMagicSkill()) this.requestMotion('spell');
    else if (action.isSkill()) this.requestMotion('skill');
    else if (action.isItem()) this.requestMotion('item');
  };
  base.onRestrict = function() {};
  battler.onRestrict = function() {
    base.onRestrict.call(this); this.clearActions();
    for (const state of this.states()) if (state.removeByRestriction) this.removeState(state.id);
  };
  base.sortStates = function() { this._states.sort((a, b) => (scope.$dataStates[b].priority - scope.$dataStates[a].priority) || a - b); };
  base.addNewState = function(id) {
    if (id === this.deathStateId()) this.die();
    const restricted = this.isRestricted(); this._states.push(id); this.sortStates();
    if (!restricted && this.isRestricted()) this.onRestrict();
  };
  battler.startDamagePopup = function() { invoke(this, 'damagePopup', true); };
  battler.isDamagePopupRequested = function() { return invoke(this, 'damagePopup'); };
  battler.clearDamagePopup = function() { invoke(this, 'damagePopup', false); };
  battler.escape = function() { if (scope.$gameParty.inBattle()) this.hide(); this.clearActions(); this.clearStates(); scope.SoundManager.playEscape(); };
  battler.isInputting = function() { return this._actionState === 'inputting'; };
  battler.isActing = function() { return this._actionState === 'acting'; };
  scope.Game_Actor.prototype.attackAnimationId1 = function() { return this.hasNoWeapons() ? this.bareHandsAnimationId() : this.weapons()[0].animationId; };
  scope.Game_Actor.prototype.attackAnimationId2 = function() { return this.weapons()[1]?.animationId || 0; };
  scope.Game_Actor.prototype.bareHandsAnimationId = function() { return 1; };
  scope.Game_Actor.prototype.inputtingAction = function() { return this.action(this._actionInputIndex); };
  scope.Game_Actor.prototype.selectNextCommand = function() {
    if (this._actionInputIndex < this.numActions() - 1) { ++this._actionInputIndex; return true; }
    return false;
  };
  scope.Game_Actor.prototype.selectPreviousCommand = function() {
    if (this._actionInputIndex > 0) { --this._actionInputIndex; return true; }
    return false;
  };
  scope.Game_Actor.prototype.setup = function(id) { invoke(this, 'setup', id); };
  scope.Game_Actor.prototype.testEscape = function(item) { return item.effects.some(effect => effect && effect.code === scope.Game_Action.EFFECT_SPECIAL); };
  scope.Game_Enemy.prototype.transform = function(id) { invoke(this, 'transform', id); };
  battler.startAnimation = function(id, mirror, delay) { invoke(this, 'startAnimation', id, Boolean(mirror), delay || 0); };
  scope.Game_Actor.prototype.startAnimation = function(id, mirror, delay) { battler.startAnimation.call(this, id, !mirror, delay); };
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
  function defineDictionary(prototype, property, field) {
    const views = new WeakMap();
    const dictionary = object => {
      if (!views.has(object)) views.set(object, nativeDictionary(createObject, (method, ...args) => invoke(object, field + '.' + method, ...args)));
      return views.get(object);
    };
    Object.defineProperty(prototype, property, { configurable: true, enumerable: true,
      get() { return dictionary(this).view; }, set(value) { dictionary(this).replace(value); }
    });
  }
  defineDictionary(base, '_stateTurns', 'stateTurns');
  base.initMembers = function() {
    this._hp = 1; this._mp = 0; this._tp = 0; this._hidden = false;
    this.clearParamPlus(); this.clearStates(); this.clearBuffs();
  };
  base.clearParamPlus = function() { this._paramPlus = Array(8).fill(0); };
  base.clearStates = function() { this._states = []; this._stateTurns = {}; };
  base.isStateExpired = function(id) { return this._stateTurns[id] === 0; };
  base.updateStateTurns = function() { for (const id of this._states) if (this._stateTurns[id] > 0) --this._stateTurns[id]; };
  base.stateResistSet = function() { return this.traitsSet(14); };
  base.isStateResist = function(id) { return this.stateResistSet().includes(id); };
  battler.isStateRestrict = function(id) { return scope.$dataStates[id].removeByRestriction && this.isRestricted(); };
  battler.isStateAddable = function(id) { return this.isAlive() && scope.$dataStates[id] && !this.isStateResist(id) && !this.result().isStateRemoved(id) && !this.isStateRestrict(id); };
  battler.removeStatesAuto = function(timing) {
    if (!scope.$dataStates) return invoke(this, 'removeStatesAuto', timing);
    for (const state of this.states()) if (this.isStateExpired(state.id) && state.autoRemovalTiming === timing) this.removeState(state.id);
  };
  base.clearBuffs = function() { this._buffs = Array(8).fill(0); this._buffTurns = Array(8).fill(0); };
  base.eraseBuff = function(id) { this._buffs[id] = 0; this._buffTurns[id] = 0; };
  base.buffLength = function() { return this._buffs.length; };
  base.buff = function(id) { return this._buffs[id]; };
  base.isBuffAffected = function(id) { return this._buffs[id] > 0; };
  base.isDebuffAffected = function(id) { return this._buffs[id] < 0; };
  base.isBuffOrDebuffAffected = function(id) { return this._buffs[id] !== 0; };
  base.isMaxBuffAffected = function(id) { return this._buffs[id] === 2; };
  base.isMaxDebuffAffected = function(id) { return this._buffs[id] === -2; };
  base.increaseBuff = function(id) { if (!this.isMaxBuffAffected(id)) ++this._buffs[id]; };
  base.decreaseBuff = function(id) { if (!this.isMaxDebuffAffected(id)) --this._buffs[id]; };
  base.overwriteBuffTurns = function(id, turns) { if (this._buffTurns[id] < turns) this._buffTurns[id] = turns; };
  base.isBuffExpired = function(id) { return this._buffTurns[id] === 0; };
  for (const [method, change, affected, result] of [
    ['addBuff', 'increaseBuff', 'isBuffAffected', 'pushAddedBuff'],
    ['addDebuff', 'decreaseBuff', 'isDebuffAffected', 'pushAddedDebuff']
  ]) battler[method] = function(id, turns) {
    if (this.isAlive()) { this[change](id); if (this[affected](id)) this.overwriteBuffTurns(id, turns); this.result()[result](id); this.refresh(); }
  };
  battler.removeBuff = function(id) { if (this.isAlive() && this.isBuffOrDebuffAffected(id)) { this.eraseBuff(id); this.result().pushRemovedBuff(id); this.refresh(); } };
  battler.removeAllBuffs = function() { for (let id = 0; id < this.buffLength(); ++id) this.removeBuff(id); };
  battler.removeBuffsAuto = function() { for (let id = 0; id < this.buffLength(); ++id) if (this.isBuffExpired(id)) this.removeBuff(id); };
  battler.removeBattleStates = function() {
    if (!scope.$dataStates) return invoke(this, 'removeBattleStates');
    for (const state of this.states()) if (state.removeAtBattleEnd) this.removeState(state.id);
  };
  function hasParameterData(object) {
    return scope.$dataSystem && scope.$dataStates && (object.isActor()
      ? scope.$dataActors && scope.$dataClasses && scope.$dataWeapons && scope.$dataArmors : scope.$dataEnemies);
  }
  battler.maxSlipDamage = function() { return scope.$dataSystem ? (scope.$dataSystem.optSlipDeath ? this.hp : Math.max(this.hp - 1, 0)) : invoke(this, 'maxSlipDamage'); };
  battler.regenerateHp = function() {
    if (!hasParameterData(this)) return invoke(this, 'regenerateHp');
    const value = Math.max(Math.floor(this.mhp * this.hrg), -this.maxSlipDamage()); if (value !== 0) this.gainHp(value);
  };
  battler.regenerateMp = function() {
    if (!hasParameterData(this)) return invoke(this, 'regenerateMp');
    const value = Math.floor(this.mmp * this.mrg); if (value !== 0) this.gainMp(value);
  };
  battler.regenerateTp = function() { if (!hasParameterData(this)) return invoke(this, 'regenerateTp'); this.gainSilentTp(Math.floor(100 * this.trg)); };
  battler.regenerateAll = function() { if (this.isAlive()) { this.regenerateHp(); this.regenerateMp(); this.regenerateTp(); } };
  battler.onAllActionsEnd = function() { this.clearResult(); this.removeStatesAuto(1); this.removeBuffsAuto(); };
  battler.onTurnEnd = function() {
    this.clearResult(); this.regenerateAll();
    if (!scope.BattleManager.isForcedTurn()) { this.updateStateTurns(); this.updateBuffTurns(); }
    this.removeStatesAuto(2);
  };

  battler.onDamage = function(value) {
      this.removeStatesByDamage();
      this.chargeTpByDamage(value / this.mhp);
  };
  battler.removeStatesByDamage = function() {
      this.states().forEach(function(state) {
          if (state.removeByDamage && Math.floor(Math.random() * 100) < state.chanceByDamage) {
              this.removeState(state.id);
          }
      }, this);
  };
  battler.chargeTpByDamage = function(damageRate) {
      const value = Math.floor(50 * damageRate * this.tcr);
      this.gainSilentTp(value);
  };
  battler.consumeItem = function(item) { scope.$gameParty.consumeItem(item); };
  battler.useItem = function(item) {
      if (scope.DataManager.isSkill(item)) {
          this.paySkillCost(item);
      } else if (scope.DataManager.isItem(item)) {
          this.consumeItem(item);
      }
  };
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
  const resultFor = battler.result;
  Object.defineProperty(battler, '_result', { configurable: true, enumerable: true,
    get() { return resultFor.call(this); },
    set(value) {
      const result = resultFor.call(this);
      for (const key of ['used', 'missed', 'evaded', 'physical', 'drain', 'critical', 'success', 'hpAffected', 'hpDamage', 'mpDamage', 'tpDamage', 'addedStates', 'removedStates', 'addedBuffs', 'addedDebuffs', 'removedBuffs']) result[key] = value[key];
    }
  });
  for (const kind of ['Hp', 'Mp', 'Tp']) battler['gain' + kind] = function(value) {
    const field = kind.toLowerCase(), result = this.result();
    result[field + 'Damage'] = -value;
    if (kind === 'Hp') result.hpAffected = true;
    this['set' + kind](this[field] + value);
  };
  const motions = ['walk', 'wait', 'chant', 'guard', 'damage', 'evade', 'thrust', 'swing', 'missile', 'skill', 'spell', 'item', 'escape', 'victory', 'dying', 'abnormal', 'sleep', 'dead'];
  battler.requestMotion = function(type) { invoke(this, 'requestMotion', motions.indexOf(type)); };
  battler.motionType = function() { return motions[invoke(this, 'motionType')]; };
  battler.requestMotionRefresh = function() { invoke(this, 'motionRefresh', true); };
  battler.isMotionRefreshRequested = function() { return invoke(this, 'motionRefresh'); };
  battler.clearMotion = function() { invoke(this, 'clearMotion'); };
  battler.startWeaponAnimation = function(id) { invoke(this, 'startWeaponAnimation', id); };
  for (const method of ['performDamage', 'performMiss', 'performRecovery', 'performEvasion', 'performMagicEvasion', 'performCounter', 'performReflection', 'performCollapse'])
    battler[method] = function() { invoke(this, 'performBase', method); };
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
  base.isDying = function() { return this.isAlive() && this.hp < this.mhp / 4; };
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
  base.collapseType = function() { return hasParameterData(this) ? Math.max(0, ...this.traitsSet(constants.TRAIT_COLLAPSE_TYPE)) : invoke(this, 'collapseType'); };
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
  actor.performCollapse = function() { battler.performCollapse.call(this); invoke(this, 'performDerived', 'performCollapse'); };
  for (const method of ['performEvasion', 'performMagicEvasion']) actor[method] = function() { battler[method].call(this); this.requestMotion('evade'); };
  actor.isSpriteVisible = function() { return scope.$gameSystem.isSideView(); };
  actor.performDamage = function() {
    battler.performDamage.call(this);
    if (this.isSpriteVisible()) this.requestMotion('damage'); else scope.$gameScreen.startShake(5, 5, 10);
    invoke(this, 'performDerived', 'actorDamageSound');
  };
  actor.performAttack = function() {
    let attack;
    if (scope.$dataSystem?.attackMotions && scope.$dataWeapons) {
      const weapons = this.weapons(); attack = scope.$dataSystem.attackMotions[weapons[0] ? weapons[0].wtypeId : 0];
    } else attack = invoke(this, 'attackMotion');
    if (attack) { if (attack.type >= 0 && attack.type <= 2) this.requestMotion(['thrust', 'swing', 'missile'][attack.type]); this.startWeaponAnimation(attack.weaponImageId); }
  };
  enemy.performDamage = function() { battler.performDamage.call(this); this.requestEffect('blink'); invoke(this, 'performDerived', 'enemyDamageSound'); };
  enemy.performCollapse = function() {
    battler.performCollapse.call(this); const type = this.collapseType();
    if (type >= 0 && type <= 2) this.requestEffect(['collapse', 'bossCollapse', 'instantCollapse'][type]);
    invoke(this, 'collapseSound', type);
  };
  actor.performCounter = function() { battler.performCounter.call(this); this.performAttack(); };
  actor.performEscape = function() { if (this.canMove()) this.requestMotion('escape'); };
  enemy.requestEffect = function(type) { invoke(this, 'requestEffect', type); };

  actor.optimizeEquipments = function() {
      const maxSlots = this.equipSlots().length;
      this.clearEquipments();
      for (let i = 0; i < maxSlots; i++) {
          if (this.isEquipChangeOk(i)) {
              this.changeEquip(i, this.bestEquipItem(i));
          }
      }
  };
  actor.bestEquipItem = function(slotId) {
      const etypeId = this.equipSlots()[slotId];
      const items = scope.$gameParty.equipItems().filter(function(item) {
          return item.etypeId === etypeId && this.canEquip(item);
      }, this);
      let bestItem = null;
      let bestPerformance = -1000;
      for (let i = 0; i < items.length; i++) {
          const performance = this.calcEquipItemPerformance(items[i]);
          if (performance > bestPerformance) {
              bestPerformance = performance;
              bestItem = items[i];
          }
      }
      return bestItem;
  };
  actor.calcEquipItemPerformance = function(item) {
      return item.params.reduce(function(a, b) {
          return a + b;
      });
  };
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
  defineDictionary(actor, '_exp', 'exp');
  defineDictionary(actor, '_stateSteps', 'stateSteps');
  actor.currentExp = function() { return invoke(this, 'currentExp'); };
  actor.changeExp = function(exp, show) { invoke(this, 'changeExp', Math.max(exp, 0), Boolean(show)); };
  actor.levelUp = function() { if (!scope.$dataClasses) { invoke(this, 'levelUp'); return; } ++this._level; for (const learning of this.currentClass().learnings) if (learning.level === this._level) this.learnSkill(learning.skillId); };
  actor.levelDown = function() { --this._level; };
  actor.changeClass = function(id, keepExp) {
    if (keepExp) this._exp[id] = this.currentExp();
    this._classId = id; this.changeExp(this._exp[id] || 0, false); this.refresh();
  };
  actor.refresh = function() {
    if (!scope.$dataSystem || !scope.$dataWeapons || !scope.$dataArmors || !scope.$dataClasses || !scope.$dataStates) { invoke(this, 'actorRefresh'); return; }
    this.releaseUnequippableItems(false); base.refresh.call(this);
  };
  installEquipArray(scope, read, write, createArray);
  actor.equipSlots = function() {
    const slots = createArray(scope.$dataSystem.equipTypes.slice(1).map((value, index) => index + 1));
    if (slots.length >= 2 && this.isDualWield()) slots[1] = 1;
    return slots;
  };
  actor.isEquipChangeOk = function(slot) { const type = this.equipSlots()[slot]; return !this.isEquipTypeLocked(type) && !this.isEquipTypeSealed(type); };
  actor.tradeItemWithParty = function(item, previous) {
    if (item && !scope.$gameParty.hasItem(item)) return false;
    scope.$gameParty.gainItem(previous, 1); scope.$gameParty.loseItem(item, 1); return true;
  };
  actor.changeEquip = function(slot, item) {
    if (this.tradeItemWithParty(item, this.equips()[slot]) && (!item || this.equipSlots()[slot] === item.etypeId)) {
      this._equips[slot].setObject(item); this.refresh();
    }
  };
  actor.forceChangeEquip = function(slot, item) { this._equips[slot].setObject(item); this.releaseUnequippableItems(true); this.refresh(); };
  actor.changeEquipById = function(type, id) { const slot = type - 1; this.changeEquip(slot, scope[this.equipSlots()[slot] === 1 ? '$dataWeapons' : '$dataArmors'][id]); };
  actor.releaseUnequippableItems = function(forcing) {
    for (;;) {
      const slots = this.equipSlots(), equips = this.equips();
      let changed = false;
      for (let index = 0; index < equips.length; ++index) {
        const item = equips[index];
        if (item && (!this.canEquip(item) || item.etypeId !== slots[index])) {
          if (!forcing) this.tradeItemWithParty(null, item);
          this._equips[index].setObject(null); changed = true;
        }
      }
      if (!changed) break;
    }
  };
  actor.clearEquipments = function() { for (let slot = 0; slot < this.equipSlots().length; ++slot) if (this.isEquipChangeOk(slot)) this.changeEquip(slot, null); };
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
