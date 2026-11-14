'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { commandList } = require('../runner/native-command-list.cjs');

test('command records and replacements update native data and preserve arbitrary extensions', () => {
  const extension = {}, first = { name: 'Attack', symbol: 'attack', enabled: true, ext: extension };
  let data = [first];
  const list = commandList(() => data.map(value => ({ ...value })), values => { data = values; }, (index, value) => { data[index] = value; }, values => Array.from(values));
  const item = list.view[0]; item.enabled = false; assert.equal(data[0].enabled, false);
  data[0].name = 'Fight'; assert.equal(item.name, 'Fight');
  list.view.push({ name: 'Guard', symbol: 'guard', enabled: true, ext: 3 });
  assert.equal(list.view[0], item); assert.equal(list.view[0].ext, extension);
  list.view.reverse(); assert.equal(list.view[1], item); item.name = 'Fight'; assert.equal(data[1].name, 'Fight');
  list.view.reverse();
  list.assign(list.view.map(command => ({ ...command, name: command.name.toUpperCase() })));
  item.name = 'Detached'; assert.equal(data[0].name, 'FIGHT');
  assert.equal(list.view.pop().name, 'GUARD'); assert.equal(data.length, 1);
  const retained = list.view[0]; list.detach(); data = []; list.view.length = 0;
  retained.enabled = true; assert.equal(data.length, 0);
});
