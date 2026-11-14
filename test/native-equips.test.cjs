'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { installBattleData } = require('../runner/native-battle-data.cjs');
const { installEquipArray } = require('../runner/native-equips.cjs');

test('equipment item fields and array writes share native slots while replaced items detach', () => {
  const weapon = { id: 1 }, armor = { id: 2 };
  const scope = { Game_Actor: function() {}, $dataWeapons: [null, weapon], $dataArmors: [null, null, armor],
    DataManager: { isWeapon: item => item === weapon, isArmor: item => item === armor, isSkill: () => false, isItem: () => false } };
  installBattleData(scope, values => Array.from(values));
  let native = { equips: [1, 2], equipKinds: [1, 2] };
  installEquipArray(scope, (actor, key) => native[key].slice(), (actor, key, value) => { native[key] = value.slice(); }, values => Array.from(values));
  const actor = new scope.Game_Actor(), array = actor._equips, item = array[0], second = array[1];
  assert.equal(item instanceof scope.Game_Item, true); assert.equal(item.object(), weapon);
  item.setObject(armor); assert.deepEqual(native, { equips: [2, 2], equipKinds: [2, 2] });
  native.equips[0] = 1; native.equipKinds[0] = 1; assert.equal(item.object(), weapon);
  array[1] = new scope.Game_Item(weapon);
  assert.equal(array[0], item); assert.equal(array[1].object(), weapon);
  second.setObject(null); assert.equal(native.equips[1], 1);
  array.reverse(); assert.equal(array[1], item); item.setObject(armor); assert.equal(native.equips[1], 2);
  array.unshift(new scope.Game_Item(weapon)); assert.equal(array[2], item);
  array.splice(0, 1); assert.equal(array[1], item);
  actor._equips = []; assert.equal(array.length, 0);
  item.setObject(armor); assert.deepEqual(native.equips, []);
  array.push(new scope.Game_Item(weapon)); assert.equal(actor._equips[0].object(), weapon);
  assert.equal(actor._equips, array);
});
