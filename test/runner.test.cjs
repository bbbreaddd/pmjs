'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { parse } = require('../runner/cli.cjs');
const { run, createPreparationLog, validate, resolveDefaults, parseTimingConfig, resolveSwapDefault, advanceDeadline,
  sendSupervisorHeartbeat } = require('../runner/index.cjs');
const { temporaryDirectory } = require('./helpers/temp.cjs');

test('importing the runner preserves the embedding process code-cache compatibility', () => {
  const runner = JSON.stringify(path.resolve(__dirname, '../runner/index.cjs'));
  childProcess.execFileSync(require('node:process').execPath, ['-e', `
    const assert = require('node:assert/strict');
    const v8 = require('node:v8');
    const before = v8.cachedDataVersionTag();
    require(${runner});
    assert.equal(v8.cachedDataVersionTag(), before);
  `]);
});

function fixture(source) {
  const root = temporaryDirectory('pmjs-runner-');
  const bootstrap = path.join(root, 'bootstrap.js');
  fs.writeFileSync(bootstrap, source);
  const addon = writeAddon(root);
  return { addon, gameRoot: root, bootstrap,
    saveRoot: path.join(root, 'save'), width: 320, height: 240, title: 'Test' };
}
function native(polls = [true, false]) {
  let now = 0, guestInput = false;
  const locks = new Map();
  return { initialize() {}, pollEvents: () => !guestInput || (polls.shift() ?? false),
    finishLogicStep() {}, beginFrame() {}, renderFrame() {}, swapFrame() {},
    runtime: { env() { return ''; }, monotonicNow: () => (now += 100), quit() {} },
    fs: { mountWritableOverlay() {}, updateWritableOverlay() {}, readText() { return null; } },
    render: {}, scene: {}, images: {}, assets: {
      preparationWorkspaceVersion: 1, preparationLz4Version: 'fixture-lz4-v1',
      tryAcquirePreparationLock(root) {
        if (locks.has(root)) return null;
        const token = { root };
        locks.set(root, token);
        return token;
      },
      releasePreparationLock(token) { if (locks.get(token.root) === token) locks.delete(token.root); }
    },
    input: { snapshot() { guestInput = true; return {}; }, consumePressed() {} }, canvas: {}, media: {} };
}

test('supervisor heartbeat uses its captured Node process, not the guest process replacement', () => {
  const sent = [];
  const nodeProcess = { connected: true, send(message, callback) { sent.push(message); callback(); } };
  const previousProcess = globalThis.process;
  globalThis.process = { connected: false, send() { assert.fail('guest process must not receive supervisor IPC'); } };
  try {
    assert.equal(sendSupervisorHeartbeat(nodeProcess, { mapId: 3 }), true);
  } finally {
    globalThis.process = previousProcess;
  }
  assert.deepEqual(sent, [{ type: 'pmjs-heartbeat', heartbeat: { mapId: 3 } }]);
});

function writeAddon(root, polls = [true, false]) {
  const addon = path.join(root, 'addon.cjs');
  fs.writeFileSync(addon, `module.exports = (${native.toString()})(${JSON.stringify(polls)});`);
  return addon;
}

test('saved frame limit reaches the guest timing configuration at boot', async () => {
  const options = fixture(`
    if (__pmjsTimingConfig.renderHz !== 30) throw new Error('saved limit not applied');
    globalThis.__pmjsTick = () => {};
    globalThis.__pmjsRender = () => {};
  `);
  options.assetPreparation = 'off'; options.mapPreparation = 'off';
  fs.mkdirSync(path.join(options.saveRoot, 'runtime-settings'), { recursive: true });
  fs.writeFileSync(path.join(options.saveRoot, 'runtime-settings/settings.json'),
    JSON.stringify({ scale: 'default', frameRate: 30 }));
  await run(options);
});

test('settings captures controller input while game frames continue', async () => {
  const clock = require('node:perf_hooks').performance;
  const oldNow = Object.getOwnPropertyDescriptor(clock, 'now');
  let now = 0, polls = 0;
  Object.defineProperty(clock, 'now', { configurable: true, value: () => now });
  const options = fixture(`
    globalThis.__settingsInputs = [];
    globalThis.__settingsRates = [];
    globalThis.__settingsTicks = 0;
    globalThis.__pmjsReceiveInput = value => __settingsInputs.push(value);
    globalThis.__pmjsTick = () => { __settingsTicks++; __settingsRates.push(__pmjsTimingConfig.renderHz); };
    globalThis.__pmjsRender = () => {};
  `);
  options.assetPreparation = 'off'; options.mapPreparation = 'off';
  const host = require(options.addon);
  host.pollEvents = () => ++polls <= 12;
  let snapshots = 0;
  host.input.snapshot = () => {
    now += 1000;
    snapshots++;
    const pressed = snapshots === 8 ? [13] : snapshots === 9 ? [15] : [];
    return { gamepads: [{ connected: true, index: 0, instance: 7,
      buttonsDown: [16, 0], buttonsPressed: pressed, axes: [0.5, 0] }] };
  };
  let shown = 0;
  host.runtime.settingsOverlay = () => ({ hasFont: true });
  host.runtime.settingsPresent = visible => { if (visible) shown++; };
  try {
    await run(options);
    assert(shown > 0);
    assert.equal(globalThis.__settingsTicks, globalThis.__settingsInputs.length);
    assert(globalThis.__settingsInputs.some(input => input.gamepads[0].buttonsDown.length === 0));
    assert(globalThis.__settingsTicks >= 7);
    assert(globalThis.__settingsRates.includes(30));
  } finally {
    if (oldNow) Object.defineProperty(clock, 'now', oldNow);
    else delete clock.now;
    delete globalThis.__settingsInputs;
    delete globalThis.__settingsTicks;
    delete globalThis.__settingsRates;
    delete globalThis.__pmjsReceiveInput;
  }
});

test('preparation logs bounded heartbeats, current work and phase durations with a monotonic clock', () => {
  let clock = 0;
  const lines = [];
  const reporter = createPreparationLog({ stage: 'images', codec: 'lz4', cacheRoot: '/cache', verifyHashes: false },
    { now: () => clock, log: line => lines.push(line) });
  reporter.progress({ phase: 'validate', completed: 0, total: 2 });
  clock = 2000;
  reporter.progress({ phase: 'prepare', source: 'img/a\n.png', completed: 0, total: 2 });
  clock = 9999; reporter.heartbeat();
  assert.equal(lines.some(line => line.includes('event=progress')), false);
  clock = 10000; reporter.heartbeat();
  const heartbeat = lines.at(-1);
  assert.match(heartbeat, /phase=prepare elapsed_ms=10000.0 phase_elapsed_ms=8000.0 no_progress_ms=8000.0/);
  assert.ok(heartbeat.includes('source="img/a\\n.png"'));
  reporter.heartbeat();
  assert.equal(lines.filter(line => line.includes('event=progress')).length, 1);
  clock = 12000;
  reporter.finish({ generated: 2, installed: 2, validation: { hashedFiles: 2, hashedBytes: 400 } });
  assert.match(lines.at(-1), /status=complete cache=cold duration_ms=12000.0/);
  assert.match(lines.at(-1), /hashed_files=2 hashed_bytes=400/);
  assert.match(lines.at(-1), /phase_ms=\{"start":0,"validate":2000,"prepare":10000\}/);
  const count = lines.length;
  clock = 30000; reporter.heartbeat(); reporter.finish({});
  assert.equal(lines.length, count);
});

test('preparation summaries distinguish cache reuse, partial generation, failure and cancellation', () => {
  for (const [result, expected] of [
    [{ generated: 0, hits: 20 }, 'status=complete cache=warm'],
    [{ generated: 1, hits: 20 }, 'status=complete cache=mixed'],
    [{ generated: 1, indexedNegative: 20 }, 'status=complete cache=mixed'],
    [{ generated: 0 }, 'status=complete cache=empty'],
    [{ generated: 0, hits: 20, cancelled: true }, 'status=cancelled cache=incomplete'],
    [{ generated: 0, cancelled: true, error: 'map preparation cancelled' }, 'status=cancelled cache=incomplete'],
    [{ generated: 0, hits: 20, failedFiles: 1 }, 'status=partial cache=incomplete'],
    [{ generated: 1, prepared: 2, installed: 1 }, 'status=partial cache=incomplete'],
    [{ generated: 1, installFailures: 1 }, 'status=partial cache=incomplete'],
    [{ generated: 0, hits: 20, error: 'disk failed' }, 'status=failed cache=incomplete']
  ]) {
    const lines = [];
    const reporter = createPreparationLog({ stage: 'images', codec: 'lz4', cacheRoot: '/cache', verifyHashes: false },
      { now: () => 0, log: line => lines.push(line) });
    reporter.finish(result);
    assert.ok(lines.at(-1).includes(expected), lines.at(-1));
  }
});

test('runner logs cold and validated warm preparation before boot and includes total startup time', async t => {
  const options = fixture('NativeHost.input.checkBoot(); globalThis.__pmjsTick=()=>{}; globalThis.__pmjsRender=()=>{};');
  options.mapPreparation = 'off';
  fs.mkdirSync(path.join(options.gameRoot, 'img/pictures'), { recursive: true });
  fs.writeFileSync(path.join(options.gameRoot, 'img/pictures/test.png'),
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==', 'base64'));
  const host = require(options.addon);
  host.assets.processImage = async () => null;
  host.assets.installPrepared = () => 0;
  const lines = [];
  t.mock.method(console, 'log', line => lines.push(line));
  t.mock.method(console, 'warn', () => {});
  let booted = false;
  host.input.checkBoot = () => { booted = true; };
  host.pollEvents = () => !booted;
  for (const cache of ['cold', 'warm']) {
    booted = false;
    await run(options);
    const summary = lines.findIndex(line => line.includes('event=finish status=complete cache='+cache));
    const ready = lines.findIndex(line => line.includes('[pmjs] ready'));
    assert.ok(summary >= 0 && ready > summary, lines.join('\n'));
    assert.match(lines[ready], /startup_ms=\d+\.\d/);
    assert.ok(lines.some(line => /preparation event=finish status=complete duration_ms=\d+\.\d/.test(line)));
    lines.length = 0;
  }
  options.mapPreparation = 'on';
  fs.mkdirSync(path.join(options.gameRoot, 'data'), { recursive: true });
  fs.writeFileSync(path.join(options.gameRoot, 'data/Map001.json'), '{}');
  booted = false;
  await run(options);
  const imageFinish = lines.findIndex(line => line.includes('stage=images event=finish'));
  const mapStart = lines.findIndex(line => line.includes('stage=maps event=start'));
  assert.ok(imageFinish >= 0 && imageFinish < mapStart);
  assert.ok(lines.some(line => line.includes('stage=maps event=finish status=failed cache=incomplete')));
  assert.ok(lines.some(line => line.includes('preparation event=finish status=failed')));
});

test('normal shutdown waits for pending preparation invalidation persistence', async t => {
  const options = fixture('globalThis.__pmjsTick=()=>{}; globalThis.__pmjsRender=()=>{};');
  options.assetCacheRoot = path.join(options.gameRoot, 'cache');
  fs.mkdirSync(path.join(options.gameRoot, 'img/pictures'), { recursive: true });
  fs.writeFileSync(path.join(options.gameRoot, 'img/pictures/test.png'),
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==', 'base64'));
  const host = require(options.addon);
  host.assets.processImage = () => null;
  host.assets.installPrepared = () => 0;
  let reported = false, failuresConsumed = false;
  host.assets.consumePreparationInvalidations = () => reported ? 0 : (reported = true, 1);
  host.assets.consumePreparationFailures = () => (failuresConsumed = true, ['img/pictures/test.png']);
  let signalStarted;
  const started = new Promise(resolve => { signalStarted = resolve; });
  let releaseWrite;
  const writeGate = new Promise(resolve => { releaseWrite = resolve; });
  const rename = fs.promises.rename;
  t.mock.method(fs.promises, 'rename', async (from, to) => {
    if (failuresConsumed && path.basename(path.dirname(String(to))) === 'invalidations') {
      failuresConsumed = false;
      signalStarted();
      await writeGate;
    }
    return rename(from, to);
  });
  const lines = [];
  t.mock.method(console, 'log', line => lines.push(line));
  t.mock.method(console, 'warn', () => {});
  const running = run(options);
  await started;
  let finished = false;
  running.then(() => { finished = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false);
  releaseWrite();
  await running;
  assert.equal(finished, true);
});

test('unnamed native invalidations discard the startup catalog before shutdown', async t => {
  const options = fixture('NativeHost.input.checkBoot(); globalThis.__pmjsTick=()=>{}; globalThis.__pmjsRender=()=>{};');
  options.mapPreparation = 'off';
  const host = require(options.addon);
  host.assets.processImage = async () => null;
  host.assets.installPrepared = () => 0;
  host.assets.installPreparedCatalog = () => 0;
  host.assets.installDerivedCatalog = () => {};
  let booted = false, report = false;
  host.input.checkBoot = () => { booted = true; };
  host.pollEvents = () => !booted;
  host.assets.consumePreparationInvalidations = () => report ? (report = false, 3) : 0;
  host.assets.consumePreparationFailures = () => [];
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  await run(options);
  const root = path.join(options.saveRoot, 'asset-cache/preparation-v1');
  const catalog = path.join(root, fs.readdirSync(root)[0], 'startup-catalog.json');
  assert.equal(fs.existsSync(catalog), true);
  booted = false; report = true;
  await run(options);
  assert.equal(fs.existsSync(catalog), false);
});

test('CLI parses the documented options including --config', () => {
  const value = parse(['--addon','a','--game-root','g','--bootstrap','b','--save-root','s',
    '--config','my-config.json','--width','640','--height','480','--image-warm-cache-bytes','1024',
    '--prepared-frame-cache-bytes','2097152',
    '--greenworks-module','steam/greenworks.js']);
  assert.equal(value.width, 640); assert.equal(value.height, 480);
  assert.equal(value.config, 'my-config.json');
  assert.equal(value.imageWarmCacheBytes, 1024);
  assert.equal(value.preparedFrameCacheBytes, 2097152);
  assert.equal(value.greenworksModule, 'steam/greenworks.js');
});
test('prepared frame cache validates its budget and resolves configuration and environment', () => {
  const options = fixture('');
  const previous = process.env.PMJS_PREPARED_FRAME_CACHE_BYTES;
  try {
    delete process.env.PMJS_PREPARED_FRAME_CACHE_BYTES;
    assert.equal(validate(options).preparedFrameCacheBytes, 33554432);
    for (const budget of [-1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1,
      'invalid', null, true, {}]) {
      assert.throws(() => validate({ ...options, preparedFrameCacheBytes: budget }),
        /preparedFrameCacheBytes must be a non-negative safe integer/);
    }
    process.env.PMJS_PREPARED_FRAME_CACHE_BYTES = '2097152';
    assert.equal(validate(options).preparedFrameCacheBytes, 2097152);
    assert.equal(validate({ ...options, preparedFrameCacheBytes: 0 }).preparedFrameCacheBytes, 0);
    const config = path.join(options.gameRoot, 'config.json');
    fs.writeFileSync(config, JSON.stringify({ preparedFrameCacheBytes: 4194304 }));
    assert.equal(validate({ ...options, config }).preparedFrameCacheBytes, 4194304);
    assert.equal(validate({ ...options, config, preparedFrameCacheBytes: 0 }).preparedFrameCacheBytes, 0);
    process.env.PMJS_PREPARED_FRAME_CACHE_BYTES = '-1';
    assert.throws(() => validate(options), /preparedFrameCacheBytes/);
  } finally {
    if (previous === undefined) delete process.env.PMJS_PREPARED_FRAME_CACHE_BYTES;
    else process.env.PMJS_PREPARED_FRAME_CACHE_BYTES = previous;
  }
});
test('runner forwards the prepared frame cache budget to native initialization', async () => {
  const options = fixture('globalThis.__pmjsTick=()=>{}; globalThis.__pmjsRender=()=>{};');
  options.assetPreparation = 'off';
  options.preparedFrameCacheBytes = 2097152;
  const host = require(options.addon);
  let initialized;
  host.initialize = value => { initialized = value; };
  await run(options);
  assert.equal(initialized.preparedFrameCacheBytes, 2097152);
  delete options.preparedFrameCacheBytes;
  await run(options);
  assert.equal(initialized.preparedFrameCacheBytes, 33554432);
});
test('prepared rendering controls are independent and enabled by default', async () => {
  const options = fixture('globalThis.__pmjsTick=()=>{}; globalThis.__pmjsRender=()=>{};');
  options.assetPreparation = 'off';
  for (const name of ['preparedCompactSampling', 'preparedCropUploads']) {
    assert.equal(validate(options)[name], true);
    for (const value of [null, 0, 'false']) {
      assert.throws(() => validate({ ...options, [name]: value }), /must be a boolean/);
    }
  }
  const config = path.join(options.gameRoot, 'render-config.json');
  fs.writeFileSync(config, JSON.stringify({ preparedCompactSampling: false, preparedCropUploads: true }));
  assert.equal(validate({ ...options, config }).preparedCompactSampling, false);
  assert.equal(validate({ ...options, config, preparedCompactSampling: true }).preparedCompactSampling, true);
  const host = require(options.addon);
  let initialized;
  host.initialize = value => { initialized = value; };
  await run({ ...options, preparedCompactSampling: false, preparedCropUploads: true });
  assert.equal(initialized.preparedCompactSampling, false);
  assert.equal(initialized.preparedCropUploads, true);
  await run({ ...options, preparedCompactSampling: true, preparedCropUploads: false });
  assert.equal(initialized.preparedCompactSampling, true);
  assert.equal(initialized.preparedCropUploads, false);
});
test('validation rejects missing paths and invalid dimensions', () => {
  assert.throws(() => validate({}), /addon is required/);
  assert.throws(() => validate({ addon:'a', gameRoot:'g', bootstrap:'b', saveRoot:'s', width:0, height:1 }), /width/);
  assert.throws(() => validate({ addon:'a', gameRoot:'g', bootstrap:'b', saveRoot:'s', width:1, height:1,
    imageWarmCacheBytes: -1 }), /imageWarmCacheBytes/);
  assert.equal(Object.hasOwn(validate({ addon:'a', gameRoot:'g', bootstrap:'b', saveRoot:'s',
    width:1, height:1 }), 'imageWarmCacheBytes'), false);
  assert.equal(validate({ addon:'a', gameRoot:'g', bootstrap:'b', saveRoot:'s', width:1, height:1,
    imageWarmCacheBytes: 0 }).imageWarmCacheBytes, 0);
});
test('validation auto-detects title and dimensions from config or package.json', () => {
  const tempDir = temporaryDirectory('pmjs-runner-config-');
  const configJson = path.join(tempDir, 'config.json');
  fs.writeFileSync(configJson, JSON.stringify({
    title: 'JSON Title',
    display: { width: 1280, height: 720 }
  }));
  const v1 = validate({ addon: 'a', gameRoot: tempDir, bootstrap: 'b', saveRoot: 's', config: configJson });
  assert.equal(v1.title, 'JSON Title');
  assert.equal(v1.width, 1280);
  assert.equal(v1.height, 720);

  const pkgDir = temporaryDirectory('pmjs-runner-pkg-');
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({
    name: 'Package Name',
    window: { title: 'Package Window Title', width: 960, height: 540 }
  }));
  const v2 = validate({ addon: 'a', gameRoot: pkgDir, bootstrap: 'b', saveRoot: 's' });
  assert.equal(v2.title, 'Package Window Title');
  assert.equal(v2.width, 960);
  assert.equal(v2.height, 540);

  const emptyDir = temporaryDirectory('pmjs-runner-empty-');
  const v3 = validate({ addon: 'a', gameRoot: emptyDir, bootstrap: 'b', saveRoot: 's' });
  assert.equal(v3.title, 'PMJS');
  assert.equal(v3.width, 816);
  assert.equal(v3.height, 624);

  const sysDir = temporaryDirectory('pmjs-runner-sys-');
  fs.mkdirSync(path.join(sysDir, 'data'));
  fs.writeFileSync(path.join(sysDir, 'data', 'System.json'), JSON.stringify({
    gameTitle: 'System Game Title'
  }));
  fs.writeFileSync(path.join(sysDir, 'package.json'), JSON.stringify({
    name: 'Package Name',
    window: { title: 'Package Window Title', width: 960, height: 720 }
  }));
  const v4 = validate({ addon: 'a', gameRoot: sysDir, bootstrap: 'b', saveRoot: 's' });
  assert.equal(v4.title, 'System Game Title');
  assert.equal(v4.width, 960);
  assert.equal(v4.height, 720);

  const pkgNameDir = temporaryDirectory('pmjs-runner-pkgname-');
  fs.writeFileSync(path.join(pkgNameDir, 'package.json'), JSON.stringify({
    name: 'Only Package Name'
  }));
  const v5 = validate({ addon: 'a', gameRoot: pkgNameDir, bootstrap: 'b', saveRoot: 's' });
  assert.equal(v5.title, 'Only Package Name');
});

test('validation rejects missing or malformed explicit config', () => {
  assert.throws(() => validate({
    addon: 'a', gameRoot: 'g', bootstrap: 'b', saveRoot: 's',
    config: '/nonexistent-config-file.json'
  }), /config file not found/);

  const tempDir = temporaryDirectory('pmjs-runner-bad-');
  const badJson = path.join(tempDir, 'bad.json');
  fs.writeFileSync(badJson, '{ bad json');
  assert.throws(() => validate({
    addon: 'a', gameRoot: tempDir, bootstrap: 'b', saveRoot: 's',
    config: badJson
  }), /invalid JSON in config file/);

  const badJs = path.join(tempDir, 'bad.js');
  fs.writeFileSync(badJs, 'throw new Error("bad config eval");');
  assert.throws(() => validate({
    addon: 'a', gameRoot: tempDir, bootstrap: 'b', saveRoot: 's',
    config: badJs
  }), /invalid JSON in config file/);
});
test('validation rejects malformed disableOptimizations but keeps well-formed configuration', () => {
  const tempDir = temporaryDirectory('pmjs-runner-opt-');
  const bad = path.join(tempDir, 'bad.json');
  fs.writeFileSync(bad, JSON.stringify({ disableOptimizations: ['terrax.native-lighting', 7] }));
  assert.throws(() => validate({
    addon: 'a', gameRoot: 'g', bootstrap: 'b', saveRoot: 's', config: bad,
  }), /disableOptimizations/);

  const good = path.join(tempDir, 'good.json');
  fs.writeFileSync(good, JSON.stringify({ disableOptimizations: ['terrax.native-lighting'] }));
  const value = validate({
    addon: 'a', gameRoot: 'g', bootstrap: 'b', saveRoot: 's', config: good,
  });
  assert.equal(value.title, 'PMJS');
});

test('unknown configuration optimization IDs fail the run at startup', async () => {
  const tempDir = temporaryDirectory('pmjs-runner-unknown-opt-');
  const config = path.join(tempDir, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ disableOptimizations: ['terrax.nativeLight'] }));
  const modules = [
    'js/pmjs-core/config.js',
    'js/pmjs-core/optimizations.js',
    'js/pmjs-core/methods.js',
    'js/pmjs-rpgmaker/lifecycle.js',
    'js/pmjs-rpgmaker/plugins.js',
      'js/pmjs-rpgmaker/bootstrap.js',
      'js/pmjs-core/intl-warmup.js',
    'js/pmjs-mv/plugin-loader.js',
  ];
  const bootstrap = path.join(tempDir, 'bootstrap.js');
  fs.writeFileSync(bootstrap,
    `globalThis.PMJS_GAME_CONFIG = ${fs.readFileSync(config, 'utf8')};\n` +
    modules.map(module => fs.readFileSync(path.join(__dirname, '..', module), 'utf8'))
      .join('\n'));
  // Standard boot initializes plugins, runs the last registration seam
  // (beforeBoot), then finalizes before game boot; finalization rejects
  // the requested-but-unregistered ID. Mirrors bootstrap.js ordering.
  fs.appendFileSync(bootstrap,
    '\npmjsMvInitializePlugins();\nPMJS.phases.emit(\'beforeBoot\');\nPMJS.optimizations.finalize();\n');
  const options = { addon: path.join(tempDir, 'addon.node'), gameRoot: tempDir,
    bootstrap, saveRoot: path.join(tempDir, 'save'), width: 320, height: 240,
    title: 'Test', config };
  options.addon = writeAddon(tempDir);
  require(options.addon).pollEvents = () => true;
  await assert.rejects(run(options), /Unknown PMJS optimization: terrax\.nativeLight/);
});
test('runner loads its addon and bootstrap while allowing Node jobs to finish', async () => {
  const options = fixture('globalThis.__pmjsTick=()=>{};globalThis.__pmjsRender=()=>{};');
  const job = new Promise(resolve => setImmediate(resolve));
  await run(options);
  await job;
  assert.deepEqual(globalThis.NativeHost.runtime.platform(),
    { platform: process.platform, arch: process.arch });
  assert.deepEqual(globalThis.__pmjsGameInfo,
    { title: 'Test', width: 320, height: 240, displayWidth: 640, displayHeight: 480 });
  assert.equal(globalThis.NativeHost.render.setLogicalSize, undefined);
});

for (const preparation of ['off', 'enabled', 'warm']) {
  for (const held of [false, true]) {
    test(`guest handoff discards startup input with preparation ${preparation} and controls ${held ? 'held' : 'released'}`, async () => {
      const options = fixture(`
        NativeHost.input.checkBoot();
        globalThis.__pmjsTick=()=>{}; globalThis.__pmjsRender=()=>{};
      `);
      options.assetPreparation = preparation === 'off' ? 'off' : 'on';
      options.mapPreparation = 'off';
      const host = require(options.addon);
      const calls = [];
      let booted, state, boots = 0;
      host.initialize = () => { booted = false; };
      host.pollEvents = () => {
        if (booted) return false;
        calls.push('poll');
        state = { keysDown: held ? [13] : [], keysPressed: [13],
          keyEvents: [{ keyCode: 13, down: true }, { keyCode: 13, down: false }],
          pointerEvents: [{ type: 'mousedown' }, { type: 'mouseup' }],
          gamepads: [{ index: 0, instance: 7, connected: true,
            buttonsDown: held ? [0] : [], buttonsPressed: [0], axes: held ? [0.75, 0] : [0, 0] }] };
        return true;
      };
      host.input.snapshot = () => {
        calls.push('snapshot');
        const result = structuredClone(state);
        state.keyEvents = [];
        state.pointerEvents = [];
        return result;
      };
      host.input.consumePressed = () => {
        calls.push('consume');
        state.keysPressed = [];
        state.gamepads[0].buttonsPressed = [];
      };
      host.input.checkBoot = () => {
        assert.deepEqual(calls.slice(-3), ['poll', 'snapshot', 'consume']);
        const first = host.input.snapshot();
        assert.deepEqual(first.keysPressed, []);
        assert.deepEqual(first.keyEvents, []);
        assert.deepEqual(first.pointerEvents, []);
        assert.deepEqual(first.keysDown, held ? [13] : []);
        assert.deepEqual(first.gamepads, [{ index: 0, instance: 7, connected: true,
          buttonsDown: held ? [0] : [], buttonsPressed: [], axes: held ? [0.75, 0] : [0, 0] }]);
        booted = true;
        boots++;
      };
      await run(options);
      if (preparation === 'warm') await run(options);
      assert.equal(boots, preparation === 'warm' ? 2 : 1);
    });
  }
}

test('quit in the final event batch closes the host without starting the guest', async () => {
  const options = fixture('throw new Error("guest must not boot after quit");');
  options.assetPreparation = 'off';
  const host = require(options.addon);
  let quits = 0;
  host.pollEvents = () => false;
  host.runtime.quit = () => { quits++; };
  host.input.snapshot = () => { throw new Error('input must not be sampled after quit'); };
  host.input.consumePressed = () => { throw new Error('input must not be consumed after quit'); };
  await run(options);
  assert.equal(quits, 1);
});

test('controller exit reaches guest persistence cleanup', async () => {
  const options = fixture(`
    globalThis.pmjsSteam = { flush() { NativeHost.input.flushed(); } };
    NativeHost.input.checkBoot();
    globalThis.__pmjsTick = () => {};
    globalThis.__pmjsRender = () => {};
  `);
  options.assetPreparation = 'off'; options.mapPreparation = 'off';
  const host = require(options.addon);
  let booted = false, flushed = 0;
  host.input.checkBoot = () => { booted = true; };
  host.input.flushed = () => { ++flushed; };
  host.pollEvents = () => !booted;
  try {
    await run(options);
    assert.equal(flushed, 1);
  } finally { delete globalThis.pmjsSteam; }
});

test('window tasks retain event order and fullscreen changes without ordinary events', async t => {
  const globals = ['PMJS', '__pmjsUpdateWindowState', '__pmjsDispatchWindowEvents'];
  const previous = globals.map(key => globalThis[key]);
  t.after(() => globals.forEach((key, index) => { globalThis[key] = previous[index]; }));
  const options = fixture(`
    globalThis.__pmjsUpdateWindowState = () => {};
    globalThis.__pmjsDispatchWindowEvents = events => NativeHost.input.deliver(events);
    globalThis.PMJS = { tasks: {
      enqueue(fn) { NativeHost.input.enqueued(); fn(); },
      stop() { this.stopped = true; },
      runFrame(fn) { return Promise.resolve(fn()); }
    } };
    globalThis.__pmjsTick = () => {};
    globalThis.__pmjsRender = () => {};
  `);
  options.assetPreparation = 'off';
  const host = require(options.addon);
  let frame = -2, queued = 0;
  const delivered = [];
  const frames = [
    { fullscreen: false, events: [] },
    { fullscreen: false, events: [] },
    { fullscreen: true, events: [] },
    { fullscreen: true, events: [{ type: 'move', x: 3, y: 4 }] },
    { fullscreen: true, events: [] },
    { fullscreen: false, events: [{ type: 'leave-fullscreen' }] },
    { fullscreen: false, events: [] }
  ];
  host.pollEvents = () => ++frame < frames.length;
  host.runtime.windowState = () => ({ fullscreen: frames[frame].fullscreen });
  host.runtime.windowEvents = () => frames[frame].events;
  host.input.enqueued = () => { queued++; };
  host.input.deliver = events => { delivered.push([frame, events]); };
  await run(options);
  assert.equal(queued, 4);
  assert.deepEqual(delivered, [0, 2, 3, 5].map(index => [index, frames[index].events]));
});

for (const operation of ['snapshot', 'consumePressed']) {
  test(`input handoff ${operation} failure closes the host and prevents guest boot`, async () => {
    const options = fixture('throw new Error("guest must not boot after handoff failure");');
    options.assetPreparation = 'off';
    const host = require(options.addon);
    const failure = new Error('input handoff failed');
    let quits = 0;
    host.input[operation] = () => { throw failure; };
    host.runtime.quit = () => { quits++; };
    await assert.rejects(run(options), error => error === failure);
    assert.equal(quits, 1);
  });
}

test('runner loads an explicit Greenworks module in the host before bootstrap', async () => {
  const options = fixture(`
    if (!NativeHost.greenworks.hostProcess) throw new Error('backend loaded with guest process');
    if (NativeHost.greenworks.initAPI() !== false) throw new Error('changed backend result');
    globalThis.__pmjsTick=()=>{}; globalThis.__pmjsRender=()=>{};
  `);
  options.greenworksModule = path.join(options.gameRoot, 'greenworks.cjs');
  fs.writeFileSync(options.greenworksModule, `module.exports = {
    hostProcess: process === require('node:process'),
    initAPI() { return false; }, isSteamRunning() { return false; }
  };`);
  await run(options);
  assert.equal(globalThis.NativeHost.greenworks, require(options.greenworksModule));
});

test('missing, malformed and unloadable Greenworks modules fail before native initialization', async () => {
  const options = fixture('throw new Error("bootstrap should not run");');
  const host = require(options.addon);
  let initializations = 0;
  host.initialize = () => { initializations++; };
  options.greenworksModule = path.join(options.gameRoot, 'missing.cjs');
  await assert.rejects(run(options), error => error.code === 'MODULE_NOT_FOUND');
  options.greenworksModule = path.join(options.gameRoot, 'invalid.cjs');
  fs.writeFileSync(options.greenworksModule, 'module.exports = null;');
  await assert.rejects(run(options), /must export initAPI and isSteamRunning/);
  options.greenworksModule = path.join(options.gameRoot, 'invalid.node');
  fs.writeFileSync(options.greenworksModule, 'not a native addon');
  await assert.rejects(run(options), error => error.code === 'ERR_DLOPEN_FAILED');
  assert.equal(initializations, 0);
});

test('runner closes the initialized host when storage setup fails', async () => {
  const options = fixture('throw new Error("bootstrap should not run");');
  const host = require(options.addon);
  let quits = 0;
  host.runtime.quit = () => { quits++; };
  fs.writeFileSync(options.saveRoot, 'a file cannot be a save directory');
  await assert.rejects(run(options), /EEXIST|ENOTDIR/);
  assert.equal(quits, 1);
});

test('runner closes the host on frame failure and preserves the original error', async () => {
  const options = fixture('globalThis.__pmjsTick=()=>{};globalThis.__pmjsRender=()=>{};');
  const host = require(options.addon);
  const failure = new Error('frame failed');
  let polls = 0;
  host.pollEvents = () => { if (polls++ === 0) return true; throw failure; };
  let quits = 0;
  host.runtime.quit = () => { quits++; throw new Error('shutdown failed'); };
  await assert.rejects(run(options), error => error === failure);
  assert.equal(quits, 1);
});
test('timing config pins MV logic at 60 Hz and validates render rates', () => {
  assert.deepEqual(parseTimingConfig({}), { logicHz: 60, renderHz: 60,
    uncapped: false, renderPeriod: 1000 / 60, catchupMode: 'burst' });
  assert.equal(parseTimingConfig({ PMJS_RENDER_HZ: '30' }).renderPeriod, 1000 / 30);
  assert.equal(parseTimingConfig({ PMJS_RENDER_HZ: '120' }).renderHz, 120);
  const uncapped = parseTimingConfig({ PMJS_RENDER_HZ: '0' });
  assert.equal(uncapped.uncapped, true);
  assert.equal(parseTimingConfig({ PMJS_UNCAPPED: '1' }).uncapped, true);
  assert.equal(parseTimingConfig({ PMJS_RENDER_HZ: '30', PMJS_UNCAPPED: '1' }).uncapped, true);
  assert.equal(parseTimingConfig({ PMJS_CATCHUP_MODE: 'smooth' }).catchupMode, 'smooth');
  assert.equal(parseTimingConfig({ PMJS_CATCHUP_MODE: 'burst' }).catchupMode, 'burst');
  assert.throws(() => parseTimingConfig({ PMJS_CATCHUP_MODE: 'smooh' }), /PMJS_CATCHUP_MODE/);
  assert.throws(() => parseTimingConfig({ PMJS_RENDER_HZ: '45' }), /PMJS_RENDER_HZ/);
  assert.throws(() => parseTimingConfig({ PMJS_RENDER_HZ: 'abc' }), /PMJS_RENDER_HZ/);
  assert.throws(() => parseTimingConfig({ PMJS_RENDER_HZ: '-60' }), /PMJS_RENDER_HZ/);
  assert.throws(() => parseTimingConfig({ PMJS_LOGIC_HZ: '30' }), /PMJS_LOGIC_HZ/);
  assert.deepEqual(parseTimingConfig({ PMJS_LOGIC_HZ: '60' }).logicHz, 60);
});
test('uncapped render defaults the swap interval to 0 unless set', () => {
  assert.equal(resolveSwapDefault({}, parseTimingConfig({})), null);
  assert.equal(resolveSwapDefault({ PMJS_SWAP_INTERVAL: '1' },
    parseTimingConfig({ PMJS_RENDER_HZ: '0' })), null);
  assert.equal(resolveSwapDefault({}, parseTimingConfig({ PMJS_RENDER_HZ: '0' })), '0');
  assert.equal(resolveSwapDefault({ PMJS_SWAP_INTERVAL: '' },
    parseTimingConfig({ PMJS_UNCAPPED: '1' })), '0');
});
test('overdue scheduler skips expired deadlines without adding a full-period sleep', () => {
  const period = 1000 / 60;
  assert.ok(advanceDeadline(0, 32, period) <= 32);
  assert.ok(advanceDeadline(0, 40, period) <= 40);
  assert.ok(advanceDeadline(0, 100, period) <= 100);
  assert.equal(advanceDeadline(0, 10, period), period);
});
test('bootstrap and tick failures reject the run', async () => {
  const clock = require('node:perf_hooks').performance;
  const oldNow = Object.getOwnPropertyDescriptor(clock, 'now');
  let now = 0;
  Object.defineProperty(clock, 'now', { configurable: true, value: () => (now += 100) });
  try {
    const bootstrap = fixture('throw new Error("bootstrap failure")');
    bootstrap.assetPreparation = 'off'; bootstrap.mapPreparation = 'off';
    await assert.rejects(run(bootstrap), /bootstrap failure/);
    const tick = fixture('globalThis.__pmjsTick=()=>{throw new Error("tick failure")};globalThis.__pmjsRender=()=>{};');
    tick.assetPreparation = 'off'; tick.mapPreparation = 'off';
    tick.addon = writeAddon(tick.gameRoot, [true, true]);
    await assert.rejects(run(tick), /tick failure/);
  } finally {
    if (oldNow) Object.defineProperty(clock, 'now', oldNow);
    else delete clock.now;
  }
});

test('preparation cancellation polls the host, waits for its worker and prevents guest boot', async () => {
  const f = fixture('throw new Error("guest must not boot after cancellation");');
  fs.mkdirSync(path.join(f.gameRoot, 'img/pictures'), { recursive: true });
  fs.writeFileSync(path.join(f.gameRoot, 'img/pictures/test.png'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const marker = path.join(f.gameRoot, 'closed');
  fs.writeFileSync(f.addon, `
    const native = (${native.toString()})([false]);
    let workerStarted = false;
    native.pollEvents = () => !workerStarted;
    native.assets.processImage = () => {
      workerStarted = true;
      return new Promise(resolve => setTimeout(() => resolve(null), 50));
    };
    native.assets.installPrepared = () => { throw new Error('cancelled preparation must not install'); };
    native.runtime.quit = () => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'closed');
    module.exports = native;
  `);
  await run(f);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'closed');
  assert.deepEqual(fs.readdirSync(path.join(f.saveRoot, 'asset-cache/preparation-v1', fs.readdirSync(path.join(f.saveRoot, 'asset-cache/preparation-v1'))[0], 'entries')), []);
});

test('settings stays open while preparation completes and the guest starts', async () => {
  const clock = require('node:perf_hooks').performance;
  const oldNow = Object.getOwnPropertyDescriptor(clock, 'now');
  let now = 50000, shown = 0, guestBooted = false, cleared = 0;
  const progressPresentations = [];
  Object.defineProperty(clock, 'now', { configurable: true, value: () => now });
  const f = fixture('NativeHost.input.checkBoot(); globalThis.__pmjsTick=()=>{}; globalThis.__pmjsRender=()=>{};');
  fs.mkdirSync(path.join(f.gameRoot, 'img/pictures'), { recursive: true });
  fs.writeFileSync(path.join(f.gameRoot, 'img/pictures/test.png'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const host = require(f.addon);
  host.pollEvents = () => !guestBooted;
  host.input.snapshot = () => {
    now += 100;
    return { gamepads: [{ connected: true, instance: 1,
      buttonsDown: [16, 0], buttonsPressed: [], axes: [0, 0] }] };
  };
  host.input.checkBoot = () => { assert(shown > 0); guestBooted = true; };
  host.runtime.preparationProgress = value => { progressPresentations.push(value); };
  host.runtime.preparationClear = () => { cleared++; };
  host.runtime.settingsOverlay = () => ({ hasFont: true });
  host.runtime.settingsPresent = visible => { if (visible) shown++; };
  host.assets.processImage = () => new Promise(resolve => setTimeout(() => resolve(null), 1100));
  host.assets.installPrepared = () => {};
  try {
    await run(f);
    assert(shown > 0);
    assert(guestBooted);
    assert(progressPresentations.some(value => value.force && value.present === false));
    assert.equal(cleared, 1);
  } finally {
    if (oldNow) Object.defineProperty(clock, 'now', oldNow);
    else delete clock.now;
  }
});

for (const failure of ['poll', 'presentation', 'progress callback']) {
  test('preparation ' + failure + ' failure stops work and rejects with the original error', async () => {
    const f = fixture('throw new Error("guest must not boot after preparation failure");');
    fs.mkdirSync(path.join(f.gameRoot, 'img/pictures'), { recursive: true });
    fs.writeFileSync(path.join(f.gameRoot, 'img/pictures/test.png'),
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    fs.writeFileSync(path.join(f.gameRoot, 'img/pictures/test2.png'),
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    fs.writeFileSync(f.addon, `
      const native = (${native.toString()})();
      const failure = ${JSON.stringify(failure)};
      const error = new Error('preparation host failed');
      let workerStarted = false, finish;
      native.error = error;
      native.settled = false;
      native.closed = false;
      native.jobs = 0;
      native.pollEvents = () => {
        if (workerStarted && failure === 'poll') {
          setImmediate(finish);
          throw error;
        }
        return true;
      };
      native.runtime.preparationProgress = progress => {
        if (progress.terminal) throw new Error('later progress failed');
        if (failure === 'progress callback' && progress.phase === 'prepare') {
          setImmediate(finish);
          throw error;
        }
        if (failure === 'presentation' && workerStarted) {
          setImmediate(finish);
          throw error;
        }
      };
      native.assets.processImage = () => {
        native.jobs++;
        workerStarted = true;
        return new Promise(resolve => {
          finish = () => { native.settled = true; resolve(null); };
        });
      };
      native.assets.installPrepared = () => { throw new Error('failed preparation must not install'); };
      native.runtime.quit = () => { native.closed = true; };
      module.exports = native;
    `);
    const host = require(f.addon);
    await assert.rejects(run(f), error => error === host.error);
    assert.equal(host.settled, true);
    assert.equal(host.jobs, 1);
    assert.equal(host.closed, true);
    assert.deepEqual(fs.readdirSync(path.join(f.saveRoot, 'asset-cache/preparation-v1', fs.readdirSync(path.join(f.saveRoot, 'asset-cache/preparation-v1'))[0], 'entries')), []);
  });
}


test('preparation workspace accepts bounded byte limits', () => {
  const options = fixture('');
  assert.equal(validate(options).assetPreparation.pageCodec, 'lz4');
  assert.equal(validate({ ...options, assetPreparation: { pageCodec: 'png' } }).assetPreparation.pageCodec, 'png');
  assert.equal(validate({ ...options, assetPreparation: { pageCodec: 'lz4' } }).assetPreparation.pageCodec, 'lz4');
  assert.throws(() => validate({ ...options, assetPreparation: { pageCodec: 'lz4hc3' } }), /pageCodec must be png or lz4/);
  assert.equal(validate(options).assetPreparation.workspaceBytes, 256 * 1024 * 1024);
  assert.equal(validate({ ...options, assetPreparation: null }).assetPreparation.workspaceBytes, 256 * 1024 * 1024);
  for (const workspaceBytes of [0, 64 * 1024 * 1024, 128 * 1024 * 1024, 256 * 1024 * 1024])
    assert.equal(validate({ ...options, assetPreparation: { workspaceBytes } }).assetPreparation.workspaceBytes, workspaceBytes);
  for (const workspaceBytes of [-1, 0.5, 268435457, NaN, '64'])
    assert.throws(() => validate({ ...options, assetPreparation: { workspaceBytes } }), /workspaceBytes must be an integer/);
});

test('CLI preserves guest arguments after the separator', () => {
  const options = parse(['--game-root', 'game', '--', 'test', '--custom', 'value']);
  assert.deepEqual(options.guestArguments, ['test', '--custom', 'value']);
});

test('supervisor reloads into fresh processes, rechecks scripts and preserves saved state', async () => {
  const { runSupervised } = require('../runner/supervisor.cjs');
  const options = fixture('');
  const addon = require(options.addon);
  // Keep the fixture alive until the guest explicitly quits.
  fs.writeFileSync(options.addon, `let alive=true; const value=(${native.toString()})([]); value.pollEvents=()=>alive; value.runtime.quit=()=>{alive=false;}; module.exports=value;`);
  options.assetPreparation = 'off';
  let launches = 0;
  const result = await runSupervised(() => {
    launches++;
    const version = launches;
    fs.writeFileSync(options.bootstrap, `
      if(globalThis.sessionMarker) throw Error('globals survived reload');
      globalThis.sessionMarker=true;
      const previous = Number(NativeHost.storage.readText('counter') || 0);
      if(previous !== ${version - 1}) throw Error('save did not survive');
      NativeHost.storage.writeText('counter', String(previous+1));
      globalThis.pmjsSteam={flush(){NativeHost.storage.writeText('flushed',String(${version}));}};
      let ticked=false;
      globalThis.__pmjsTick=()=>{if(ticked)return;ticked=true;
        ${version < 3 ? 'NativeHost.runtime.reload();NativeHost.runtime.reload();' : 'NativeHost.runtime.quit();'}
      };
      globalThis.__pmjsRender=()=>{};
    `);
    return options;
  });
  assert.equal(result.code, 0);
  assert.equal(launches, 3);
  assert.equal(fs.readFileSync(path.join(options.saveRoot, 'counter'), 'utf8'), '3');
  assert.equal(fs.readFileSync(path.join(options.saveRoot, 'flushed'), 'utf8'), '3');
  assert.ok(addon);
});

test('supervisor propagates session failure without restarting', async () => {
  const { runSupervised } = require('../runner/supervisor.cjs');
  const options = fixture('throw Error("session crash");');
  let launches = 0;
  const result = await runSupervised(() => { launches++; return { ...options, assetPreparation: 'off' }; });
  assert.equal(result.code, 1);
  assert.equal(launches, 1);
});

test('a failed reload flush leaves the current session running and permits a retry', async () => {
  const { runSupervised } = require('../runner/supervisor.cjs');
  const options = fixture('');
  fs.writeFileSync(options.addon, `let alive=true; const value=(${native.toString()})([]); value.pollEvents=()=>alive; value.runtime.quit=()=>{alive=false;}; module.exports=value;`);
  options.assetPreparation = 'off';
  let launches = 0;
  const result = await runSupervised(() => {
    launches++;
    fs.writeFileSync(options.bootstrap, launches === 1 ? `
      let failed=true;
      globalThis.pmjsSteam={flush(){if(failed)throw Error('disk full');NativeHost.storage.writeText('flushed','yes');}};
      globalThis.__pmjsTick=()=>{
        if(NativeHost.runtime.reload()!==false)throw Error('failed flush accepted');
        NativeHost.storage.writeText('session-survived','yes');failed=false;
        if(NativeHost.runtime.reload()!==true)throw Error('retry rejected');
      };
      globalThis.__pmjsRender=()=>{};
    ` : `globalThis.__pmjsTick=()=>NativeHost.runtime.quit();globalThis.__pmjsRender=()=>{};`);
    return options;
  });
  assert.equal(result.code, 0); assert.equal(launches, 2);
  assert.equal(fs.readFileSync(path.join(options.saveRoot, 'session-survived'), 'utf8'), 'yes');
  assert.equal(fs.readFileSync(path.join(options.saveRoot, 'flushed'), 'utf8'), 'yes');
});

test('supervisor forwards termination to the active session without starting a replacement', async () => {
  const { runSupervised } = require('../runner/supervisor.cjs');
  const options = fixture("NativeHost.storage.writeText('ready','yes');globalThis.__pmjsTick=()=>{};globalThis.__pmjsRender=()=>{};");
  fs.writeFileSync(options.addon, `let alive=true; const value=(${native.toString()})([]); value.pollEvents=()=>alive; value.runtime.quit=()=>{alive=false;}; module.exports=value;`);
  fs.mkdirSync(options.saveRoot, { recursive: true });
  let watcher, launches = 0;
  const ready = new Promise(resolve => {
    watcher = fs.watch(options.saveRoot, (_event, name) => { if (name === 'ready') resolve(); });
  });
  try {
    const running = runSupervised(() => { launches++; return { ...options, assetPreparation: 'off' }; });
    await ready;
    process.emit('SIGTERM');
    const result = await running;
    assert.equal(result.signal, 'SIGTERM'); assert.equal(launches, 1);
  } finally { watcher.close(); }
});
