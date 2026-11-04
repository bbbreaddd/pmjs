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
  const tasks = [];
  const context = {
    console, Buffer, __pmjsBuiltinRequire: require,
    PMJS_GAME_CONFIG: {
      ...(catalog === undefined ? {} : { achievements: { catalog } }),
      steam: { provider: 'portable', appId: 42 },
    },
    NativeHost: { storage: {
      readText: name => files.has(name) ? files.get(name) : null,
      readBytes: name => files.has(name) ? Buffer.from(files.get(name)) : null,
      readDirectory: directory => [...new Set([...files.keys()].filter(name => name.startsWith(directory + '/')).map(name => name.slice(directory.length + 1).split('/')[0]))],
      isDirectory: directory => [...files.keys()].some(name => name.startsWith(directory + '/')),
      remove: name => files.delete(name),
      writeText(name, value) { files.set(name, value); writes.push([name, value]); },
      rename(from, to) { files.set(to, files.get(from)); files.delete(from); },
    } },
  };
  context.PMJS = { config: context.PMJS_GAME_CONFIG, tasks: { enqueue(fn) { tasks.push(fn); } } };
  vm.createContext(context);
  vm.runInContext(coreCode, context);
  vm.runInContext(fs.readFileSync(path.join(root, 'js/pmjs-core/steam.js'), 'utf8'), context);
  return { context, files, writes, store: context.pmjsAchievements, drain() { while (tasks.length) tasks.shift()(); } };
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

for (const id of ['__proto__', 'constructor', 'toString']) {
  for (const configured of [false, true]) {
    test(`${configured ? 'cataloged' : 'learned'} ${id} survives updates, reloads and resets`, () => {
      const catalog = configured ? [{ id, progress: { stat: id, target: 10 } }] : [];
      const h = harness({}, catalog);
      h.store.initialize();
      const initialWrites = h.writes.length;
      h.store.setStat(id, 4);
      assert.equal(h.store.getStat(id), 4);
      assert.equal(h.writes.length, initialWrites, 'ordinary stats remain deferred');
      assert.equal(h.store.setUnlocked(id, true), true);
      h.store.setStat('other', 1);
      h.store.flush();
      const saved = JSON.parse(h.files.get('achievements.json'));
      assert.equal(saved.schemaVersion, 1);
      assert.ok(Object.hasOwn(saved.achievements, id));
      assert.ok(Object.hasOwn(saved.stats, id));
      assert.equal(saved.stats[id], 4);
      assert.equal(saved.achievements[id].unlocked, true);

      const reloaded = harness({ 'achievements.json': h.files.get('achievements.json') }, catalog);
      assert.equal(reloaded.store.getStat(id), 4);
      assert.equal(reloaded.store.isUnlocked(id), true);
      assert.ok(Array.from(reloaded.store.names()).includes(id));
      assert.equal(reloaded.store.initialize().achievements[id].unlockedAt,
        saved.achievements[id].unlockedAt);
      assert.equal(reloaded.writes.length, 0, 'valid saved data needs no rewrite');
      reloaded.store.resetStats(true);
      assert.equal(reloaded.store.getStat(id), 0);
      assert.equal(reloaded.store.isUnlocked(id), false);
      reloaded.store.setStat(id, 10);
      assert.equal(reloaded.store.isUnlocked(id), configured);
      reloaded.store.flush();
      const final = harness({ 'achievements.json': reloaded.files.get('achievements.json') }, catalog);
      assert.equal(final.store.getStat(id), 10);
      assert.equal(final.store.isUnlocked(id), configured);
    });
  }

  test(`failed writes do not publish ${id} unlocks or threshold updates`, () => {
    const h = harness({}, [{ id, progress: { stat: id, target: 10 } }]);
    h.store.initialize();
    h.store.setStat(id, 4);
    const writeText = h.context.NativeHost.storage.writeText;
    h.context.NativeHost.storage.writeText = () => { throw new Error('disk full'); };
    assert.throws(() => h.store.setStat(id, 10), /disk full/);
    assert.equal(h.store.getStat(id), 4);
    assert.equal(h.store.isUnlocked(id), false);
    assert.throws(() => h.store.setUnlocked(id, true), /disk full/);
    assert.equal(h.store.isUnlocked(id), false);
    assert.throws(() => h.store.flush(), /disk full/);
    h.context.NativeHost.storage.writeText = writeText;
    assert.equal(h.store.flush(), true, 'failed flush retains dirty state');
    const saved = JSON.parse(h.files.get('achievements.json'));
    assert.equal(saved.stats[id], 4);
    assert.equal(saved.achievements[id].unlocked, false);
  });
}

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
  assert.equal(greenworks.isSteamRunning(), true);
  assert.equal(greenworks.initAPI(), true);
  assert.equal(greenworks.isSteamRunning(), true);
  assert.equal(greenworks.getNumberOfAchievements(), 2);
  let callback = null;
  assert.equal(greenworks.activateAchievement('ONE', value => { callback = value; }), true);
  assert.equal(callback, null);
  h.drain();
  assert.equal(callback, undefined);
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

test('both Steam APIs learn computed IDs without a catalog and restore them before metadata is added', () => {
  function session(initial, catalog) {
    const h = harness(initial, catalog);
    const modules = {};
    h.context.registerCommonJsModule = (names, value) => {
      for (const name of Array.isArray(names) ? names : [names]) modules[name] = value;
    };
    vm.runInContext(greenworksCode, h.context);
    vm.runInContext(steamworksCode, h.context);
    return { ...h, greenworks: modules.greenworks, client: modules['steamworks.js'].init() };
  }
  const h = session();
  assert.deepEqual(Array.from(h.greenworks.getAchievementNames()), []);
  const ids = ['GREEN', 'CLIENT'].map(prefix => prefix + '_' + 17);
  assert.equal(h.client.achievement.isActivated('UNKNOWN'), false);
  assert.equal(h.greenworks.activateAchievement(ids[0]), true);
  assert.equal(h.client.achievement.activate(ids[1]), true);
  // Unlocks must reach storage before callbacks, explicit flush or shutdown.
  const saved = JSON.parse(h.files.get('achievements.json'));
  assert.deepEqual(Object.keys(saved.achievements), ids);
  for (const id of ids) {
    assert.equal(saved.achievements[id].name, id);
    assert.equal(saved.achievements[id].unlocked, true);
    assert.ok(saved.achievements[id].unlockedAt);
  }
  const restarted = session({ 'achievements.json': h.files.get('achievements.json') });
  assert.deepEqual(Array.from(restarted.greenworks.getAchievementNames()), ids);
  for (const id of ids) assert.equal(restarted.client.achievement.isActivated(id), true);
  const enriched = session({ 'achievements.json': restarted.files.get('achievements.json') },
    [{ id: ids[0], name: 'Optional title', description: 'Optional detail' }]);
  const after = JSON.parse(enriched.files.get('achievements.json'));
  assert.equal(after.achievements[ids[0]].name, 'Optional title');
  for (const id of ids) {
    assert.equal(enriched.client.achievement.isActivated(id), true);
    assert.equal(after.achievements[id].unlockedAt, saved.achievements[id].unlockedAt);
  }
});

test('an explicitly disabled provider does not advertise Steam modules', () => {
  const h = harness({}, []);
  h.context.PMJS_GAME_CONFIG.steam = { provider: 'none' };
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

test('OrangeGreenworks keeps original methods and repairs only the storeStats delegation', () => {
  const h = harness(), loaded = new Map();
  const success = () => {}, failure = () => {};
  let receiver, args;
  const original = () => 'original';
  const backend = { storeStats(...values) { receiver = this; args = values; return true; } };
  const plugin = { isSteamRunning: () => true, activateAchievement: original, greenworks: backend,
    _storeStatsSuccess: success, _storeStatsError: failure };
  h.context.Hudell = { OrangeGreenworks: plugin };
  h.context.PMJS.plugins = { onLoaded(name, owner, callback) { loaded.set(name, callback); } };
  h.context.__pmjsBuiltinRequire = require;
  require('./helpers/runtime-context.cjs').runModule(h.context, 'js/pmjs-core/methods.js');
  plugin.storeStats = function fixtureStoreStats() { return 'guest stats'; };
  const digest = require('node:crypto').createHash('sha256').update(plugin.storeStats.toString()).digest('hex');
  vm.runInContext(fs.readFileSync(path.join(root, 'js/pmjs-plugins/greenworks/orange.js'), 'utf8')
    .replace('d45217042bfd56bf2e124ae34da13ea7a153155d86793c69ed6571a81cd35b1a', digest), h.context);
  loaded.get('OrangeGreenworks')();
  assert.equal(plugin.activateAchievement, original);
  assert.equal(plugin.storeStats(), true);
  assert.equal(receiver, backend);
  assert.deepEqual(args, [success, failure]);
  plugin.isSteamRunning = () => false;
  assert.equal(plugin.storeStats(), false);
});

test('explicit Greenworks backend preserves exports, receivers, failures and callbacks', () => {
  const h = harness({}, []);
  h.context.PMJS.config.steam.provider = 'greenworks';
  const failure = new Error('Steam backend failed');
  const backend = {
    running: false,
    isSteamRunning() { return this.running; },
    initAPI() { return false; },
    init() { throw failure; },
    getAchievement(id, callback) { callback(id === 'REAL'); }
  };
  h.context.NativeHost.greenworks = backend;
  const modules = {};
  h.context.registerCommonJsModule = (names, value) => {
    for (const name of names) modules[name] = value;
  };
  vm.runInContext(greenworksCode, h.context);
  const api = modules['./greenworks/greenworks'];
  assert.equal(api, backend);
  assert.equal(modules['./js/libs/greenworks'], backend);
  assert.equal(api.initAPI(), false);
  assert.equal(api.isSteamRunning(), false);
  backend.running = true;
  assert.equal(api.isSteamRunning(), true);
  assert.throws(() => api.init(), error => error === failure);
  let unlocked;
  api.getAchievement('REAL', value => { unlocked = value; });
  assert.equal(unlocked, true);
  assert.equal(h.files.has('achievements.json'), false, 'external backend must not initialize local state');
});

test('explicit Greenworks provider fails when no backend was supplied', () => {
  const h = harness({}, []);
  h.context.PMJS.config.steam.provider = 'greenworks';
  assert.throws(() => vm.runInContext(greenworksCode, h.context), /requires --greenworks-module/);
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
  h.drain();
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
  h.drain();
  assert.equal(failed, true);
  assert.equal(greenworks.getStatInt('retries'), 4);
  h.context.NativeHost.storage.writeText = writeText;
  assert.equal(greenworks.storeStats(), true);
  assert.equal(JSON.parse(h.files.get('achievements.json')).stats.retries, 4);
});

test('portable initialization retries failed persistence and keeps a stable configurable profile', () => {
  const h = harness();
  const original = h.context.NativeHost.storage.writeText;
  h.context.NativeHost.storage.writeText = () => { throw new Error('read only'); };
  assert.throws(() => h.context.pmjsSteam.initialize(), /read only/);
  assert.equal(h.context.pmjsSteam.initialized, false);
  h.context.NativeHost.storage.writeText = original;
  assert.equal(h.context.pmjsSteam.initialize(), true);
  const first = h.context.pmjsSteam.steamId();
  const restarted = harness(Object.fromEntries(h.files));
  const second = restarted.context.pmjsSteam.steamId();
  assert.equal(second.steamId, first.steamId);
  assert.equal(second.getRawSteamID(), first.steamId);
  assert.equal(second.getPersonaName(), first.screenName);
  assert.equal(second.getAccountID(), first.accountId);
  assert.equal(typeof first.staticAccountId, 'number');
  assert.equal(second.getStaticAccountKey(), String(BigInt(first.steamId) & ~(0xfffffn << 32n)));
  assert.equal(second.getSteamLevel(), first.level);
  restarted.context.PMJS.config.steam.screenName = 'Configured';
  assert.equal(restarted.context.pmjsSteam.steamId().getPersonaName(), 'Configured');
});

test('local cloud files persist, enumerate byte sizes, report string quota and respect disable', () => {
  const h = harness();
  const cloud = h.context.pmjsSteam.cloud;
  assert.equal(cloud.enabled(), true);
  cloud.write('slot/one.txt', 'é');
  cloud.write('two.txt', 'abc');
  assert.equal(cloud.read('slot/one.txt'), 'é');
  assert.deepEqual(JSON.parse(JSON.stringify(cloud.files())), [
    { name: 'slot/one.txt', size: 2 }, { name: 'two.txt', size: 3 }
  ]);
  const quota = cloud.quota();
  assert.equal(typeof quota[0], 'string');
  assert.equal(BigInt(quota[0]) - BigInt(quota[1]), 5n);
  const restarted = harness(Object.fromEntries(h.files));
  assert.equal(restarted.context.pmjsSteam.cloud.read('two.txt'), 'abc');
  cloud.remove('two.txt');
  assert.throws(() => cloud.read('two.txt'), { code: 'ENOENT' });
  assert.throws(() => cloud.remove('two.txt'), { code: 'ENOENT' });
  for (const name of ['../escape', '/absolute', 'a/../b', 'a\\..\\b', '']) {
    assert.throws(() => cloud.write(name, 'bad'), /invalid Steam cloud filename/);
  }
  const write = h.context.NativeHost.storage.writeText;
  h.context.NativeHost.storage.writeText = () => { throw new Error('disk full'); };
  assert.throws(() => cloud.enable(false), /disk full/);
  assert.equal(cloud.enabled(), true);
  h.context.NativeHost.storage.writeText = write;
  cloud.enable(false);
  assert.throws(() => cloud.write('disabled', 'bad'), { code: 'ERR_STEAM_UNAVAILABLE' });
  assert.equal(harness(Object.fromEntries(h.files)).context.pmjsSteam.cloud.enabled(), false);
});

test('callback shapes and ordering preserve local returns and complete unavailable services', () => {
  const h = harness();
  let greenworks;
  h.context.registerCommonJsModule = (_names, api) => { greenworks = api; };
  vm.runInContext(greenworksCode, h.context);
  const calls = [];
  assert.equal(greenworks.isSteamRunning(), true);
  greenworks.activateAchievement('A', (...args) => { calls.push(['unlock', ...args]); });
  assert.equal(greenworks.getAchievement('A', (...args) => calls.push(['query', ...args])), true);
  greenworks.saveTextToFile('save.txt', 'saved', (...args) => calls.push(['write', ...args]));
  greenworks.readTextFromFile('save.txt', (...args) => calls.push(['read', ...args]));
  greenworks.getCloudQuota((...args) => calls.push(['quota', ...args]));
  greenworks.getNumberOfPlayers(() => assert.fail('online query succeeded'), error => calls.push(['offline', error.code]));
  assert.deepEqual(calls, []);
  h.drain();
  assert.deepEqual(calls.slice(0, 4), [['unlock'], ['query', true], ['write'], ['read', 'saved']]);
  assert.equal(calls[4].length, 3);
  assert.equal(typeof calls[4][1], 'string');
  assert.deepEqual(calls[5], ['offline', 'ERR_STEAM_UNAVAILABLE']);
  greenworks.indicateAchievementProgress('UNLOCKED_BY_GAME_ONLY', 10, 10);
  assert.equal(greenworks.getAchievement('UNLOCKED_BY_GAME_ONLY'), false);
});

test('steamworks.js profile and cloud queries share the Greenworks backend with native value types', () => {
  const h = harness(), modules = {};
  h.context.registerCommonJsModule = (names, value) => {
    for (const name of Array.isArray(names) ? names : [names]) modules[name] = value;
  };
  vm.runInContext(greenworksCode, h.context); vm.runInContext(steamworksCode, h.context);
  const client = modules['steamworks.js'].init();
  const user = client.localplayer.getSteamId(), green = modules.greenworks.getSteamId();
  assert.equal(user.steamId64, BigInt(green.steamId)); assert.equal(user.accountId, green.accountId);
  assert.equal(typeof user.steamId32, 'string');
  modules.greenworks.saveTextToFile('shared', 'é');
  assert.equal(client.cloud.readFile('shared'), 'é');
  assert.equal(client.cloud.listFiles()[0].size, 2n);
  client.cloud.writeFile('next', 'text'); assert.equal(client.cloud.fileExists('next'), true);
  client.cloud.deleteFile('next'); assert.equal(client.cloud.fileExists('next'), false);
});

test('Steam callbacks use the dispatcher and cannot run after session termination', async () => {
  const h = harness(), modules = {};
  h.context.performance = require('node:perf_hooks').performance;
  h.context.registerCommonJsModule = (names, value) => {
    for (const name of Array.isArray(names) ? names : [names]) modules[name] = value;
  };
  vm.runInContext(fs.readFileSync(path.join(root, 'js/pmjs-web/scheduler.js'), 'utf8'), h.context);
  vm.runInContext(greenworksCode, h.context);
  let calls = 0;
  modules.greenworks.activateAchievement('SAVED', () => { calls++; });
  assert.equal(calls, 0);
  h.context.PMJS.tasks.stop();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 0);
  assert.equal(h.store.isUnlocked('SAVED'), true);
  modules.greenworks.getAchievement('SAVED', () => { calls++; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 0);
});

test('provider defaults enable local emulation and preserve explicit backend choices', () => {
  const code = fs.readFileSync(path.join(root, 'js/pmjs-core/config.js'), 'utf8');
  for (const [provider, backend, expected] of [
    [undefined, null, 'portable'], [undefined, {}, 'greenworks'],
    ['none', {}, 'none'], ['portable', {}, 'portable'], ['greenworks', null, 'greenworks']
  ]) {
    const config = { steam: { appId: 42, ...(provider === undefined ? {} : { provider }) } };
    const context = vm.createContext({ PMJS_GAME_CONFIG: config, NativeHost: { greenworks: backend } });
    vm.runInContext(code, context);
    assert.equal(context.PMJS.config.steam.provider, expected);
    assert.equal(context.PMJS.config.steam.appId, 42);
  }
});

test('session flush persists direct store use without initializing an unused provider', () => {
  const h = harness();
  h.context.pmjsSteam.flush();
  assert.equal(h.files.size, 0);
  assert.equal(h.store.initialized, false);
  h.store.setStat('direct', 9);
  assert.equal(h.context.pmjsSteam.initialized, false);
  h.context.pmjsSteam.flush();
  assert.equal(JSON.parse(h.files.get('achievements.json')).stats.direct, 9);
});

test('OrangeGreenworks preserves an unfamiliar storeStats implementation and reports it', () => {
  const h = harness(), hits = [];
  const original = function customStats() { return 'custom stats'; };
  h.context.Hudell = { OrangeGreenworks: { storeStats: original } };
  h.context.PMJS.compat = { hit(...args) { hits.push(args); } };
  h.context.PMJS.plugins = { onLoaded(name, owner, install) { install(); } };
  h.context.__pmjsBuiltinRequire = require;
  require('./helpers/runtime-context.cjs').runModule(h.context, 'js/pmjs-core/methods.js');
  vm.runInContext(fs.readFileSync(path.join(root, 'js/pmjs-plugins/greenworks/orange.js'), 'utf8'), h.context);
  assert.equal(h.context.Hudell.OrangeGreenworks.storeStats, original);
  assert.equal(original(), 'custom stats');
  assert.deepEqual(hits, [['plugins.orange-greenworks.store-stats', 'unrecognized OrangeGreenworks.storeStats']]);
});
