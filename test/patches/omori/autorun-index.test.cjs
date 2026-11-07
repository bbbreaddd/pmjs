'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../../../patches/omori/autorun-index.js'), 'utf8');
function fixture({ enabled = true, recognized = true, digest = '84d5cde4540aa73b02d9e60fbaf636d229cc8957f9b9b28c0f00ece295591369' } = {}) {
  function Game_Map() {}
  const original = Game_Map.prototype.setupAutorunCommonEvent = () => 'fallback';
  const switches = new Set(), selected = [], refused = [];
  let install;
  const context = { Game_Map, $dataCommonEvents: [null], $plugins: [],
    $gameSwitches: { value: id => switches.has(id) },
    __pmjsBuiltinRequire: name => name === 'node:buffer' ? { Buffer } : { createHash: () => ({ update() { return this; }, digest: () => digest }) },
    NativeHost: { fs: { readBytes: () => Buffer.alloc(0) } },
    PMJS: { methods: { matchesSource: () => recognized },
      optimizations: { register() {}, isEnabled: () => enabled, refuse(_id, reason) { refused.push(reason); } },
      phases: { on(_phase, _id, callback) { install = callback; } } } };
  vm.runInNewContext(source, context); install();
  const map = new Game_Map(); map._interpreter = { setup(list) { selected.push(list); } };
  return { context, switches, selected, refused, map, original };
}
function event(id, trigger = 1) { return { trigger, switchId: id, list: ['event', id] }; }
test('database order, live switches, list references and trigger removal are preserved', () => {
  const { context, switches, selected, map } = fixture();
  const first = event(10), second = event(20);
  context.$dataCommonEvents = [null, first, event(30, 2), second];
  assert.equal(map.setupAutorunCommonEvent(), false);
  switches.add(20); assert.equal(map.setupAutorunCommonEvent(), true); assert.equal(selected.at(-1), second.list);
  switches.add(10); map.setupAutorunCommonEvent(); assert.equal(selected.at(-1), first.list);
  first.list = ['replacement']; first.switchId = 40; switches.add(40);
  map.setupAutorunCommonEvent(); assert.equal(selected.at(-1), first.list);
  first.trigger = 0; map.setupAutorunCommonEvent(); assert.equal(selected.at(-1), second.list);
  switches.clear(); assert.equal(map.setupAutorunCommonEvent(), false);
});
test('database replacement and length changes rebuild membership', () => {
  const { context, switches, selected, map } = fixture();
  context.$dataCommonEvents = [null, event(1, 0)]; assert.equal(map.setupAutorunCommonEvent(), false);
  const replacement = event(2); context.$dataCommonEvents = [null, replacement]; switches.add(2);
  assert.equal(map.setupAutorunCommonEvent(), true); assert.equal(selected.at(-1), replacement.list);
  const appended = event(3); switches.delete(2); switches.add(3); context.$dataCommonEvents.push(appended);
  assert.equal(map.setupAutorunCommonEvent(), true); assert.equal(selected.at(-1), appended.list);
  context.$dataCommonEvents.pop(); assert.equal(map.setupAutorunCommonEvent(), false);
});
test('disabled, unknown methods and unknown sources retain the original method', () => {
  for (const options of [{ enabled: false }, { recognized: false }, { digest: 'changed' }]) {
    const { map, original } = fixture(options); assert.equal(map.setupAutorunCommonEvent, original);
  }
});
test('unsupported database representations delegate and interpreter errors propagate', () => {
  const { context, map, switches } = fixture();
  context.$dataCommonEvents = null; assert.equal(map.setupAutorunCommonEvent(), 'fallback');
  context.$dataCommonEvents = [null, event(1)]; switches.add(1);
  map._interpreter.setup = () => { throw new Error('interpreter failure'); };
  assert.throws(() => map.setupAutorunCommonEvent(), /interpreter failure/);
});
test('unchanged databases do not rescan non-autorun definitions', () => {
  const { context, map } = fixture();
  let reads = 0;
  context.$dataCommonEvents = Array.from({ length: 100 }, (_, index) => ({
    get trigger() { reads++; return index === 50 ? 1 : 0; }, switchId: 1, list: [] }));
  assert.equal(map.setupAutorunCommonEvent(), false);
  reads = 0;
  assert.equal(map.setupAutorunCommonEvent(), false);
  assert.equal(reads, 1);
});
