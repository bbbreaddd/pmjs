'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { performance } = require('node:perf_hooks');
const { loadGame } = require('./mv-engine-data.cjs');
const { loadSceneData } = require('./mv-scene-data.cjs');
const { encodeGraph, decodeGraph } = require('./mv-save-codec.cjs');
const { createStorage } = require('./storage.cjs');
const { parseTimingConfig, resolveSwapDefault } = require('./config.cjs');
const { FixedStepClock } = require('./fixed-step-clock.cjs');

function readStoredJson(storage, compression, file, fallback) {
  const bytes = storage.readText(file);
  if (bytes === null) return fallback;
  return JSON.parse(compression.decompressFromBase64(bytes));
}

async function runNativeMv(options, hooks = {}) {
  hooks.stage?.('startup');
  if (!options.gameRoot || !options.addon || !options.saveRoot) throw new Error('native-mv requires game-root, addon and an isolated save-root');
  const root = path.resolve(options.gameRoot);
  const saveRoot = path.resolve(options.saveRoot);
  const canonical = value => fs.existsSync(value) ? fs.realpathSync(value) : value;
  if ([path.join(root, 'save'), path.join(path.dirname(root), 'save')].some(value => canonical(value) === canonical(saveRoot))) throw new Error('experimental engine requires a separate save directory');
  const loaded = options.engineData ? loadSceneData(options.engineData) : loadGame(root), settings = loaded.settings;
  const gameTitle = loaded.database.system.gameTitle;
  // The verified compression library is a storage codec, not engine behavior.
  const codecContext = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(root, 'js/libs/lz-string.js'), 'utf8'), codecContext, { timeout: 1000 });
  const compression = codecContext.LZString;
  const storage = createStorage(options.saveRoot);
  const timing = parseTimingConfig(process.env);
  const swapDefault = resolveSwapDefault(process.env, timing);
  if (swapDefault !== null) process.env.PMJS_SWAP_INTERVAL = swapDefault;
  const native = require(path.resolve(options.addon));
  native.initialize({ gameRoot: root, width: settings.width, height: settings.height,
    windowTitle: options.title || gameTitle, imageWarmCacheBytes: settings.imageCacheBytes });
  hooks.nativeReady?.(native);
  const startup = await hooks.prepareAssets(native, settings);
  if (startup.cancelled || startup.preparation.cancelled) { native.runtime.quit(); return { code: 0 }; }
  const engine = native.mvEngine;
  const session = engine.create(loaded.database);
  loaded.database = null;
  try {
    engine.attach(session, settings);
    engine.configure(session, { alwaysDash: settings.alwaysDash });
    engine.configure(session, readStoredJson(storage, compression, 'config.rpgsave', {}));
    let configurationRevision = engine.storageStatus(session).configurationRevision;
    engine.setSaveMetadata(session, readStoredJson(storage, compression, 'global.rpgsave', []));
    if (options.battleTest) engine.battleTest(session);
    else if (loaded.initialState) engine.load(session, loaded.initialState); else engine.openTitle(session);
    hooks.onSession?.({ engine, session, native });
    console.log('[pmjs] engine=native-mv original_engine_scripts=0');
    hooks.stage?.('playing');
    let deadline = performance.now();
    const logicalClock = new FixedStepClock(deadline, { logicHz: timing.logicHz, smooth: timing.catchupMode === 'smooth' });
    gameLoop: while (native.pollEvents()) {
      const now = performance.now();
      if (!timing.uncapped && now < deadline) { await new Promise(resolve => setTimeout(resolve, deadline - now)); continue; }
      if (!timing.uncapped) deadline = Math.max(deadline + timing.renderPeriod, now - timing.renderPeriod * 4);
      const due = logicalClock.takeSteps(now);
      for (let step = 0; step < due; ++step) {
        if (engine.step(session) === false) break gameLoop;
        const request = engine.storageStatus(session);
        if (request.configurationRevision !== configurationRevision) {
          storage.writeText('config.rpgsave', compression.compressToBase64(JSON.stringify(engine.configuration(session))));
          configurationRevision = request.configurationRevision;
        }
        if (request.save || request.load) {
          try {
            const file = `file${request.slot}.rpgsave`;
            if (request.save) {
              const contents = engine.save(session);
              storage.writeText(file, compression.compressToBase64(encodeGraph(contents)));
              const metadata = readStoredJson(storage, compression, 'global.rpgsave', []);
              metadata[request.slot] = { globalId: 'RPGMV', title: gameTitle,
                characters: contents.party._actors.map(id => [contents.actors._data[id]._characterName, contents.actors._data[id]._characterIndex]),
                faces: contents.party._actors.map(id => [contents.actors._data[id]._faceName, contents.actors._data[id]._faceIndex]),
                playtime: new Date(contents.system._framesOnSave / 60 * 1000).toISOString().slice(11, 19), timestamp: Date.now() };
              storage.writeText('global.rpgsave', compression.compressToBase64(JSON.stringify(metadata)));
              engine.setSaveMetadata(session, metadata);
            } else engine.load(session, decodeGraph(compression.decompressFromBase64(storage.readText(file))));
            engine.completeStorage(session, true);
          } catch (error) { console.error(`Save operation failed: ${error.message}`); engine.completeStorage(session, false); }
        }
        native.finishLogicStep();
      }
      native.beginFrame(); engine.present(session); native.renderFrame(); native.swapFrame();
      const presentedAt = performance.now(); hooks.observeFrame?.(presentedAt - now, presentedAt);
    }
  } finally { engine.dispose(session); }
  return { code: 0 };
}

module.exports = { runNativeMv, readStoredJson };
