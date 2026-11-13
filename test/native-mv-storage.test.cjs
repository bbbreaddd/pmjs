'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runNativeMv, readStoredJson } = require('../runner/native-mv.cjs');
const { temporaryDirectory } = require('./helpers/temp.cjs');

test('an empty save directory does not invoke the decoder on a missing file', () => {
  const storage = { readText() { return null; } };
  const codec = { decompressFromBase64() { throw new Error('missing file passed to decoder'); } };
  assert.deepEqual(readStoredJson(storage, codec, 'config.rpgsave', {}), {});
  assert.deepEqual(readStoredJson(storage, codec, 'global.rpgsave', []), []);
});

function createBasicGameFixture(t, settings, savedConfig) {
  const root = temporaryDirectory('pmjs-native-mv-host-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const gameRoot = path.join(root, 'game');
  const saveRoot = path.join(root, 'isolated-save');
  fs.mkdirSync(gameRoot, { recursive: true });
  fs.mkdirSync(saveRoot, { recursive: true });
  const engineData = path.join(root, 'scene.json');
  fs.writeFileSync(engineData, JSON.stringify({
    format: 'pmjs-mv-map-scene-1',
    settings,
    database: {
      system: { gameTitle: 'BasicHostTest' },
      sceneContract: { kind: 'map', mapId: 1, width: settings.width, height: settings.height },
      maps: { 1: { width: 17, height: 13, tilesetId: 1, data: [], events: [] } },
      tiledMaps: { 1: { width: 17, height: 13 } }
    },
    initialState: { map: { _mapId: 1 } }
  }));
  if (savedConfig !== undefined) {
    fs.writeFileSync(path.join(saveRoot, 'config.rpgsave'), Buffer.from(JSON.stringify(savedConfig)).toString('base64'));
  }
  const addonPath = path.join(root, 'stub-addon.cjs');
  const logPath = path.join(root, 'calls.json');
  fs.writeFileSync(addonPath, `'use strict';
const fs = require('node:fs');
const logPath = ${JSON.stringify(logPath)};
const calls = { initialize: [], windowCommands: [], attach: [], configure: [] };
function flush() { fs.writeFileSync(logPath, JSON.stringify(calls)); }
module.exports = {
  initialize(opts) { calls.initialize.push(opts); flush(); },
  pollEvents() { return false; },
  finishLogicStep() {}, beginFrame() {}, renderFrame() {}, swapFrame() {},
  compression: {
    compressLZString: text => Buffer.from(text).toString('base64'),
    decompressLZString: text => Buffer.from(text, 'base64').toString('utf8')
  },
  runtime: {
    isFullscreen() { return process.env.STUB_FULLSCREEN === '1'; },
    windowCommand(...args) { calls.windowCommands.push(args); flush(); },
    quit() {}
  },
  mvEngine: {
    create() { return 1; },
    attach(_s, s) { calls.attach.push(s); flush(); },
    configure(_s, cfg) { calls.configure.push(cfg); flush(); },
    storageStatus() { return { configurationRevision: 0 }; },
    setSaveMetadata() {},
    load() {},
    openTitle() {},
    dispose() {}
  }
};
`);
  return { gameRoot, saveRoot, addonPath, engineData, logPath };
}

test('runtime bindings install before native state initialization', async t => {
  const game = createBasicGameFixture(t, {
    width: 816, height: 624, imageCacheBytes: 1000000, fontFile: 'fonts/game.ttf'
  });
  const order = [];
  await runNativeMv({ ...game, addon: game.addonPath }, {
    prepareAssets: async () => ({ cancelled: false, preparation: { cancelled: false } }),
    async installRuntime({ engine }) {
      await Promise.resolve();
      order.push('bindings');
      engine.load = () => order.push('load');
    },
    onSession() { order.push('session'); }
  });
  assert.deepEqual(order, ['bindings', 'load', 'session']);
});

test('runNativeMv applies Community_Basic host settings and respects fullscreen/PMJS_WINDOW_SIZE guards', async t => {
  const prevFullscreen = process.env.STUB_FULLSCREEN;
  const prevWindowSize = process.env.PMJS_WINDOW_SIZE;
  t.after(() => {
    if (prevFullscreen === undefined) delete process.env.STUB_FULLSCREEN; else process.env.STUB_FULLSCREEN = prevFullscreen;
    if (prevWindowSize === undefined) delete process.env.PMJS_WINDOW_SIZE; else process.env.PMJS_WINDOW_SIZE = prevWindowSize;
  });
  const settings = {
    width: 1280,
    height: 720,
    imageCacheBytes: 25_000_000,
    renderingMode: 'webgl',
    alwaysDash: true,
    windowWidth: 960,
    windowHeight: 540,
    fontFile: 'fonts/mplus-1m-regular.ttf'
  };

  delete process.env.STUB_FULLSCREEN;
  delete process.env.PMJS_WINDOW_SIZE;
  const windowed = createBasicGameFixture(t, settings);
  await runNativeMv(
    { gameRoot: windowed.gameRoot, saveRoot: windowed.saveRoot, addon: windowed.addonPath, engineData: windowed.engineData },
    { prepareAssets: async () => ({ cancelled: false, preparation: { cancelled: false } }) }
  );
  const windowedCalls = JSON.parse(fs.readFileSync(windowed.logPath, 'utf8'));
  assert.equal(windowedCalls.initialize[0].width, 1280);
  assert.equal(windowedCalls.initialize[0].height, 720);
  assert.equal(windowedCalls.initialize[0].imageWarmCacheBytes, 25_000_000);
  assert.deepEqual(windowedCalls.windowCommands, [['resize', 960, 540]]);
  assert.equal(windowedCalls.attach[0].renderingMode, 'webgl');
  assert.equal(windowedCalls.attach[0].width, 1280);
  assert.equal(windowedCalls.attach[0].height, 720);
  assert.deepEqual(windowedCalls.configure, [{ alwaysDash: true }, {}]);

  process.env.STUB_FULLSCREEN = '1';
  const fullscreen = createBasicGameFixture(t, settings, { alwaysDash: false, bgmVolume: 80 });
  await runNativeMv(
    { gameRoot: fullscreen.gameRoot, saveRoot: fullscreen.saveRoot, addon: fullscreen.addonPath, engineData: fullscreen.engineData },
    { prepareAssets: async () => ({ cancelled: false, preparation: { cancelled: false } }) }
  );
  const fullscreenCalls = JSON.parse(fs.readFileSync(fullscreen.logPath, 'utf8'));
  assert.deepEqual(fullscreenCalls.windowCommands, []);
  assert.deepEqual(fullscreenCalls.configure, [{ alwaysDash: true }, { alwaysDash: false, bgmVolume: 80 }]);

  delete process.env.STUB_FULLSCREEN;
  process.env.PMJS_WINDOW_SIZE = '800x600';
  const envSized = createBasicGameFixture(t, settings);
  await runNativeMv(
    { gameRoot: envSized.gameRoot, saveRoot: envSized.saveRoot, addon: envSized.addonPath, engineData: envSized.engineData },
    { prepareAssets: async () => ({ cancelled: false, preparation: { cancelled: false } }) }
  );
  assert.deepEqual(JSON.parse(fs.readFileSync(envSized.logPath, 'utf8')).windowCommands, []);
});
