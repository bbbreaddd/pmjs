'use strict';

function installBattleData(scope, createArray) {
  function Game_Item(item) { this.initialize(item); }
  const item = Game_Item.prototype;
  item.initialize = function(value) { this._dataClass = ''; this._itemId = 0; if (value) this.setObject(value); };
  for (const [method, type] of Object.entries({ isSkill: 'skill', isItem: 'item', isWeapon: 'weapon', isArmor: 'armor', isNull: '' }))
    item[method] = function() { return this._dataClass === type; };
  item.isUsableItem = function() { return this.isSkill() || this.isItem(); };
  item.isEquipItem = function() { return this.isWeapon() || this.isArmor(); };
  item.itemId = function() { return this._itemId; };
  item.object = function() {
    const table = { skill: '$dataSkills', item: '$dataItems', weapon: '$dataWeapons', armor: '$dataArmors' }[this._dataClass];
    return table ? scope[table][this._itemId] : null;
  };
  item.setObject = function(value) {
    this._dataClass = ['skill', 'item', 'weapon', 'armor'].find(type => scope.DataManager['is' + type[0].toUpperCase() + type.slice(1)](value)) || '';
    this._itemId = value ? value.id : 0;
  };
  item.setEquip = function(weapon, id) { this._dataClass = weapon ? 'weapon' : 'armor'; this._itemId = id; };
  scope.Game_Item = Game_Item;

  function Game_ActionResult() { this.initialize(); }
  const result = Game_ActionResult.prototype;
  result.initialize = function() { this.clear(); };
  result.clear = function() {
    for (const name of ['used', 'missed', 'evaded', 'physical', 'drain', 'critical', 'success', 'hpAffected']) this[name] = false;
    for (const name of ['hpDamage', 'mpDamage', 'tpDamage']) this[name] = 0;
    for (const name of ['addedStates', 'removedStates', 'addedBuffs', 'addedDebuffs', 'removedBuffs']) this[name] = createArray([]);
  };
  result.addedStateObjects = function() { return this.addedStates.map(id => scope.$dataStates[id]); };
  result.removedStateObjects = function() { return this.removedStates.map(id => scope.$dataStates[id]); };
  result.isStatusAffected = function() { return this.addedStates.length > 0 || this.removedStates.length > 0 || this.addedBuffs.length > 0 || this.addedDebuffs.length > 0 || this.removedBuffs.length > 0; };
  result.isHit = function() { return this.used && !this.missed && !this.evaded; };
  for (const [name, field] of [['StateAdded', 'addedStates'], ['StateRemoved', 'removedStates'], ['BuffAdded', 'addedBuffs'], ['DebuffAdded', 'addedDebuffs'], ['BuffRemoved', 'removedBuffs']])
    result['is' + name] = function(id) { return this[field].includes(id); };
  for (const [name, field] of [['AddedState', 'addedStates'], ['RemovedState', 'removedStates'], ['AddedBuff', 'addedBuffs'], ['AddedDebuff', 'addedDebuffs'], ['RemovedBuff', 'removedBuffs']])
    result['push' + name] = function(id) { if (!this[field].includes(id)) this[field].push(id); };
  scope.Game_ActionResult = Game_ActionResult;
}

module.exports = { installBattleData };
