'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../../../patches/omori/autorun-index.js'), 'utf8');
function fixture({ enabled = true, recognized = true, unreadable = false, modSources = null, plugins = [],
  digest = '84d5cde4540aa73b02d9e60fbaf636d229cc8957f9b9b28c0f00ece295591369' } = {}) {
  function Game_Map() {}
  const original = Game_Map.prototype.setupAutorunCommonEvent = () => 'fallback';
  const switches = new Set(), selected = [], refused = [], hashInputs = [];
  let install;
  const context = { Game_Map, $dataCommonEvents: [null], $plugins: plugins,
    $gameSwitches: { value: id => switches.has(id) },
    __pmjsBuiltinRequire: name => name === 'node:buffer' ? { Buffer } : { createHash: () => ({ update(value) { hashInputs.push(value); return this; }, digest: () => digest }) },
    readGameBytes() { if (unreadable) throw new Error('missing source'); return Buffer.alloc(0); },
    NativeHost: { fs: { readBytes() { throw new Error('raw encrypted reads are unavailable'); } } },
    PMJS: { omori: { modSourceIdentity: () => modSources }, methods: { matchesSource: () => recognized },
      optimizations: { register() {}, isEnabled: () => enabled, refuse(_id, reason) { refused.push(reason); }, reportFallback() {} },
      phases: { on(_phase, _id, callback) { install = callback; } } } };
  vm.runInNewContext(source, context); install();
  const map = new Game_Map(); map._interpreter = { setup(list) { selected.push(list); } };
  return { context, switches, selected, refused, map, original, hashInputs };
}
function event(id, trigger = 1) { return { trigger, switchId: id, list: ['event', id] }; }
test('CEP graphs hash stable plugin identities and the qualified hook sources', () => {
  for (const digest of ['49967111be0f44acf26094e21c3d23bd675a531e42b1b753f3bbaad4ce4b6e47',
    '5957dd220f5c03fae866667f2d804b0ba739a60e2570950777e02c915c7ad9e3']) {
    const { map, original, hashInputs } = fixture({ digest, plugins: [{name:'random',status:true}],
      modSources: {digest:'hooks',pluginNames:{random:'@oneloader/0'},valid:true} });
    assert.notEqual(map.setupAutorunCommonEvent, original);
    assert.ok(hashInputs.includes('@oneloader/0\0'));
    assert.ok(!hashInputs.includes('random\0'));
    assert.ok(hashInputs.includes('\0modloader\0hooks'));
  }
});
test('changed execution hooks return to the original selector before using cached membership', () => {
  const modSources = { digest: 'qualified', pluginNames: {}, valid: true };
  const { map, context, switches } = fixture({ modSources });
  context.$dataCommonEvents = [null, event(1)]; switches.add(1);
  assert.equal(map.setupAutorunCommonEvent(), true);
  modSources.valid = false;
  assert.equal(map.setupAutorunCommonEvent(), 'fallback');
});
test('the qualified original source graph uses decoded game files and preserves autorun selection', () => {
  const { context, switches, selected, map, refused } = fixture({
    digest: '3fa40da1c03a6bc5ec8b5406c20e81de2235bd3700329d98815eda1bf8a4b6bd' });
  const definition = event(5);
  context.$dataCommonEvents = [null, definition]; switches.add(5);
  assert.deepEqual(refused, []);
  assert.equal(map.setupAutorunCommonEvent(), true);
  assert.equal(selected[0], definition.list);
});
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
  for (const options of [{ enabled: false }, { recognized: false }, { digest: 'changed' }, { unreadable: true }]) {
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
