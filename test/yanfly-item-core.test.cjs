'use strict';
const assert = require('node:assert/strict');
const vm = require('node:vm');
const test = require('node:test');
const fixture = require('./helpers/plugin-source-fixture.cjs');
function setup(files, options = {}) {
  return fixture('js/pmjs-plugins/yanfly/item-core.js', 'YEP_ItemCore', files,
    { hash: '26a6f756bad0d7f606a3ec3251b6dea986e415c19dda6677a048ac7790df340e', ...options });
}
const itemRemoval = `
  var searches = 0, removed = [], inventory = [], equipment = [];
  var $gameParty = {
    getMatchingBaseItem(item, includeEquip) {
      searches++;
      return inventory.concat(includeEquip ? equipment : [])
        .find(copy => copy.base === item.id) || null;
    }
  };
  var party = {
    removeIndependentItem(copy, includeEquip) {
      removed.push(copy.id);
      inventory = inventory.filter(entry => entry !== copy);
      if (includeEquip) equipment = equipment.filter(entry => entry !== copy);
    },
    discard(item, amount, includeEquip) {
      for (var i = 0; i < amount; i++) {
          var target = $gameParty.getMatchingBaseItem(item, includeEquip);
          if (target !== null) this.removeIndependentItem(target, includeEquip);
      }
      return [];
    }
  };
`;

test('exhausted item removals preserve inventory, equipment and removal order', () => {
  const file = 'js/plugins/YEP_ItemCore.js';
  for (const includeEquip of [false, true]) {
    for (const amount of [0, 1, 2, 99]) {
      const host = setup({ [file]: itemRemoval });
      const control = vm.createContext({});
      vm.runInContext(itemRemoval, control);
      host.load(file);
      const run = `inventory = [{id:101,base:12},{id:102,base:13}];
        equipment = [{id:103,base:12},{id:104,base:13}];
        var result = party.discard({id:12}, ${amount}, ${includeEquip});
        JSON.stringify({inventory,equipment,removed,result});`;
      assert.equal(vm.runInContext(run, host.context), vm.runInContext(run, control));
      if (amount === 99) assert.equal(host.context.searches, includeEquip ? 3 : 2);
      assert.equal(control.searches, amount);
    }
  }
});

test('empty item searches stop once and preserve exceptions from real removals', () => {
  const file = 'js/plugins/YEP_ItemCore.js';
  const host = setup({ [file]: itemRemoval });
  host.load(file);
  vm.runInContext('party.discard({id:12},99,true)', host.context);
  assert.equal(host.context.searches, 1);
  vm.runInContext(`inventory = [{id:101,base:12}];
    party.removeIndependentItem = function() { throw Error('unequip failure'); };`, host.context);
  assert.throws(() => vm.runInContext('party.discard({id:12},99,true)', host.context), /unequip failure/);
});

test('item removal patch accepts line endings, stays idempotent and refuses unknown sites', () => {
  const file = 'js/plugins/YEP_ItemCore.js';
  for (const source of [itemRemoval, itemRemoval.replace(/\n/g, '\r\n')]) {
    const files = { [file]: source }, host = setup(files);
    const patched = host.source(file);
    assert.notEqual(patched, source);
    assert.equal(files[file], source);
    files[file] = patched;
    assert.equal(host.source(file), patched);
  }
  for (const source of [itemRemoval.replace('target !== null', 'target != null'), itemRemoval + itemRemoval]) {
    const host = setup({ [file]: source });
    assert.equal(host.source(file), source);
    assert.equal(host.delegated, true);
  }
});


test('unknown or disabled item plugins retain the original source', () => {
  const file = 'js/plugins/YEP_ItemCore.js';
  for (const options of [{ reviewed: false }, { enabled: false }]) {
    const host = setup({ [file]: itemRemoval }, options);
    assert.equal(host.source(file), itemRemoval);
    assert.equal(host.delegated, true);
  }
});

test('reviewed plugin source qualifies without substituted fingerprints', { skip: !process.env.PMJS_ISAT_REFERENCE_GAME }, () => {
  const file = 'js/plugins/YEP_ItemCore.js';
  const input = require('node:fs').readFileSync(require('node:path').join(process.env.PMJS_ISAT_REFERENCE_GAME, file), 'utf8');
  const host = setup({ [file]: input }, { hash: undefined });
  const output = host.source(file);
  assert.notEqual(output, input);
  assert.equal(host.delegated, false);
  assert.doesNotThrow(() => new vm.Script(output));
});
