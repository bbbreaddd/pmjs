'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { parse } = require('../runner/cli.cjs');
const { run, validate, parseTimingConfig, resolveSwapDefault, advanceDeadline } = require('../runner/index.cjs');
const { temporaryDirectory } = require('./helpers/temp.cjs');

function fixture(source) {
  const root = temporaryDirectory('pmjs-runner-');
  const bootstrap = path.join(root, 'bootstrap.js');
  fs.writeFileSync(bootstrap, source);
  const addon = writeAddon(root);
  return { addon, gameRoot: root, bootstrap,
    saveRoot: path.join(root, 'save'), width: 320, height: 240, title: 'Test' };
}
function native(polls = [false]) {
  let now = 0;
  return { initialize() {}, pollEvents: () => polls.shift() ?? false,
    finishLogicStep() {}, beginFrame() {}, renderFrame() {}, swapFrame() {},
    runtime: { env() { return ''; }, monotonicNow: () => (now += 100), quit() {} },
    fs: { mountWritableOverlay() {}, updateWritableOverlay() {}, readText() { return null; } },
    render: {}, scene: {}, images: {}, assets: {}, input: {}, canvas: {}, media: {} };
}

function writeAddon(root, polls = [false]) {
  const addon = path.join(root, 'addon.cjs');
  fs.writeFileSync(addon, `module.exports = (${native.toString()})(${JSON.stringify(polls)});`);
  return addon;
}

test('CLI parses the documented options including --config', () => {
  const value = parse(['--addon','a','--game-root','g','--bootstrap','b','--save-root','s',
    '--config','my-config.json','--width','640','--height','480','--image-warm-cache-bytes','1024',
    '--greenworks-module','steam/greenworks.js']);
  assert.equal(value.width, 640); assert.equal(value.height, 480);
  assert.equal(value.config, 'my-config.json');
  assert.equal(value.imageWarmCacheBytes, 1024);
  assert.equal(value.greenworksModule, 'steam/greenworks.js');
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
  host.pollEvents = () => { throw failure; };
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
  const bootstrap = fixture('throw new Error("bootstrap failure")');
  await assert.rejects(run(bootstrap), /bootstrap failure/);
  const tick = fixture('globalThis.__pmjsTick=()=>{throw new Error("tick failure")};globalThis.__pmjsRender=()=>{};');
  tick.addon = writeAddon(tick.gameRoot, [true]);
  await assert.rejects(run(tick), /tick failure/);
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
  assert.deepEqual(fs.readdirSync(path.join(f.saveRoot, 'asset-cache/entries')), []);
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
        if (failure === 'progress callback' && progress.phase === 'prepare') throw error;
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
          if (failure === 'progress callback') setImmediate(finish);
        });
      };
      native.assets.installPrepared = () => { throw new Error('failed preparation must not install'); };
      native.runtime.quit = () => { native.closed = true; };
      module.exports = native;
    `);
    const host = require(f.addon);
    await assert.rejects(run(f), error => error === host.error);
    assert.equal(host.settled, failure !== 'progress callback');
    assert.equal(host.jobs, failure === 'progress callback' ? 0 : 1);
    assert.equal(host.closed, true);
    assert.deepEqual(fs.readdirSync(path.join(f.saveRoot, 'asset-cache/entries')), []);
  });
}
