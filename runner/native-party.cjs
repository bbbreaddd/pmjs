'use strict';

function installPartyBindings(scope, engine, session, createArray) {
  const party = scope.Game_Party.prototype;
  const invoke = (method, ...args) => { const value = engine.gameDataInvoke(session, 'party', method, args); return Array.isArray(value) ? createArray(value) : value; };
  function Game_Unit() { this.initialize(...arguments); }
  Game_Unit.prototype.initialize = function() { this._inBattle = false; };
  Game_Unit.prototype.inBattle = function() { return this._inBattle; };
  Game_Unit.prototype.members = function() { return createArray([]); };
  for (const [method, predicate] of Object.entries({ aliveMembers: 'isAlive', deadMembers: 'isDead', movableMembers: 'canMove' }))
    Game_Unit.prototype[method] = function() { return this.members().filter(member => member[predicate]()); };
  Game_Unit.prototype.agility = function() { const members = this.members(); return members.length ? members.reduce((sum, member) => sum + member.agi, 0) / members.length : 1; };
  Game_Unit.prototype.tgrSum = function() { return this.aliveMembers().reduce((sum, member) => sum + member.tgr, 0); };
  Game_Unit.prototype.isAllDead = function() { return this.aliveMembers().length === 0; };
  Game_Unit.prototype.smoothTarget = function(index) { const member = this.members()[Math.max(index, 0)]; return member && member.isAlive() ? member : this.aliveMembers()[0]; };
  Game_Unit.prototype.smoothDeadTarget = function(index) { const member = this.members()[Math.max(index, 0)]; return member && member.isDead() ? member : this.deadMembers()[0]; };
  Game_Unit.prototype.substituteBattler = function() { return this.members().find(member => member.isSubstitute()); };
  scope.Game_Unit = Game_Unit;
  Object.setPrototypeOf(party, Game_Unit.prototype);
  party.allMembers = function() { return invoke('allMembers').map(id => scope.$gameActors.actor(id)); };
  party.maxBattleMembers = function() { return 4; };
  party.battleMembers = function() { return this.allMembers().slice(0, this.maxBattleMembers()).filter(actor => actor.isAppeared()); };
  party.members = function() { return this.inBattle() ? this.battleMembers() : this.allMembers(); };
  party.leader = function() { return this.battleMembers()[0]; };
  party.size = function() { return this.members().length; };
  party.isEmpty = function() { return this.size() === 0; };
  party.maxGold = function() { return 99999999; };
  party.gainGold = function(amount) { invoke('goldValue', Math.max(0, Math.min(this.maxGold(), this.gold() + amount))); };
  party.loseGold = function(amount) { this.gainGold(-amount); };
  party.steps = function() { return invoke('steps'); };
  party.increaseSteps = function() { invoke('increaseSteps'); };
  for (const method of ['addActor', 'removeActor', 'swapOrder']) party[method] = function(...args) { invoke(method, ...args); };
  party.highestLevel = function() { return Math.max(...this.members().map(actor => actor.level)); };
  party.name = function() { const members = this.battleMembers(); return members.length === 0 ? '' : members.length === 1 ? members[0].name() : scope.TextManager.partyName.replace(/%1/g, members[0].name()); };
  for (const [method, field, table] of [['items', '_items', '$dataItems'], ['weapons', '_weapons', '$dataWeapons'], ['armors', '_armors', '$dataArmors']])
    party[method] = function() { return createArray(Object.keys(this[field])).map(id => scope[table][id]); };
  party.allItems = function() { return this.items().concat(this.weapons(), this.armors()); };
  party.itemContainer = function(item) { return scope.DataManager.isItem(item) ? this._items : scope.DataManager.isWeapon(item) ? this._weapons : scope.DataManager.isArmor(item) ? this._armors : null; };
  party.numItems = function(item) { const container = this.itemContainer(item); return container ? container[item.id] || 0 : 0; };
  party.maxItems = function() { return 99; };
  party.hasMaxItems = function(item) { return this.numItems(item) >= this.maxItems(item); };
  party.isAnyMemberEquipped = function(item) { return this.members().some(actor => actor.equips().includes(item)); };
  party.hasItem = function(item, includeEquip) { return this.numItems(item) > 0 || !!(includeEquip && this.isAnyMemberEquipped(item)); };
  party.discardMembersEquip = function(item, amount) {
    for (const actor of this.members()) while (amount > 0 && actor.isEquipped(item)) { actor.discardEquip(item); --amount; }
  };
  party.gainItem = function(item, amount, includeEquip) {
    const container = this.itemContainer(item);
    if (!container) return;
    const count = this.numItems(item) + amount;
    container[item.id] = Math.max(0, Math.min(this.maxItems(item), count));
    if (!container[item.id]) delete container[item.id];
    if (includeEquip && count < 0) this.discardMembersEquip(item, -count);
    scope.$gameMap.requestRefresh();
  };
  party.loseItem = function(item, amount, includeEquip) { this.gainItem(item, -amount, includeEquip); };
  party.consumeItem = function(item) { if (scope.DataManager.isItem(item) && item.consumable) this.loseItem(item, 1); };
  party.canUse = function(item) { return this.members().some(actor => actor.canUse(item)); };
  for (const [field, method] of [['menuActorId', 'MenuActor'], ['targetActorId', 'TargetActor']]) {
    party['set' + method] = function(actor) { invoke(field, actor.actorId()); };
    party[method[0].toLowerCase() + method.slice(1)] = function() {
      const actor = scope.$gameActors.actor(invoke(field));
      return this.members().includes(actor) ? actor : this.members()[0];
    };
  }
  party.isAllDead = function() { return Game_Unit.prototype.isAllDead.call(this) && (this.inBattle() || !this.isEmpty()); };
}

module.exports = { installPartyBindings };
