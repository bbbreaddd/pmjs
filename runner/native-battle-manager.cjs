'use strict';
const { installManagerReference } = require('./native-manager-reference.cjs');

function installBattleManager(runtime, engine, session) {
  const { scope } = runtime;
  const manager = installManagerReference(runtime, 'BattleManager');
  const invoke = (method, ...args) => engine.gameDataInvoke(session, 'battle', method, args);
  for (const name of ['_phase', '_battleTest', '_actorIndex', '_escapeRatio', '_preemptive', '_surprise', '_canEscape', '_canLose', '_turnForced', '_mapBgm', '_mapBgs'])
    Object.defineProperty(manager, name, { configurable: true, get() { return invoke('field', name); }, set(value) { invoke('field', name, value); } });
  let action, epoch = 0;
  const initialize = manager.initMembers;
  manager.initMembers = function() { ++epoch; return initialize.call(this); };
  const battler = value => value.actorId ? scope.$gameActors.actor(value.actorId) : scope.$gameTroop.members()[value.enemyIndex];
  const identity = object => object.isActor() ? { actorId: object.actorId(), enemyIndex: -1 } : { actorId: 0, enemyIndex: object.index() };
  function currentAction() {
    const state = invoke('action');
    if (!state) return null;
    if (action?.serial === state.serial && action.epoch === epoch) return action.object;
    const object = Object.create(scope.Game_Action.prototype), serial = state.serial, generation = epoch;
    let last = state, subject = battler(state);
    const live = () => generation === epoch && invoke('action')?.serial === serial;
    const read = () => { if (live()) { last = invoke('action'); subject = battler(last); } return last; };
    for (const [property, field] of Object.entries({ _itemId: 'id', _isItem: 'item', _targetIndex: 'target', _forcing: 'forced' }))
      Object.defineProperty(object, property, { configurable: true, enumerable: true, get() { return read()[field]; }, set(value) { if (live()) invoke('action', field, value, serial); last[field] = value; } });
    Object.defineProperty(object, '_subject', { configurable: true, get() { read(); return subject; }, set(value) { const target = identity(value); subject = value; if (live()) invoke('subject', target.actorId, target.enemyIndex); Object.assign(last, target); } });
    action = { serial, epoch, object }; return object;
  }
  Object.defineProperty(manager, '_action', { configurable: true, get: currentAction, set(value) {
    const current = currentAction();
    if (!current || !value || current === value) return;
    current._subject = value.subject(); current._itemId = value._itemId; current._isItem = value._isItem; current._targetIndex = value._targetIndex; current._forcing = value._forcing;
  } });
  Object.defineProperty(manager, '_subject', { configurable: true, get() { const action=currentAction(); if(action)return action.subject(); const next=invoke('nextSubject');return next?battler(next):null; }, set(value) { const current=currentAction(); if (current && value) current._subject=value; } });
  function nativeList(operation) {
    const read = () => invoke(operation).map(battler), write = items => invoke(operation, items.map(identity));
    const target = runtime.runScript('[]');
    const mutators = new Set(['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'copyWithin', 'fill']);
    return new Proxy(target, {
      get(array, key, receiver) {
        const items = read();
        if (key === 'length') return items.length;
        if (typeof key === 'string' && /^(0|[1-9][0-9]*)$/.test(key)) return items[Number(key)];
        if (mutators.has(key)) return (...args) => { const result = Array.prototype[key].apply(items, args); write(items); return result === items ? receiver : result; };
        return Reflect.get(array, key, receiver);
      },
      set(array, key, value) {
        const items = read();
        if (key === 'length') items.length = value;
        else if (typeof key === 'string' && /^(0|[1-9][0-9]*)$/.test(key)) items[Number(key)] = value;
        else return Reflect.set(array, key, value);
        write(items); return true;
      },
      has(array, key) { return typeof key === 'string' && /^(0|[1-9][0-9]*)$/.test(key) ? Number(key) < read().length : Reflect.has(array, key); },
      ownKeys(array) { array.length=read().length; return [...read().keys()].map(String).concat('length'); },
      getOwnPropertyDescriptor(array,key) { const items=read(); if(key==='length'){array.length=items.length;return Reflect.getOwnPropertyDescriptor(array,key);} return typeof key==='string' && /^(0|[1-9][0-9]*)$/.test(key) && Number(key)<items.length ? {configurable:true,enumerable:true,writable:true,value:items[Number(key)]} : Reflect.getOwnPropertyDescriptor(array,key); }
    });
  }
  for (const [field, operation] of [['_targets', 'targets'], ['_actionBattlers', 'orders']]) {
    const array = nativeList(operation);
    Object.defineProperty(manager, field, { configurable: true, get() { return array; }, set(value) { invoke(operation, value.map(identity)); } });
  }
  manager.initMembers();
  for (const method of ['update', 'startInput', 'startTurn', 'endTurn', 'processVictory', 'processDefeat', 'processAbort', 'startAction', 'invokeAction', 'endAction', 'makeActionOrders', 'processEscape', 'playVictoryMe', 'playDefeatMe', 'playBattleBgm', 'replayBgmAndBgs', 'processTurn', 'updateBattleEnd'])
    manager[method] = function(...args) { return invoke(method, ...args); };
  manager.invokeAction = function(subject, target) {
    if (subject) this._subject = subject;
    if (target && target !== this._targets[0]) this._targets[0] = target;
    return invoke('invokeAction');
  };
  manager.makeRewards = function() {
    const rewards = invoke('rewards');
    this._rewards = { gold: rewards.gold, exp: rewards.exp, items: rewards.items.map(item => scope[['', '$dataItems', '$dataWeapons', '$dataArmors'][item.kind]][item.id]) };
  };
  manager.gainExp = function() { invoke('gainExp', this._rewards.exp); };
  manager.endBattle = function(result) { invoke('endBattle', result); if (this._eventCallback) this._eventCallback(result); };
  manager.isInputting = () => invoke('isInputting');
  manager.actor = () => { const id = invoke('actorId'); return id ? scope.$gameActors.actor(id) : null; };
  manager.setup = function(troopId, canEscape, canLose, event = true) {
    this.initMembers(); return invoke('setup', troopId, canEscape, canLose, event);
  };
  return manager;
}
module.exports = { installBattleManager };
