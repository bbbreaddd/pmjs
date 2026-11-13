'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { loadGame } = require('./mv-engine-data.cjs');
const { loadSceneData } = require('./mv-scene-data.cjs');
const { createStorage } = require('./storage.cjs');
const { parseTimingConfig, resolveSwapDefault } = require('./config.cjs');
const { FixedStepClock } = require('./fixed-step-clock.cjs');

function readStoredJson(storage, compression, file, fallback) {
  const bytes = storage.readText(file);
  if (bytes === null) return fallback;
  return JSON.parse(compression.decompressFromBase64(bytes));
}

function loadSaveMetadata(storage, compression) {
  const metadata = readStoredJson(storage, compression, 'global.rpgsave', []) || [];
  for (let slot = 1; slot < metadata.length; ++slot) {
    if (!fs.existsSync(storage.resolvePath(`file${slot}.rpgsave`))) delete metadata[slot];
  }
  return metadata;
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
  const native = require(path.resolve(options.addon));
  const compression = { compressToBase64: native.compression.compressLZString, decompressFromBase64: native.compression.decompressLZString };
  const storage = createStorage(options.saveRoot);
  const timing = parseTimingConfig(process.env);
  const swapDefault = resolveSwapDefault(process.env, timing);
  if (swapDefault !== null) process.env.PMJS_SWAP_INTERVAL = swapDefault;
  native.initialize({ gameRoot: root, width: settings.width, height: settings.height,
    windowTitle: options.title || gameTitle, imageWarmCacheBytes: settings.imageCacheBytes });
  hooks.nativeReady?.(native);
  if (settings.windowWidth && settings.windowHeight && !process.env.PMJS_WINDOW_SIZE &&
      typeof native.runtime?.isFullscreen === 'function' && !native.runtime.isFullscreen()) {
    native.runtime.windowCommand('resize', settings.windowWidth, settings.windowHeight);
  }
  const startup = await hooks.prepareAssets(native, settings);
  if (startup.cancelled || startup.preparation.cancelled) { native.runtime.quit(); return { code: 0 }; }
  const engine = native.mvEngine;
  const session = engine.create(loaded.database);
  loaded.database = null;
  try {
    engine.attach(session, settings);
    engine.configure(session, { alwaysDash: settings.alwaysDash });
    let configuration = {};
    try { configuration = readStoredJson(storage, compression, 'config.rpgsave', {}) || {}; }
    catch (error) { console.error(`Configuration load failed: ${error.message}`); }
    engine.configure(session, configuration);
    let configurationRevision = engine.storageStatus(session).configurationRevision;
    engine.setSaveMetadata(session, loadSaveMetadata(storage, compression));
    await hooks.installRuntime?.({ engine, session, native });
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
              storage.writeText(file, compression.compressToBase64(engine.encodeGraph(contents)));
              const metadata = loadSaveMetadata(storage, compression);
              const members = contents.party._actors.map(id => contents.actors._data[id]).filter(actor => actor && !actor._hidden).slice(0, 4);
              const seconds = Math.floor((contents.system._framesOnSave || 0) / 60);
              const pad = value => String(value).padStart(2, '0');
              const playtime = `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}`;
              metadata[request.slot] = { globalId: 'RPGMV', title: gameTitle,
                characters: members.map(actor => [actor._characterName, actor._characterIndex]),
                faces: members.map(actor => [actor._faceName, actor._faceIndex]),
                playtime, timestamp: Date.now() };
              storage.writeText('global.rpgsave', compression.compressToBase64(JSON.stringify(metadata)));
              engine.setSaveMetadata(session, metadata);
            } else engine.load(session, engine.decodeGraph(compression.decompressFromBase64(storage.readText(file))));
            engine.completeStorage(session, true);
          } catch (error) { console.error(`Save operation failed: ${error.message}`); engine.completeStorage(session, false); }
        }
        native.finishLogicStep();
      }
      if (engine.render(session)) {
        native.swapFrame();
        const presentedAt = performance.now(); hooks.observeFrame?.(presentedAt - now, presentedAt);
      }
    }
  } finally { engine.dispose(session); }
  return { code: 0 };
}

module.exports = { runNativeMv, readStoredJson };
