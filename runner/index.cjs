'use strict';

const { prepareMaps } = require('./map-preparation.cjs');

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { performance } = require('node:perf_hooks');
const { createStorage, createGameFilesystem } = require('./storage.cjs');
const { prepareAssets, validRecipes } = require('./asset-preparation.cjs');

function resolveDefaults(input) {
  let title = input.title;
  let width = input.width;
  let height = input.height;
  let assetPreparation = {};
  let preparationFonts = [];
  let configDirectory = process.cwd();

  if (input.config) {
    const configPath = path.resolve(input.config);
    if (!fs.existsSync(configPath)) {
      throw new Error(`config file not found: ${configPath}`);
    }
    let cfg;
    try { cfg = JSON.parse(fs.readFileSync(configPath, 'utf8')); }
    catch (error) { throw new Error(`invalid JSON in config file ${configPath}: ${error.message}`); }
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error('configuration must be an object');
    if (title === undefined && cfg.title) title = cfg.title;
    if (width === undefined && cfg.display && cfg.display.width) width = Number(cfg.display.width);
    if (height === undefined && cfg.display && cfg.display.height) height = Number(cfg.display.height);
    if (cfg.fonts && typeof cfg.fonts === 'object') {
      preparationFonts = Object.values(cfg.fonts).flat().filter(font => typeof font === 'string');
    }
    assertDisableOptimizationsShape(cfg.disableOptimizations, configPath);
    configDirectory = path.dirname(configPath);
    if (cfg.assetPreparation !== undefined) assetPreparation = cfg.assetPreparation;
  }

  if (input.gameRoot) {
    const rootPath = path.resolve(input.gameRoot);
    if (title === undefined) {
      const systemPath = path.join(rootPath, 'data', 'System.json');
      if (fs.existsSync(systemPath)) {
        try {
          const sys = JSON.parse(fs.readFileSync(systemPath, 'utf8'));
          if (sys && typeof sys.gameTitle === 'string' && sys.gameTitle.trim()) {
            title = sys.gameTitle.trim();
          }
        } catch (_) {}
      }
    }
    const pkgPath = path.join(rootPath, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        if (title === undefined && pkg.window && pkg.window.title) title = pkg.window.title;
        if (title === undefined && pkg.name) title = pkg.name;
        if (width === undefined && pkg.window && pkg.window.width) width = Number(pkg.window.width);
        if (height === undefined && pkg.window && pkg.window.height) height = Number(pkg.window.height);
      } catch (_) {}
    }
  }

  if (width === undefined) width = 816;
  if (height === undefined) height = 624;
  if (title === undefined) title = 'PMJS';

  if (!assetPreparation || typeof assetPreparation !== 'object' || Array.isArray(assetPreparation)) {
    throw new Error('assetPreparation must be an object');
  }
  assetPreparation = { enabled: true, maps: true, verifyHashes: false, ...assetPreparation,
    ...(typeof input.assetPreparation === 'object' ? input.assetPreparation : {}) };
  if (input.assetPreparation === 'on' || input.assetPreparation === 'off') {
    assetPreparation.enabled = input.assetPreparation === 'on';
  } else if (input.assetPreparation !== undefined && typeof input.assetPreparation !== 'object') {
    throw new Error('assetPreparation must be on or off');
  }
  if (input.mapPreparation !== undefined) {
    if (!['on', 'off'].includes(input.mapPreparation)) throw new Error('mapPreparation must be on or off');
    assetPreparation.maps = input.mapPreparation === 'on';
  }
  if (typeof assetPreparation.maps !== 'boolean') throw new Error('assetPreparation.maps must be a boolean');
  if (typeof assetPreparation.verifyHashes !== 'boolean') throw new Error('assetPreparation.verifyHashes must be a boolean');
  if (!assetPreparation.enabled) assetPreparation.maps = false;
  if (input.assetCacheRoot !== undefined) assetPreparation.cacheRoot = path.resolve(input.assetCacheRoot);
  else if (assetPreparation.cacheRoot !== undefined) {
    assetPreparation.cacheRoot = path.resolve(configDirectory, assetPreparation.cacheRoot);
  }
  if (input.assetRecipes !== undefined) assetPreparation.recipes = path.resolve(input.assetRecipes);
  else if (typeof assetPreparation.recipes === 'string') {
    assetPreparation.recipes = path.resolve(configDirectory, assetPreparation.recipes);
  }
  if (typeof assetPreparation.enabled !== 'boolean') throw new Error('assetPreparation.enabled must be a boolean');
  if (typeof assetPreparation.recipes === 'string') {
    assetPreparation.recipes = JSON.parse(fs.readFileSync(assetPreparation.recipes, 'utf8'));
  }
  assetPreparation.recipes = validRecipes(assetPreparation.recipes || []);
  return { ...input, width, height, title, assetPreparation, preparationFonts };
}

function assertDisableOptimizationsShape(value, configPath) {
  if (value === undefined) return;
  const ok = Array.isArray(value) && value.every(id => typeof id === 'string' && id) &&
    new Set(value).size === value.length;
  if (!ok) {
    throw new Error(`disableOptimizations in ${configPath} must be an array of unique nonempty strings`);
  }
}

const PMJS_MV_LOGIC_HZ = 60;
const PMJS_SUPPORTED_RENDER_HZ = [30, 60, 120];

function parseTimingConfig(env) {
  const source = env || {};
  if (source.PMJS_LOGIC_HZ !== undefined && source.PMJS_LOGIC_HZ !== '' &&
      Number(source.PMJS_LOGIC_HZ) !== PMJS_MV_LOGIC_HZ) {
    throw new Error(
      `PMJS_LOGIC_HZ must be ${PMJS_MV_LOGIC_HZ} ` +
      `(MV simulation is fixed at the authored rate): ${source.PMJS_LOGIC_HZ}`);
  }
  const rawCatchup = source.PMJS_CATCHUP_MODE;
  let catchupMode = 'burst';
  if (rawCatchup !== undefined && rawCatchup !== '') {
    if (rawCatchup !== 'smooth' && rawCatchup !== 'burst') {
      throw new Error(`PMJS_CATCHUP_MODE must be 'smooth' or 'burst': ${rawCatchup}`);
    }
    catchupMode = rawCatchup;
  }
  const uncappedFlag = source.PMJS_UNCAPPED === '1';
  const raw = source.PMJS_RENDER_HZ;
  if (raw === undefined || raw === '') {
    if (uncappedFlag) return { logicHz: PMJS_MV_LOGIC_HZ, renderHz: 0, uncapped: true, renderPeriod: Infinity, catchupMode };
    return { logicHz: PMJS_MV_LOGIC_HZ, renderHz: 60, uncapped: false,
      renderPeriod: 1000 / 60, catchupMode };
  }
  const renderHz = Number(raw);
  if (renderHz === 0) {
    return { logicHz: PMJS_MV_LOGIC_HZ, renderHz: 0, uncapped: true,
      renderPeriod: Infinity, catchupMode };
  }
  if (!PMJS_SUPPORTED_RENDER_HZ.includes(renderHz)) {
    throw new Error(
      `PMJS_RENDER_HZ must be one of 0 (uncapped), ` +
      `${PMJS_SUPPORTED_RENDER_HZ.join(', ')}: ${raw}`);
  }
  if (renderHz === 0 || uncappedFlag) {
    return { logicHz: PMJS_MV_LOGIC_HZ, renderHz: 0, uncapped: true,
      renderPeriod: Infinity, catchupMode };
  }
  return { logicHz: PMJS_MV_LOGIC_HZ, renderHz, uncapped: false,
    renderPeriod: 1000 / renderHz, catchupMode };
}

function resolveSwapDefault(env, timing) {
  const source = env || {};
  if (timing.uncapped && (source.PMJS_SWAP_INTERVAL === undefined ||
      source.PMJS_SWAP_INTERVAL === '')) {
    return '0';
  }
  return null;
}

function advanceDeadline(deadline, now, period) {
  let next = deadline + period;
  if (next < now - period) {
    next += Math.floor((now - next) / period) * period;
  }
  return next;
}

function validate(input) {
  const options = resolveDefaults(input);
  const requiredPaths = ['addon', 'gameRoot', 'bootstrap', 'saveRoot'];
  for (const name of requiredPaths) {
    if (typeof options[name] !== 'string' || !options[name]) {
      throw new Error(`${name} is required`);
    }
  }
  for (const name of ['width', 'height']) {
    if (!Number.isInteger(options[name]) || options[name] < 1 || options[name] > 16384) {
      throw new Error(`${name} must be an integer between 1 and 16384`);
    }
  }
  const configuredWarmBytes = options.imageWarmCacheBytes ??
    process.env.PMJS_IMAGE_WARM_CACHE_BYTES;
  const imageWarmCacheBytes = configuredWarmBytes === undefined ? undefined :
    Number(configuredWarmBytes);
  if (imageWarmCacheBytes !== undefined &&
      (!Number.isSafeInteger(imageWarmCacheBytes) || imageWarmCacheBytes < 0)) {
    throw new Error('imageWarmCacheBytes must be a non-negative safe integer');
  }
  if (options.greenworksModule !== undefined &&
      (typeof options.greenworksModule !== 'string' || !options.greenworksModule)) {
    throw new Error('greenworksModule must be a nonempty host module path');
  }
  return {
    ...options,
    ...(options.greenworksModule === undefined ? {} :
      { greenworksModule: path.resolve(options.greenworksModule) }),
    addon: path.resolve(options.addon),
    gameRoot: path.resolve(options.gameRoot),
    bootstrap: path.resolve(options.bootstrap),
    saveRoot: path.resolve(options.saveRoot),
    assetRoot: options.assetRoot ? path.resolve(options.assetRoot) : '',
    assetPreparation: { ...options.assetPreparation,
      cacheRoot: options.assetPreparation.cacheRoot || path.join(path.resolve(options.saveRoot), 'asset-cache') },
    ...(imageWarmCacheBytes === undefined ? {} : { imageWarmCacheBytes }),
    title: options.title,
  };
}

function progressClock(milliseconds) {
  const seconds = Math.floor(Math.max(0, milliseconds) / 1000);
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

function progressLines(progress) {
  const { phase, source = '', completed = 0, total = 0, generated = 0,
    hits = 0, fallback = 0, elapsedMs = 0 } = progress;
  const titles = {
    discover: 'Finding game assets', wait: 'Waiting for asset cache',
    validate: 'Checking cached assets', prepare: 'Preparing new assets',
    ready: 'Checking game assets', install: 'Finishing asset preparation',
    cleanup: 'Finishing asset preparation', complete: 'Assets ready',
    cancelled: 'Asset preparation cancelled', error: 'Continuing with original assets',
  };
  const rate = elapsedMs > 0 && completed > 0 ? completed * 1000 / elapsedMs : null;
  const remaining = Math.max(0, total - completed);
  const working = phase === 'validate' || phase === 'prepare';
  const lines = [titles[phase] || 'Preparing game assets',
    phase === 'discover' ? 'Counting files...' :
      `${completed} / ${total} done (${total ? Math.floor(completed * 100 / total) : 100}%)  |  ${remaining} left`,
    source ? `Current file: ${source.replace(/[\r\n\t]/g, ' ')}` : '',
    `Cache: ${generated} new, ${hits} reused  |  Originals: ${fallback}`,
    `Elapsed: ${progressClock(elapsedMs)}  |  Average: ${rate === null ? 'estimating...' : `${rate.toFixed(1)} files/s`}`];
  if (!progress.terminal && total && remaining && rate !== null && completed >= 3 &&
      (phase === 'ready' || working)) {
    lines.push(`Estimated time left: ${progressClock(remaining * 1000 / rate)}`);
  } else if (phase === 'prepare') {
    lines.push('Large files can take longer. Original files are preserved.');
  } else if (phase === 'wait') {
    lines.push('Another launch is preparing this cache.');
  } else if (phase === 'discover' || phase === 'validate') {
    lines.push('Existing prepared assets are reused when unchanged.');
  } else if (phase === 'install' || phase === 'cleanup') {
    lines.push('All files checked; finishing up...');
  }
  return lines;
}

async function run(input) {
  const options = validate(input);
  const hostProcess = process;
  // Load host addons before the bootstrap installs the guest process and require.
  const greenworks = options.greenworksModule ? require(options.greenworksModule) : null;
  if (options.greenworksModule && (!greenworks || typeof greenworks.initAPI !== 'function' ||
      typeof greenworks.isSteamRunning !== 'function')) {
    throw new Error('Greenworks backend must export initAPI and isSteamRunning');
  }

  const timing = parseTimingConfig(hostProcess.env);
  const swapDefault = resolveSwapDefault(hostProcess.env, timing);
  if (swapDefault !== null) {
    hostProcess.env.PMJS_SWAP_INTERVAL = swapDefault;
    console.log('[pmjs] uncapped render: defaulting PMJS_SWAP_INTERVAL=0 (was unset)');
  }
  const native = require(options.addon);
  native.initialize({ gameRoot: options.gameRoot, assetRoot: options.assetRoot,
    width: options.width, height: options.height, windowTitle: options.title,
    ...(options.imageWarmCacheBytes === undefined ? {} :
      { imageWarmCacheBytes: options.imageWarmCacheBytes }) });
  let pendingInvalidations = 0, retryInvalidationAt = 0;
  let invalidateImages, invalidateMaps;
  native.assets.invalidateMapCatalog = () => { pendingInvalidations |= 2; };
  function flushPreparationInvalidations(force = false) {
    if (typeof native.assets.consumePreparationInvalidations === 'function')
      pendingInvalidations |= native.assets.consumePreparationInvalidations();
    if (!pendingInvalidations || (!force && performance.now() < retryInvalidationAt)) return;
    if ((pendingInvalidations & 1) && invalidateImages && invalidateImages()) pendingInvalidations &= ~1;
    if ((pendingInvalidations & 2) && invalidateMaps && invalidateMaps()) pendingInvalidations &= ~2;
    retryInvalidationAt = performance.now() + 1000;
  }
  try {
    native.storage = createStorage(options.saveRoot);
    native.fs = createGameFilesystem(native.fs, path.join(options.saveRoot, 'game-files'));
    if (options.assetPreparation.enabled) {
      let cancelled = false;
      let preparationFailed = false;
      let preparationError;
      const failPreparation = error => {
        if (!preparationFailed) preparationError = error;
        preparationFailed = true;
        cancelled = true;
      };
      const screenStarted = performance.now();
      let screenUpdated = -Infinity;
      let current = { completed: 0, total: 0, phase: 'discover' };
      const showProgress = () => {
        if (preparationFailed || (cancelled && !current.terminal) ||
            typeof native.runtime.preparationProgress !== 'function') return;
        const elapsedMs = performance.now() - screenStarted;
        screenUpdated = elapsedMs;
        const progress = { ...current, elapsedMs };
        native.runtime.preparationProgress({ ...progress, lines: progressLines(progress),
          fonts: options.preparationFonts });
      };
      showProgress();
      const pump = setInterval(() => {
        if (cancelled) return;
        try {
          if (!native.pollEvents()) cancelled = true;
          if (performance.now() - screenStarted - screenUpdated >= 100) showProgress();
        } catch (error) { failPreparation(error); }
      }, 16);
      let preparation;
      try {
        preparation = await prepareAssets({ gameRoot: options.gameRoot,
          cacheRoot: options.assetPreparation.cacheRoot, recipes: options.assetPreparation.recipes, native,
          verifyHashes: options.assetPreparation.verifyHashes,
          shouldCancel: () => cancelled,
          onProgress: progress => {
            current = progress;
            try { showProgress(); }
            catch (error) { failPreparation(error); }
          } });
        if (!cancelled && options.assetPreparation.maps) {
          preparation.maps = await prepareMaps({ gameRoot: options.gameRoot,
            cacheRoot: options.assetPreparation.cacheRoot, native, width: options.width, height: options.height,
            verifyHashes: options.assetPreparation.verifyHashes,
            shouldCancel: () => cancelled, onProgress: progress => { current = progress; showProgress(); } });
        }
      } catch (error) {
        throw preparationFailed ? preparationError : error;
      } finally { clearInterval(pump); }
      if (preparationFailed) throw preparationError;
      invalidateImages = preparation.invalidateCatalog;
      invalidateMaps = preparation.maps && preparation.maps.invalidateCatalog;
      const { entries, decryptedEntries, releaseCacheLease, invalidateCatalog, ...preparationStats } = preparation;
      native.assets.preparationStats = preparationStats;
      console.log(`[pmjs] asset preparation generated=${preparation.generated} hits=${preparation.hits} ` +
        `decrypted=${preparation.decrypted} fallback=${preparation.fallback} ` +
        `hashed_files=${preparation.validation?.hashedFiles || 0} hashed_bytes=${preparation.validation?.hashedBytes || 0} ` +
        `reused_files=${preparation.validation?.reusedFiles || 0} duration_ms=${preparation.durationMs.toFixed(1)}`);
      if (preparation.maps) {
        const maps = preparation.maps;
        console.log(`[pmjs] map preparation generated=${maps.generated} hits=${maps.hits} ` +
          `compilation_hits=${maps.compilationHits} selected=${maps.selected} ` +
          `hashed_files=${maps.validation?.hashedFiles || 0} hashed_bytes=${maps.validation?.hashedBytes || 0} ` +
          `reused_files=${maps.validation?.reusedFiles || 0} duration_ms=${maps.durationMs.toFixed(1)}`);
      }
      if (cancelled || preparation.cancelled) { native.runtime.quit(); return; }
    } else if (native.assets && typeof native.assets.installPrepared === 'function') {
      native.assets.installPrepared([]);
      if (native.assets.installDecrypted) native.assets.installDecrypted([]);
    }
    native.assets.mapPreparationEnabled = options.assetPreparation.maps;
    console.log(`[pmjs] map preparation=${options.assetPreparation.maps ? "on" : "off"}`);
    native.runtime.now = () => performance.now();
    native.runtime.platform = () => ({ platform: process.platform, arch: process.arch });
    native.runtime.loadScript = relative => {
      const source = native.fs.readText(relative);
      if (source === null) throw new Error(`cannot load script: ${relative}`);
      return vm.runInThisContext(source, { filename: path.join(options.gameRoot, relative) });
    };
    native.runtime.runScript = source => vm.runInThisContext(String(source), {
      filename: 'inline-script.js'
    });
    const hostSetTimeout = globalThis.setTimeout.bind(globalThis);
    const hostSetImmediate = typeof globalThis.setImmediate === 'function'
      ? globalThis.setImmediate.bind(globalThis) : null;
    const physicalDisplay = (native.runtime && typeof native.runtime.displaySize === 'function')
      ? native.runtime.displaySize()
      : {
          width: Number(process.env.PMJS_SCREEN_WIDTH || 640),
          height: Number(process.env.PMJS_SCREEN_HEIGHT || 480)
        };
    globalThis.NativeHost = { runtime: native.runtime, render: native.render,
      plugins: native.plugins, mv: native.mv,
      scene: native.scene, images: native.images, assets: native.assets, fs: native.fs,
      storage: native.storage, input: native.input, canvas: native.canvas,
      media: native.media, dialog: native.dialog, effects: native.effects,
      greenworks };
    globalThis.__pmjsBuiltinRequire = require;
    globalThis.__pmjsNativeRuntime = true;
    globalThis.__pmjsTimingConfig = {
      renderHz: timing.renderHz,
      catchupMode: timing.catchupMode
    };
    globalThis.__pmjsGameInfo = {
      title: options.title,
      width: options.width,
      height: options.height,
      displayWidth: physicalDisplay.width,
      displayHeight: physicalDisplay.height
    };
    vm.runInThisContext(fs.readFileSync(options.bootstrap, 'utf8'), {
      filename: options.bootstrap, displayErrors: true,
    });
    if (typeof globalThis.__pmjsTick !== 'function' ||
        typeof globalThis.__pmjsRender !== 'function') {
      throw new Error('bootstrap did not install __pmjsTick and __pmjsRender');
    }

    const period = timing.renderPeriod;
    let deadline = timing.uncapped ? 0 : native.runtime.monotonicNow() + period;
    console.log(`[pmjs] timing logic_hz=${timing.logicHz} ` +
      (timing.uncapped ? 'render_hz=uncapped' : `render_hz=${timing.renderHz}`));
    console.log(`[pmjs] ready size=${options.width}x${options.height}`);
    return await new Promise((resolve, reject) => {
      function schedule() {
        if (timing.uncapped) { hostSetImmediate(tick); return; }
        const delay = Math.max(0, deadline - native.runtime.monotonicNow());
        if (delay < 1 && hostSetImmediate) hostSetImmediate(tick);
        else hostSetTimeout(tick, delay);
      }
      function tick() {
        try {
          flushPreparationInvalidations();
          if (!native.pollEvents()) { flushPreparationInvalidations(true); resolve(); return; }
          if (typeof globalThis.__pmjsUpdateWindowState === 'function') {
            globalThis.__pmjsUpdateWindowState(native.runtime.windowState());
          }
          if (typeof globalThis.__pmjsReceiveInput === 'function' &&
              typeof native.input.snapshot === 'function') {
            globalThis.__pmjsReceiveInput(native.input.snapshot());
          }
          const now = performance.now();
          native.beginFrame();
          globalThis.__pmjsTick(now);
          globalThis.__pmjsRender(now);
          native.renderFrame();
          native.swapFrame();
          flushPreparationInvalidations();
          if (!timing.uncapped) {
            const monotonicNow = native.runtime.monotonicNow();
            deadline = advanceDeadline(deadline, monotonicNow, period);
          }
          schedule();
        } catch (error) {
          reject(error);
        }
      }
      schedule();
    });
  } catch (error) {
    try { flushPreparationInvalidations(true); } catch (_) {}
    try { native.runtime.quit(); } catch (_) {}
    throw error;
  }
}

module.exports = { run, validate, progressLines, parseTimingConfig, resolveSwapDefault, advanceDeadline,
  PMJS_MV_LOGIC_HZ, PMJS_SUPPORTED_RENDER_HZ };
