'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const coreCode = fs.readFileSync(path.join(root, 'js/pmjs-core/achievements.js'), 'utf8');
const greenworksCode = fs.readFileSync(path.join(root, 'js/pmjs-plugins/greenworks/compat.js'), 'utf8');
const steamworksCode = fs.readFileSync(path.join(root, 'js/pmjs-plugins/steamworks/compat.js'), 'utf8');

function harness(initial, catalog) {
  const files = new Map(Object.entries(initial || {}));
  const writes = [];
  const context = {
    console,
    PMJS_GAME_CONFIG: {
      achievements: { catalog: catalog || [] },
      steam: { provider: 'portable', appId: 42 },
    },
    NativeHost: { storage: {
      readText: name => files.has(name) ? files.get(name) : null,
      writeText(name, value) { files.set(name, value); writes.push([name, value]); },
      rename(from, to) { files.set(to, files.get(from)); files.delete(from); },
    } },
  };
  context.PMJS = { config: context.PMJS_GAME_CONFIG };
  vm.createContext(context);
  vm.runInContext(coreCode, context);
  return { context, files, writes, store: context.pmjsAchievements };
}

test('stays inert until initialized, then creates a catalog snapshot', () => {
  const h = harness({}, [{ id: 'FIRST', name: 'First', description: 'Do it.' }]);
  assert.equal(h.files.has('achievements.json'), false);
  h.store.initialize();
  const saved = JSON.parse(h.files.get('achievements.json'));
  assert.equal(saved.schemaVersion, 1);
  assert.deepEqual(Object.keys(saved.achievements), ['FIRST']);
  assert.equal(saved.achievements.FIRST.unlocked, false);
  assert.equal(saved.achievements.FIRST.icon, null);
});

test('persists unlocks, clears, unknown ids, stats, and threshold unlocks immediately', () => {
  let tick = 0;
  const h = harness({}, [{ id: 'TEN', progress: { stat: 'score', target: 10 } }]);
  const store = h.context.createPortableAchievements({
    storage: h.context.NativeHost.storage,
    catalog: [{ id: 'TEN', progress: { stat: 'score', target: 10 } }],
    now: () => `2026-01-01T00:00:0${++tick}.000Z`,
  });
  store.initialize();
  store.setUnlocked('FIRST', true);
  const unlockedAt = JSON.parse(h.files.get('achievements.json')).achievements.FIRST.unlockedAt;
  assert.equal(store.setUnlocked('FIRST', true), false);
  assert.equal(JSON.parse(h.files.get('achievements.json')).achievements.FIRST.unlockedAt, unlockedAt);
  store.setUnlocked('FIRST', false);
  assert.equal(store.isUnlocked('FIRST'), false);
  store.setUnlocked('FIRST', true);
  assert.notEqual(JSON.parse(h.files.get('achievements.json')).achievements.FIRST.unlockedAt, unlockedAt);
  assert.equal(store.isUnlocked('LEARNED'), false);
  assert.equal(JSON.parse(h.files.get('achievements.json')).achievements.LEARNED, undefined);
  store.setStat('score', 10);
  assert.equal(store.getStat('score'), 10);
  assert.equal(store.isUnlocked('TEN'), true);
  store.setStat('score', 0);
  assert.equal(store.isUnlocked('TEN'), true, 'lowering a stat must not relock');
});

test('stages ordinary stats until flush without rewriting on reads', () => {
  const h = harness({}, [{ id: 'KNOWN' }]);
  h.store.initialize();
  const writesAfterInitialization = h.writes.length;
  assert.equal(h.store.isUnlocked('TYPO'), false);
  assert.equal(h.writes.length, writesAfterInitialization);
  assert.equal(h.store.setStat('frames', 1), true);
  assert.equal(h.store.setStat('frames', 2), true);
  assert.equal(h.store.getStat('frames'), 2);
  assert.equal(h.writes.length, writesAfterInitialization);
  assert.equal(h.store.flush(), true);
  assert.equal(JSON.parse(h.files.get('achievements.json')).stats.frames, 2);
  assert.equal(h.store.flush(), false);
});

test('preserves corrupt input and rebuilds a valid file', () => {
  const h = harness({ 'achievements.json': '{bad' }, [{ id: 'RECOVERED' }]);
  h.store.initialize();
  assert.ok(Array.from(h.files.keys())
    .some(name => name.startsWith('achievements.json.corrupt-')));
  assert.ok(JSON.parse(h.files.get('achievements.json')).achievements.RECOVERED);
});

test('Greenworks and steamworks.js adapters share the portable store', () => {
  const h = harness({}, [{ id: 'ONE' }, { id: 'TWO' }]);
  const modules = {};
  h.context.registerCommonJsModule = (names, value) => {
    for (const name of Array.isArray(names) ? names : [names]) modules[name] = value;
  };
  vm.runInContext(greenworksCode, h.context);
  vm.runInContext(steamworksCode, h.context);
  const greenworks = modules.greenworks;
  assert.equal(greenworks.initAPI(), true);
  assert.equal(greenworks.getNumberOfAchievements(), 2);
  let callback = null;
  assert.equal(greenworks.activateAchievement('ONE', value => { callback = value; }), true);
  assert.equal(callback, true);
  const client = modules['steamworks.js'].init();
  assert.equal(client.achievement.isActivated('ONE'), true);
  assert.equal(client.achievement.activate('TWO'), true);
  assert.deepEqual(Array.from(client.achievement.names()), ['ONE', 'TWO']);
  assert.equal(client.stats.setInt('steps', 7), true);
  assert.equal(client.stats.setInt('steps', 7), true, 'an unchanged valid value still succeeds');
  assert.equal(greenworks.getStatInt('steps'), 7);
  assert.equal(client.stats.store(), true);
  assert.equal(JSON.parse(h.files.get('achievements.json')).stats.steps, 7);
});

test('does not advertise Steam modules without explicit portable policy', () => {
  const h = harness({}, []);
  h.context.PMJS_GAME_CONFIG.steam = {};
  const modules = {};
  h.context.registerCommonJsModule = (names, value) => {
    for (const name of Array.isArray(names) ? names : [names]) modules[name] = value;
  };
  vm.runInContext(greenworksCode, h.context);
  vm.runInContext(steamworksCode, h.context);
  assert.equal(modules.greenworks, undefined);
  assert.equal(modules['steamworks.js'], undefined);
  assert.equal(h.files.has('achievements.json'), false);
});

test('a failed write does not publish an in-memory unlock or call success', () => {
  const h = harness({}, [{ id: 'FAIL' }]);
  const modules = {};
  h.context.registerCommonJsModule = (names, value) => {
    for (const name of Array.isArray(names) ? names : [names]) modules[name] = value;
  };
  vm.runInContext(greenworksCode, h.context);
  const greenworks = modules.greenworks;
  assert.equal(greenworks.initAPI(), true);
  h.context.NativeHost.storage.writeText = () => { throw new Error('disk full'); };
  let succeeded = false;
  let failed = false;
  assert.equal(greenworks.activateAchievement('FAIL',
    () => { succeeded = true; }, () => { failed = true; }), false);
  assert.equal(succeeded, false);
  assert.equal(failed, true);
  assert.equal(h.store.isUnlocked('FAIL'), false);
});

test('a failed stat flush stays dirty and can be retried', () => {
  const h = harness({}, []);
  const modules = {};
  h.context.registerCommonJsModule = (names, value) => {
    for (const name of Array.isArray(names) ? names : [names]) modules[name] = value;
  };
  vm.runInContext(greenworksCode, h.context);
  const greenworks = modules.greenworks;
  assert.equal(greenworks.initAPI(), true);
  assert.equal(greenworks.setStat('retries', 4), true);
  const writeText = h.context.NativeHost.storage.writeText;
  h.context.NativeHost.storage.writeText = () => { throw new Error('disk full'); };
  let failed = false;
  assert.equal(greenworks.storeStats(null, () => { failed = true; }), false);
  assert.equal(failed, true);
  assert.equal(greenworks.getStatInt('retries'), 4);
  h.context.NativeHost.storage.writeText = writeText;
  assert.equal(greenworks.storeStats(), true);
  assert.equal(JSON.parse(h.files.get('achievements.json')).stats.retries, 4);
});
