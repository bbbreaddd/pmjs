'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { parse } = require('../runner/cli.cjs');
const { run, validate, parseTimingConfig, resolveSwapDefault } = require('../runner/index.cjs');

function fixture(source) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pmjs-runner-'));
  const bootstrap = path.join(root, 'bootstrap.js');
  fs.writeFileSync(bootstrap, source);
  return { addon: path.join(root, 'addon.node'), gameRoot: root, bootstrap,
    saveRoot: path.join(root, 'save'), width: 320, height: 240, title: 'Test' };
}
function native(polls = [false]) {
  let now = 0;
  return { initialize() {}, pollEvents: () => polls.shift() ?? false,
    finishLogicStep() {}, beginFrame() {}, renderFrame() {}, swapFrame() {},
    runtime: { monotonicNow: () => (now += 100), quit() {} }, fs: { readText() { return null; } },
    render: {}, scene: {}, images: {}, assets: {}, input: {}, canvas: {}, media: {} };
}

test('CLI parses the documented options including --config', () => {
  const value = parse(['--addon','a','--game-root','g','--bootstrap','b','--save-root','s',
    '--config','my-config.js','--width','640','--height','480','--image-warm-cache-bytes','1024']);
  assert.equal(value.width, 640); assert.equal(value.height, 480);
  assert.equal(value.config, 'my-config.js');
  assert.equal(value.imageWarmCacheBytes, 1024);
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
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmjs-runner-config-'));
  const configJson = path.join(tempDir, 'config.json');
  fs.writeFileSync(configJson, JSON.stringify({
    title: 'JSON Title',
    display: { width: 1280, height: 720 }
  }));
  const v1 = validate({ addon: 'a', gameRoot: tempDir, bootstrap: 'b', saveRoot: 's', config: configJson });
  assert.equal(v1.title, 'JSON Title');
  assert.equal(v1.width, 1280);
  assert.equal(v1.height, 720);

  const pkgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmjs-runner-pkg-'));
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({
    name: 'Package Name',
    window: { title: 'Package Window Title', width: 960, height: 540 }
  }));
  const v2 = validate({ addon: 'a', gameRoot: pkgDir, bootstrap: 'b', saveRoot: 's' });
  assert.equal(v2.title, 'Package Window Title');
  assert.equal(v2.width, 960);
  assert.equal(v2.height, 540);

  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmjs-runner-empty-'));
  const v3 = validate({ addon: 'a', gameRoot: emptyDir, bootstrap: 'b', saveRoot: 's' });
  assert.equal(v3.title, 'pmjs native runtime');
  assert.equal(v3.width, 816);
  assert.equal(v3.height, 624);
});

test('validation rejects missing or malformed explicit config', () => {
  assert.throws(() => validate({
    addon: 'a', gameRoot: 'g', bootstrap: 'b', saveRoot: 's',
    config: '/nonexistent-config-file.json'
  }), /config file not found/);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmjs-runner-bad-'));
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
  }), /error evaluating config file/);
});
test('validation rejects malformed disableOptimizations but keeps well-formed ports', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmjs-runner-opt-'));
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
  assert.equal(value.title, 'pmjs native runtime');
});

test('unknown port optimization IDs fail the run at startup', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmjs-runner-unknown-opt-'));
  const config = path.join(tempDir, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ disableOptimizations: ['terrax.nativeLight'] }));
  const manifest = path.join(tempDir, 'manifest.json');
  fs.writeFileSync(manifest, JSON.stringify({ modules: [
    'js/pmjs-core/optimizations.js',
    'js/pmjs-mv/setup.js',
    'js/pmjs-mv/plugin-loader.js',
  ] }));
  const bootstrap = path.join(tempDir, 'bootstrap.js');
  const tool = path.join(__dirname, '..', 'tools', 'build-js-runtime.mjs');
  childProcess.execFileSync(process.execPath,
    [tool, '--root', path.join(__dirname, '..'), '--manifest', manifest,
      '--config', config, '--output', bootstrap]);
  // Standard boot initializes plugins, runs the last registration seam
  // (beforeBoot), then finalizes before game boot; finalization rejects
  // the requested-but-unregistered ID. Mirrors bootstrap.js ordering.
  fs.appendFileSync(bootstrap,
    '\npmjsMvInitializePlugins();\npmjsRunHooks(\'beforeBoot\');\nPMJS.optimizations.finalize();\n');
  const options = { addon: path.join(tempDir, 'addon.node'), gameRoot: tempDir,
    bootstrap, saveRoot: path.join(tempDir, 'save'), width: 320, height: 240,
    title: 'Test', config, native: native() };
  options.native.runtime.env = () => '';
  await assert.rejects(run(options), /Unknown PMJS optimization: terrax\.nativeLight/);
});
test('afterBootstrap runs once and Node jobs are not starved', async () => {
  const options = fixture('globalThis.__pmjsTick=()=>{};globalThis.__pmjsRender=()=>{};');
  options.native = native();
  let hooked = 0;
  const job = new Promise(resolve => setImmediate(resolve));
  await run(options, { afterBootstrap({ native: host }) {
    hooked++;
    assert.deepEqual(host.runtime.platform(),
      { platform: process.platform, arch: process.arch });
  } });
  await job;
  assert.equal(hooked, 1);
});
test('timing config pins MV logic at 60 Hz and validates render rates', () => {
  assert.deepEqual(parseTimingConfig({}), { logicHz: 60, renderHz: 60,
    uncapped: false, renderPeriod: 1000 / 60 });
  assert.equal(parseTimingConfig({ PMJS_RENDER_HZ: '30' }).renderPeriod, 1000 / 30);
  assert.equal(parseTimingConfig({ PMJS_RENDER_HZ: '120' }).renderHz, 120);
  const uncapped = parseTimingConfig({ PMJS_RENDER_HZ: '0' });
  assert.equal(uncapped.uncapped, true);
  assert.equal(parseTimingConfig({ PMJS_UNCAPPED: '1' }).uncapped, true);
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
test('bootstrap and tick failures reject the run', async () => {
  const bootstrap = fixture('throw new Error("bootstrap failure")');
  bootstrap.native = native();
  await assert.rejects(run(bootstrap), /bootstrap failure/);
  const tick = fixture('globalThis.__pmjsTick=()=>{throw new Error("tick failure")};globalThis.__pmjsRender=()=>{};');
  tick.native = native([true]);
  await assert.rejects(run(tick), /tick failure/);
});
