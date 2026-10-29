'use strict';

const hostProcess = process;
const { createSubprocesses } = require('./subprocess.cjs');
const { installPromiseRejectionBridge } = require('./promise-rejections.cjs');
const { reader: portArtifactReader } = require('./port-preparation.cjs');

const { prepareGameAssets } = require('./preparation.cjs');

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { performance } = require('node:perf_hooks');
const { measureStartup } = require('./startup-metrics.cjs');
const { createStorage, createGameFilesystem } = require('./storage.cjs');
const { resolveDefaults, validate, PMJS_MV_LOGIC_HZ, PMJS_SUPPORTED_RENDER_HZ,
  parseTimingConfig, resolveSwapDefault } = require('./config.cjs');
const hostTimers = require('node:timers');
const { createDiagnostics, memoryState } = require('./diagnostics.cjs');
const { createMemoryReclaimer } = require('./memory-reclamation.cjs');

function sendSupervisorHeartbeat(processHandle, heartbeat) {
  if (!processHandle || typeof processHandle.send !== 'function' || !processHandle.connected) return false;
  try { processHandle.send({ type: 'pmjs-heartbeat', heartbeat }, () => {}); return true; }
  catch (_) { return false; }
}

function advanceDeadline(deadline, now, period) {
  let next = deadline + period;
  if (next < now - period) {
    next += Math.floor((now - next) / period) * period;
  }
  return next;
}

function progressClock(milliseconds) {
  const seconds = Math.floor(Math.max(0, milliseconds) / 1000);
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

function stageKeyOf(phase) {
  return typeof phase === 'string' && phase.startsWith('map-') ? 'maps' : 'assets';
}

function stageProgress(current, elapsedMs, stageBaseline) {
  const stage = stageKeyOf(current.phase);
  if (!stageBaseline || stageBaseline.key !== stage) {
    stageBaseline = { key: stage, completed: current.completed || 0, elapsedMs };
  }
  return { baseline: stageBaseline, progress: { ...current, elapsedMs,
    stageElapsedMs: Math.max(0, elapsedMs - stageBaseline.elapsedMs),
    stageCompleted: stageBaseline.completed } };
}

function progressLines(progress) {
  const { phase, source = '', completed = 0, total = 0, generated = 0,
    hits = 0, fallback = 0, elapsedMs = 0, stageElapsedMs, stageCompleted } = progress;
  const mapStage = stageKeyOf(phase) === 'maps';
  const titles = {
    discover: 'Finding game assets', wait: 'Waiting for asset cache',
    validate: 'Checking cached assets', prepare: 'Preparing new assets',
    'audio-view': 'Preparing audio',
    'map-wait': 'Waiting for map cache', 'map-compile': 'Compiling maps',
    'map-pack': 'Packing maps', 'map-validate': 'Checking cached maps',
    ready: 'Checking game assets', install: 'Finishing asset preparation',
    cleanup: 'Finishing asset preparation', complete: 'Assets ready',
    cancelled: 'Asset preparation cancelled', error: 'Continuing with original assets',
  };
  const hasStageBaseline = stageElapsedMs !== undefined && stageCompleted !== undefined;
  const stageDone = hasStageBaseline ? Math.max(0, completed - stageCompleted) : completed;
  const stageTime = hasStageBaseline ? stageElapsedMs : elapsedMs;
  const rate = stageTime > 0 && stageDone > 0 ? stageDone * 1000 / stageTime : null;
  const remaining = Math.max(0, total - completed);
  const working = phase === 'validate' || phase === 'prepare' ||
    phase === 'map-compile' || phase === 'map-pack' || phase === 'map-validate';
  const unit = mapStage ? 'maps/s' : 'files/s';
  const lines = [titles[phase] || (mapStage ? 'Preparing maps' : 'Preparing game assets'),
    phase === 'discover' ? 'Counting files...' :
      `${completed} / ${total} done (${total ? Math.floor(completed * 100 / total) : 100}%)  |  ${remaining} left`,
    source ? `Current file: ${source.replace(/[\r\n\t]/g, ' ')}` : '',
    mapStage ? `Maps: ${generated} new, ${hits} reused  |  Skipped: ${fallback}`
      : `Cache: ${generated} new, ${hits} reused  |  Originals: ${fallback}`,
    `Elapsed: ${progressClock(elapsedMs)}  |  Average: ${rate === null ? 'estimating...' : `${rate.toFixed(1)} ${unit}`}`];
  if (!progress.terminal && total && remaining && rate !== null && stageDone >= 3 &&
      (phase === 'ready' || working)) {
    lines.push(`Estimated time left: ${progressClock(remaining * 1000 / rate)}`);
  } else if (phase === 'prepare') {
    lines.push('Large files can take longer. Original files are preserved.');
  } else if (phase === 'wait' || phase === 'map-wait') {
    lines.push('Another launch is preparing this cache.');
  } else if (phase === 'discover' || phase === 'validate' || phase === 'map-validate') {
    lines.push('Existing prepared assets are reused when unchanged.');
  } else if (phase === 'install' || phase === 'cleanup') {
    lines.push('All files checked; finishing up...');
  }
  return lines;
}

function createPreparationLog(details, { log = message => console.log(message), now = () => performance.now() } = {}) {
  const started = now();
  let updated = started, phaseStarted = started, progressAt = started, finished = false;
  let current = { phase: 'start', source: '', completed: 0, total: 0, generated: 0, hits: 0, fallback: 0 };
  const phases = {};
  const elapsed = value => Math.max(0, value).toFixed(1);
  const emit = (event, fields) => log(`[pmjs] preparation stage=${details.stage} event=${event} ${fields}`);
  emit('start', `started_at=${new Date().toISOString()} codec=${details.codec} ` +
    `verify_hashes=${details.verifyHashes} cache_root=${JSON.stringify(details.cacheRoot)}`);
  function progress(value) {
    if (finished) return;
    const time = now();
    if (['phase', 'source', 'completed', 'generated', 'hits', 'fallback'].some(key => current[key] !== value[key])) progressAt = time;
    if (current.phase !== value.phase) {
      phases[current.phase] = (phases[current.phase] || 0) + time - phaseStarted;
      phaseStarted = time;
      if (!(value.phase in phases) || /^(map-)?(discover|wait|install|publish|cleanup)$/.test(value.phase))
        emit('phase', `phase=${value.phase} elapsed_ms=${elapsed(time - started)} source=${JSON.stringify(value.source || '')}`);
    }
    current = value;
  }
  return {
    progress,
    heartbeat() {
      const time = now();
      if (finished || time - updated < 10000) return;
      updated = time;
      emit('progress', `phase=${current.phase} elapsed_ms=${elapsed(time - started)} ` +
        `phase_elapsed_ms=${elapsed(time - phaseStarted)} no_progress_ms=${elapsed(time - progressAt)} ` +
        `completed=${current.completed || 0} total=${current.total || 0} generated=${current.generated || 0} ` +
        `hits=${current.hits || 0} fallback=${current.fallback || 0} source=${JSON.stringify(current.source || '')}`);
    },
    finish(result, error) {
      if (finished) return;
      finished = true;
      const time = now();
      phases[current.phase] = (phases[current.phase] || 0) + time - phaseStarted;
      const status = error ? 'failed' : result.cancelled ? 'cancelled' : result.error ? 'failed' :
        result.failedFiles || result.installFailures || result.installed < result.prepared ? 'partial' : 'complete';
      const reused = (result.hits || 0) + (result.indexedNegative || 0) + (result.compilationHits || 0);
      const cache = status !== 'complete' ? 'incomplete' : result.generated ? (reused ? 'mixed' : 'cold') :
        (reused ? 'warm' : 'empty');
      emit('finish', `status=${status} cache=${cache} duration_ms=${elapsed(time - started)} ` +
        `codec=${details.codec} verify_hashes=${details.verifyHashes} cache_root=${JSON.stringify(details.cacheRoot)} ` +
        `generated=${result.generated || 0} hits=${result.hits || 0} fallback=${result.fallback ?? result.refused ?? 0} ` +
        `total=${result.total ?? result.maps?.length ?? 0} prepared=${result.prepared ?? result.selected ?? 0} ` +
        `installed=${result.installed || 0} failed_files=${result.failedFiles || 0} install_failures=${result.installFailures || 0} ` +
        `hashed_files=${result.validation?.hashedFiles || 0} ` +
        `hashed_bytes=${result.validation?.hashedBytes || 0} reused_files=${result.validation?.reusedFiles || 0} ` +
        `copied_bytes=${result.validation?.copiedBytes || 0} ` +
        `hash_categories=${JSON.stringify(result.validation?.hashedBytesByCategory || {})} ` +
        `snapshot_bytes=${result.additionalSnapshotBytes || 0} processing_ms=${(result.processingMs || 0).toFixed(1)} ` +
        `early_refusals=${result.earlyRefusals || 0} ` +
        `phase_ms=${JSON.stringify(Object.fromEntries(Object.entries(phases).map(([phase, ms]) => [phase, Number(elapsed(ms))])))} ` +
        `error=${JSON.stringify(error?.message || result.error || '')}`);
    }
  };
}

async function prepareStartupAssets(options, native) {
  const preparationStarted = performance.now();
  console.log(`[pmjs] preparation event=start workspace_bytes=${options.assetPreparation.workspaceBytes} ` +
    `processor=${JSON.stringify(native.assets.preparationVersion || null)} ` +
    `lz4_version=${JSON.stringify(native.assets.preparationLz4Version || null)}`);
  const portableIndex = require('./asset-index.cjs').loadAssetIndex(options.assetIndex, native, options);
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
  let stageBaseline = null;
  const showProgress = () => {
    if (preparationFailed || (cancelled && !current.terminal) ||
        typeof native.runtime.preparationProgress !== 'function') return;
    const elapsedMs = performance.now() - screenStarted;
    // Coalesce file notifications before formatting or crossing into native drawing.
    if (!current.terminal && elapsedMs - screenUpdated < 500) return;
    screenUpdated = elapsedMs;
    const stepped = stageProgress(current, elapsedMs, stageBaseline);
    stageBaseline = stepped.baseline;
    const progress = stepped.progress;
    native.runtime.preparationProgress({ ...progress, lines: progressLines(progress),
      fonts: options.preparationFonts });
  };
  showProgress();
  let activeLog;
  const pump = setInterval(() => {
    if (cancelled) return;
    try {
      if (!native.pollEvents()) cancelled = true;
      activeLog?.heartbeat();
      showProgress();
    } catch (error) { failPreparation(error); }
  }, 16);
  let preparation, preparationStatus = 'failed';
  try {
    const all = await prepareGameAssets({ gameRoot: options.gameRoot,
      sourceRoots: [path.join(options.saveRoot, 'game-files', 'files')],
      cacheRoot: options.assetPreparation.cacheRoot, native,
      ...options.assetPreparation, images: options.assetPreparation.enabled,
      recipes: options.assetPreparation.recipes,
      policyOverrides: options.assetPolicyOverrides,
      portableIndex, portableAssetRoot: portableIndex && path.dirname(options.assetIndex),
      bundleRoot: options.bundleRoot, portDescriptors: options.portDescriptors, adapters: options.preparationAdapters,
      width: options.width, height: options.height, shouldCancel: () => cancelled,
      onProgress: progress => {
        if (progress.phase === 'start') {
          activeLog = createPreparationLog({ stage: progress.stage, codec: options.assetPreparation.pageCodec,
            cacheRoot: options.assetPreparation.cacheRoot, verifyHashes: options.assetPreparation.verifyHashes });
          stageBaseline = null;
        }
        activeLog?.progress(progress); current = progress;
        try { showProgress(); } catch (error) { failPreparation(error); }
      },
      onPhaseComplete: (stage, value) => { if (stage !== 'port') activeLog?.finish(value); }
    });
    const imageResults = all.images || {}, mapResults = all.maps || {};
    const outcomes = all.outcomes || [];
    const refusalReasons = new Map();
    for (const outcome of outcomes) if (outcome.reason)
      refusalReasons.set(outcome.reason, (refusalReasons.get(outcome.reason) || 0) + 1);
    const commonRefusals = [...refusalReasons].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3);
    const cacheOutcomes = all.outcomeCounts || {};
    console.log('[pmjs] preparation summary ' + JSON.stringify({
      images: { discovered: imageResults.total || 0, prepared: imageResults.prepared || 0,
        installed: imageResults.installed || 0, decrypted: imageResults.decrypted || 0,
        storageDecisions: imageResults.storageEntries?.length || 0,
        ordinaryChoices: outcomes.filter(value => value.id.startsWith('image:') && value.outcome === 'ordinary-choice').length,
        failed: (imageResults.failedFiles || 0) + (imageResults.error ? 1 : 0) },
      maps: { discovered: mapResults.total || mapResults.maps?.length || 0, selected: mapResults.selected || 0,
        installed: mapResults.installed || 0, refused: mapResults.refused || 0,
        failed: outcomes.filter(value => value.id.startsWith('map:') && value.outcome === 'ordinary-failure').length },
      cache: { reused: cacheOutcomes['reused-local'] || 0, generated: cacheOutcomes.generated || 0,
        imported: cacheOutcomes['reused-package'] || 0, invalidated: all.invalidated || 0 },
      commonRefusals
    }));
    preparation = { ...(all.images || {}), maps: all.maps, cancelled: all.cancelled,
      inventory: all.inventory, validation: all.validation, releaseCacheLease: all.releaseCacheLease,
      invalidate: all.invalidate };
    options.portArtifacts = Object.fromEntries(all.portArtifacts);
    preparationStatus = preparationFailed ? 'failed' :
      cancelled || preparation.cancelled || preparation.maps?.cancelled ? 'cancelled' :
        preparation.error || preparation.maps?.error ? 'failed' :
          preparation.failedFiles || preparation.installFailures ? 'partial' : 'complete';
  } catch (error) {
    activeLog?.finish({ ...current, cancelled }, preparationFailed ? preparationError : error);
    throw preparationFailed ? preparationError : error;
  } finally {
    clearInterval(pump);
    console.log(`[pmjs] preparation event=finish status=${preparationStatus} duration_ms=${(performance.now() - preparationStarted).toFixed(1)}`);
  }
  if (preparationFailed) throw preparationError;
  return { preparation, cancelled,
    invalidate: preparation.invalidate };
}

async function runSession(input, diagnostics, setNative) {
  const startupStarted = performance.now();
  const options = validate(input);
  diagnostics.stage('startup');
  console.log(`[pmjs] startup event=start started_at=${new Date().toISOString()} ` +
    `preparation=${options.assetPreparation.enabled ? 'on' : 'off'} maps=${options.assetPreparation.maps ? 'on' : 'off'}`);
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
  diagnostics.stage('native-initialize');
  const native = require(options.addon);
  setNative(native);
  measureStartup('native-initialize', () => native.initialize({ gameRoot: options.gameRoot, assetRoot: options.assetRoot,
    width: options.width, height: options.height, windowTitle: options.title,
    ...(options.imageWarmCacheBytes === undefined ? {} :
      { imageWarmCacheBytes: options.imageWarmCacheBytes }),
    preparedFrameCacheBytes: options.preparedFrameCacheBytes,
    preparedCompactSampling: options.preparedCompactSampling,
    preparedCropUploads: options.preparedCropUploads }));
  diagnostics.stage('native-ready');
  const memoryReclaimer = createMemoryReclaimer({ native,
    readMemory: () => memoryState({ processObject: hostProcess }),
    readRss: () => hostProcess.memoryUsage.rss(), now: () => performance.now() });
  const scan = native.runtime.vfsIndexStats?.();
  if (scan) console.log(`[pmjs] startup stage=vfs-index statistics=${JSON.stringify(scan)}`);
  console.log(`[pmjs] startup stage=host-initialized elapsed_ms=${(performance.now() - startupStarted).toFixed(1)}`);
  let pendingInvalidations = 0, retryInvalidationAt = 0;
  let invalidatePreparation;
  let dispatcher;
  let removePromiseRejectionBridge;
  let subprocesses, reloadRequested = false, finishSession;
  let cancelFrameSchedule = () => {};
  const invalidatedMaps = new Set();
  native.assets.invalidateMapCatalog = mapId => {
    const entry = native.assets.preparedMapIndex?.[mapId];
    if (!entry || !invalidatePreparation || invalidatedMaps.has(entry.identity)) return;
    invalidatedMaps.add(entry.identity);
    recordPreparationInvalidation({ source: entry.identity, mapDemand: true }, 'map preparation');
  };
  const pendingInvalidationWrites = new Set();
  function recordPreparationInvalidation(sources, label = 'preparation') {
    if (!invalidatePreparation) return;
    let write;
    write = Promise.resolve().then(() => invalidatePreparation(sources))
      .catch(error => console.warn(`[pmjs] cannot record ${label} failure: ` + error.message))
      .finally(() => pendingInvalidationWrites.delete(write));
    pendingInvalidationWrites.add(write);
  }
  async function drainPreparationInvalidations() {
    while (pendingInvalidationWrites.size)
      await Promise.allSettled([...pendingInvalidationWrites]);
  }
  function flushPreparationInvalidations(force = false) {
    if (typeof native.assets.consumePreparationInvalidations === 'function')
      pendingInvalidations |= native.assets.consumePreparationInvalidations();
    if (!pendingInvalidations || (!force && performance.now() < retryInvalidationAt)) return;
    if (invalidatePreparation && typeof native.assets.consumePreparationFailures === 'function') {
      const failures = native.assets.consumePreparationFailures();
      if (failures.length) recordPreparationInvalidation(failures);
    }
    pendingInvalidations = 0;
    retryInvalidationAt = performance.now() + 1000;
  }
  try {
    native.storage = createStorage(options.saveRoot);
    native.fs = createGameFilesystem(native.fs, path.join(options.saveRoot, 'game-files'));
    if (options.assetPreparation.enabled || options.portDescriptors?.length || options.preparationAdapters?.length) {
      diagnostics.stage('asset-preparation');
      const startup = await prepareStartupAssets(options, native);
      invalidatePreparation = startup.invalidate;
      const { entries, decryptedEntries, releaseCacheLease, invalidateCatalog, ...preparationStats } = startup.preparation;
      if (preparationStats.maps) {
        const { entries: mapEntries, ...mapStats } = preparationStats.maps;
        preparationStats.maps = mapStats;
      }
      native.assets.preparationStats = preparationStats;
      if (startup.cancelled || startup.preparation.cancelled) { native.runtime.quit(); return; }
      memoryReclaimer.atBoundary('startup');
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
    const packageFile = [path.join(options.gameRoot, 'package.json'),
      ...(path.basename(options.gameRoot).toLowerCase() === 'www' ? [path.join(path.dirname(options.gameRoot), 'package.json')] : [])]
      .find(filename => fs.existsSync(filename));
    native.runtime.manifest = packageFile ? JSON.parse(fs.readFileSync(packageFile, 'utf8')) : {};
    native.runtime.arguments = options.guestArguments || [];
    native.runtime.reload = () => {
      if (reloadRequested) return true;
      if (!options.supervised) throw new Error('Session reload requires the runtime supervisor');
      try {
        if (globalThis.pmjsSteam) globalThis.pmjsSteam.flush();
        else if (globalThis.pmjsAchievements && globalThis.pmjsAchievements.initialized) globalThis.pmjsAchievements.flush();
      } catch (error) { console.error('[pmjs] reload blocked by save failure:', error); return false; }
      reloadRequested = true;
      if (dispatcher) dispatcher.stop();
      native.runtime.quit();
      if (finishSession) finishSession();
      return true;
    };
    subprocesses = createSubprocesses({ tasks: () => globalThis.PMJS.tasks,
      resolveDirectory: directory => {
        const virtual = path.posix.resolve('/game', String(directory).replace(/\\/g, '/'));
        const storage = virtual === '/save' || virtual.startsWith('/save/');
        const host = storage ? native.storage : native.fs;
        const relative = virtual === '/save' || virtual === '/game' ? '.' :
          storage ? virtual.slice(6) : virtual.startsWith('/game/') ? virtual.slice(6) : null;
        if (relative === null) throw new Error('working directory is outside the virtual filesystem');
        const physical = host.resolvePath(relative);
        if (physical === null) throw Object.assign(new Error('working directory does not exist'), { code: 'ENOENT' });
        return physical;
      }, openExternal: url => native.runtime.openExternal(url) });
    native.runtime.childProcess = subprocesses.api;
    // Guest adapters may request only declared, validated port assets.
    native.assets.portArtifact = portArtifactReader(options.portArtifacts || {},
      native.assets.decompressPortArtifact);
    const hostSetTimeout = hostTimers.setTimeout;
    const hostSetImmediate = hostTimers.setImmediate;
    native.runtime.scheduling = { ...hostTimers, nextTick: hostProcess.nextTick.bind(hostProcess) };
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
    if (!native.pollEvents()) { native.runtime.quit(); return; }
    // Preparation input belongs to the host screen, not the guest's first step.
    native.input.snapshot();
    native.input.consumePressed();
    diagnostics.stage('bootstrap');
    try {
      vm.runInThisContext(fs.readFileSync(options.bootstrap, 'utf8'), {
        filename: options.bootstrap, displayErrors: true,
      });
    } finally {
      dispatcher = globalThis.PMJS && globalThis.PMJS.tasks;
    }
    if (typeof globalThis.__pmjsTick !== 'function' ||
        typeof globalThis.__pmjsRender !== 'function') {
      throw new Error('bootstrap did not install __pmjsTick and __pmjsRender');
    }
    removePromiseRejectionBridge = installPromiseRejectionBridge(hostProcess, {
      getTasks: () => dispatcher,
      reportUnhandled: (reason, promise, origin) => {
        if (typeof globalThis.pmjsReportUnhandledPromiseRejection !== 'function') throw reason;
        globalThis.pmjsReportUnhandledPromiseRejection(reason, promise, origin);
      },
      reportHandled: (promise, origin) => {
        if (typeof globalThis.pmjsReportHandledPromiseRejection !== 'function') return;
        globalThis.pmjsReportHandledPromiseRejection(promise, origin);
      }
    });

    if (reloadRequested) return { reload: true };
    const period = timing.renderPeriod;
    let deadline = timing.uncapped ? 0 : native.runtime.monotonicNow() + period;
    console.log(`[pmjs] timing logic_hz=${timing.logicHz} ` +
      (timing.uncapped ? 'render_hz=uncapped' : `render_hz=${timing.renderHz}`));
    diagnostics.stage('playing');
    console.log(`[pmjs] ready size=${options.width}x${options.height} startup_ms=${(performance.now() - startupStarted).toFixed(1)}`);
    let diagnosticsFrameIndex = 0;
    await new Promise((resolve, reject) => {
      finishSession = resolve;
      native.runtime.scheduling.onFatal = reject;
      let frameHandle, immediateFrame = false, previousFullscreen;
      cancelFrameSchedule = () => {
        if (immediateFrame) hostTimers.clearImmediate(frameHandle);
        else hostTimers.clearTimeout(frameHandle);
        frameHandle = undefined;
      };
      function schedule() {
        if (dispatcher && dispatcher.stopped) return;
        if (timing.uncapped) { immediateFrame = true; frameHandle = hostSetImmediate(tick); return; }
        const delay = Math.max(0, deadline - native.runtime.monotonicNow());
        immediateFrame = delay < 1;
        frameHandle = immediateFrame ? hostSetImmediate(tick) : hostSetTimeout(tick, delay);
      }
      function tick() {
        frameHandle = undefined;
        if (dispatcher && dispatcher.stopped) return;
        try {
          flushPreparationInvalidations();
          if (!native.pollEvents()) { flushPreparationInvalidations(true); resolve(); return; }
          let windowState;
          if (typeof globalThis.__pmjsUpdateWindowState === 'function') {
            windowState = native.runtime.windowState();
            globalThis.__pmjsUpdateWindowState(windowState);
          }
          if (typeof native.runtime.windowEvents === 'function' && globalThis.__pmjsDispatchWindowEvents) {
            const events = native.runtime.windowEvents();
            if (events.length || !windowState || windowState.fullscreen !== previousFullscreen) {
              if (dispatcher) dispatcher.enqueue(() => globalThis.__pmjsDispatchWindowEvents(events), { errorMode: 'event' });
              else globalThis.__pmjsDispatchWindowEvents(events);
            }
            previousFullscreen = windowState && windowState.fullscreen;
          }
          if (typeof globalThis.__pmjsReceiveInput === 'function' &&
              typeof native.input.snapshot === 'function') {
            globalThis.__pmjsReceiveInput(native.input.snapshot());
          }
          const now = performance.now();
          const frame = () => {
            native.beginFrame();
            return Promise.resolve(globalThis.__pmjsTick(now)).then(() => {
              if (dispatcher && dispatcher.stopped) return;
              globalThis.__pmjsRender(now);
              native.renderFrame();
              if (globalThis.__pmjsAfterPresent) globalThis.__pmjsAfterPresent();
              native.swapFrame();
              flushPreparationInvalidations();
            });
          };
          const complete = dispatcher ? dispatcher.runFrame(frame) : frame();
          complete.then(() => {
            if (memoryReclaimer.pending && typeof globalThis.__pmjsMemoryReclamationBoundary === 'function') {
              memoryReclaimer.atBoundary(globalThis.__pmjsMemoryReclamationBoundary());
            }
            // Sample one in eight frames: no extra clock read on the other seven.
            if ((++diagnosticsFrameIndex & 7) === 0) {
              const observedAt = performance.now();
              diagnostics.observeFrame(observedAt - now, observedAt);
              memoryReclaimer.observe(diagnostics.snapshot().memory);
            }
            if (!timing.uncapped) {
              deadline = advanceDeadline(deadline, native.runtime.monotonicNow(), period);
            }
            schedule();
          }, reject);
        } catch (error) {
          reject(error);
        }
      }
      schedule();
    });
    flushPreparationInvalidations(true);
    await drainPreparationInvalidations();
    if (globalThis.pmjsSteam) globalThis.pmjsSteam.flush();
    else if (globalThis.pmjsAchievements && globalThis.pmjsAchievements.initialized) globalThis.pmjsAchievements.flush();
    return { reload: reloadRequested };
  } catch (error) {
    try { flushPreparationInvalidations(true); } catch (_) {}
    try { native.runtime.quit(); } catch (_) {}
    throw error;
  } finally {
    if (removePromiseRejectionBridge) removePromiseRejectionBridge();
    cancelFrameSchedule();
    if (dispatcher) dispatcher.stop();
    if (subprocesses) await subprocesses.stop();
    try { flushPreparationInvalidations(true); } catch (_) {}
    await drainPreparationInvalidations();
  }
}

// A separate wrapper covers failures before native initialization's inner try/finally.
async function run(input, hooks = {}) {
  // Shared scene walks encounter many display-object subclass shapes.
  const v8 = require('node:v8');
  v8.setFlagsFromString('--max-valid-polymorphic-map-count=128');
  console.log('[pmjs] v8 polymorphic_maps=128 cached_data_tag=' + v8.cachedDataVersionTag());
  let runtimeNative = null;
  const diagnostics = createDiagnostics({ getNative: () => runtimeNative,
    onHeartbeat: heartbeat => {
      sendSupervisorHeartbeat(hostProcess, heartbeat);
    } });
  if (typeof hooks.onMemorySnapshot === 'function') {
    hooks.onMemorySnapshot(request => diagnostics.supervisorMemorySnapshot(request));
  }
  diagnostics.start();
  try {
    return await runSession(input, diagnostics, native => { runtimeNative = native; });
  } catch (error) {
    diagnostics.report('fatal-error', error);
    throw error;
  } finally {
    diagnostics.stop();
    if (typeof hooks.onMemorySnapshot === 'function') hooks.onMemorySnapshot(null);
  }
}

module.exports = { run, createPreparationLog, validate, resolveDefaults, progressLines, stageProgress, stageKeyOf, parseTimingConfig, resolveSwapDefault, advanceDeadline,
  sendSupervisorHeartbeat, PMJS_MV_LOGIC_HZ, PMJS_SUPPORTED_RENDER_HZ };
