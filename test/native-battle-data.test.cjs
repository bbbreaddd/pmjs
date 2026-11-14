'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { installBattleData } = require('../runner/native-battle-data.cjs');

test('item wrappers preserve database identity and follow replacements and plugin aliases', () => {
  const weapon = { id: 1 }, scope = { $dataWeapons: [null, weapon] };
  scope.DataManager = Object.fromEntries(['Skill', 'Item', 'Weapon', 'Armor'].map(type => ['is' + type, value => type === 'Weapon' && value === weapon]));
  installBattleData(scope, values => Array.from(values));
  const item = new scope.Game_Item(weapon);
  assert.equal(item.isWeapon(), true); assert.equal(item.isEquipItem(), true); assert.equal(item.object(), weapon);
  const replacement = { id: 1, value: 2 }; scope.$dataWeapons[1] = replacement;
  assert.equal(item.object(), replacement);
  const original = scope.Game_Item.prototype.setObject;
  scope.Game_Item.prototype.setObject = function(value) { original.call(this, value); this.changed = true; };
  item.setObject(null); assert.equal(item.isNull(), true); assert.equal(item.changed, true);
  item.setEquip(true, 1); assert.equal(item.object(), replacement);
});

test('action results deduplicate status changes, resolve authored state records and clear for reuse', () => {
  const state = { id: 2 }, scope = { $dataStates: [null, null, state] };
  installBattleData(scope, values => Array.from(values));
  const result = new scope.Game_ActionResult();
  result.used = true; assert.equal(result.isHit(), true); result.evaded = true; assert.equal(result.isHit(), false);
  result.pushAddedState(2); result.pushAddedState(2); result.pushAddedBuff(3);
  assert.deepEqual(result.addedStates, [2]); assert.equal(result.addedStateObjects()[0], state);
  assert.equal(result.isStatusAffected(), true);
  result.clear(); assert.equal(result.isStatusAffected(), false); assert.equal(result.used, false);
});
