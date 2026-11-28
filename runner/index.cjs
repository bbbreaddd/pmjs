'use strict';

const hostProcess = process;
const hostCollectGarbage = globalThis.gc;
const { createSubprocesses } = require('./subprocess.cjs');
const { installPromiseRejectionBridge } = require('./promise-rejections.cjs');
const { reader: portArtifactReader } = require('./port-preparation.cjs');

const { prepareGameAssets, summarizePreparation } = require('./preparation.cjs');
const { prepareGameFiles } = require('./game-preparation.cjs');

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { performance } = require('node:perf_hooks');
const { measureStartup } = require('./startup-metrics.cjs');
const { createStorage, createGameFilesystem } = require('./storage.cjs');
const { resolveDefaults, validate, PMJS_MV_LOGIC_HZ, PMJS_SUPPORTED_RENDER_HZ,
  parseTimingConfig, resolveSwapDefault } = require('./config.cjs');
const hostTimers = require('node:timers');
const { createDiagnostics, reclamationMemoryState } = require('./diagnostics.cjs');
const { createMemoryReclaimer } = require('./memory-reclamation.cjs');
const { createSettings, createInputFilter } = require('./settings.cjs');
const { createFpsCounter } = require('./fps-counter.cjs');

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

const RATE_WINDOW_MS = 10000;
const MAX_RATE_WINDOW_MS = 30000;

function stageKeyOf(phase) {
  return typeof phase === 'string' && phase.startsWith('map-') ? 'maps' : 'assets';
}

function rateBucketOf(phase) {
  if (phase === 'audio-view' || phase === 'audio-index') return 'audio';
  if (phase === 'validate' || phase === 'prepare' || phase === 'ready') return 'images';
  if (phase === 'map-validate' || phase === 'map-compile' || phase === 'map-pack') return 'maps';
  return null;
}

function stageProgress(current, elapsedMs, stageBaseline) {
  const stage = stageKeyOf(current.phase);
  const bucket = rateBucketOf(current.phase);
  const workDone = current.workTotal > 0
    ? (current.workCompleted ?? 0)
    : (current.completed || 0);
  if (!bucket) {
    if (stageBaseline && stageBaseline.stage !== stage) stageBaseline = null;
    return {
      baseline: stageBaseline,
      progress: {
        ...current,
        elapsedMs,
        ...(stageBaseline ? {
          stageElapsedMs: Math.max(0, elapsedMs - stageBaseline.startedMs),
          stageCompleted: stageBaseline.startedCompleted,
          recentRate: stageBaseline.lastRate ?? null
        } : {})
      }
    };
  }
  if (!stageBaseline || stageBaseline.bucket !== bucket) {
    stageBaseline = {
      stage,
      bucket,
      startedMs: elapsedMs,
      startedCompleted: workDone,
      samples: [{ elapsedMs, completed: workDone }],
      lastRate: null
    };
  } else {
    const samples = stageBaseline.samples;
    const last = samples[samples.length - 1];
    if (elapsedMs > last.elapsedMs) {
      samples.push({ elapsedMs, completed: workDone });
    } else {
      last.completed = Math.max(last.completed, workDone);
    }
    const cutoff = elapsedMs - RATE_WINDOW_MS;
    const maxCutoff = elapsedMs - MAX_RATE_WINDOW_MS;
    while (samples.length > 2 && samples[1].elapsedMs <= cutoff &&
           (workDone > samples[1].completed || samples[0].elapsedMs < maxCutoff)) {
      samples.shift();
    }
  }
  const anchor = stageBaseline.samples[0];
  const windowDone = Math.max(0, workDone - anchor.completed);
  const windowTime = Math.max(0, elapsedMs - anchor.elapsedMs);
  const recentRate = windowTime > 0 && windowDone > 0 ? windowDone * 1000 / windowTime : null;
  stageBaseline.lastRate = recentRate;
  return {
    baseline: stageBaseline,
    progress: {
      ...current,
      elapsedMs,
      stageElapsedMs: Math.max(0, elapsedMs - stageBaseline.startedMs),
      stageCompleted: stageBaseline.startedCompleted,
      recentRate
    }
  };
}

function progressLines(progress) {
  const { phase, stage, source = '', completed = 0, total = 0, generated = 0,
    hits = 0, fallback = 0, elapsedMs = 0, stageElapsedMs, stageCompleted,
    workCompleted, workTotal, stageIndex, stageCount, overallCompleted, overallTotal, recentRate } = progress;
  const mapStage = stage === 'maps' || stageKeyOf(phase) === 'maps';
  const titles = {
    discover: 'Finding game assets', wait: 'Waiting for asset cache',
    validate: 'Checking cached assets', prepare: 'Preparing new assets',
    'audio-view': 'Preparing audio',
    'map-discover': 'Finding maps',
    'map-wait': 'Waiting for map cache', 'map-compile': 'Compiling maps',
    'map-pack': 'Packing maps', 'map-validate': 'Checking cached maps',
    ready: 'Checking game assets', install: 'Finishing asset preparation',
    cleanup: 'Finishing asset preparation', complete: 'Assets ready',
    cancelled: 'Asset preparation cancelled', error: 'Continuing with original assets',
  };
  const useWorkCounts = workTotal > 0;
  const stageDone = useWorkCounts ? (workCompleted ?? 0) : completed;
  const stageTotal = useWorkCounts ? workTotal : total;
  const remaining = Math.max(0, stageTotal - stageDone);
  const hasOverall = stageCount > 1 && overallTotal > 0;
  const barDone = hasOverall ? (overallCompleted || 0) : stageDone;
  const barTotal = hasOverall ? overallTotal : stageTotal;
  const pct = barTotal > 0 ? Math.floor(barDone * 100 / barTotal) : (progress.terminal && phase === 'complete' ? 100 : 0);

  const hasStageBaseline = stageElapsedMs !== undefined && stageCompleted !== undefined;
  const rateDone = hasStageBaseline ? Math.max(0, stageDone - stageCompleted) : stageDone;
  const stageTime = hasStageBaseline ? stageElapsedMs : elapsedMs;
  const rate = recentRate !== undefined
    ? recentRate
    : (stageTime > 0 && rateDone > 0 ? rateDone * 1000 / stageTime : null);

  const working = phase === 'validate' || phase === 'prepare' ||
    phase === 'map-compile' || phase === 'map-pack' || phase === 'map-validate';
  const unit = mapStage ? 'maps/s' : 'files/s';
  let statusLine;
  if (phase === 'discover' || phase === 'start') {
    statusLine = mapStage ? 'Counting maps...' : 'Counting files...';
  } else if (phase === 'map-discover') {
    statusLine = 'Counting maps...';
  } else if (phase === 'audio-view' || phase === 'audio-index') {
    statusLine = hasOverall
      ? `Audio: ${completed} files  |  Overall: ${pct}%`
      : `${completed} / ${total} audio files`;
  } else if (hasOverall) {
    statusLine = `${mapStage ? 'Maps' : 'Assets'} (${stageIndex}/${stageCount}): ${stageDone} / ${stageTotal} (${remaining} left)  |  Overall: ${pct}%`;
  } else {
    statusLine = `${stageDone} / ${stageTotal} done (${pct}%)  |  ${remaining} left`;
  }
  const lines = [titles[phase] || (mapStage ? 'Preparing maps' : 'Preparing game assets'),
    statusLine,
    source ? `Current file: ${source.replace(/[\r\n\t]/g, ' ')}` : '',
    mapStage ? `Maps: ${generated} new, ${hits} reused  |  Skipped: ${fallback}`
      : `Cache: ${generated} new, ${hits} reused  |  Originals: ${fallback}`,
    `Elapsed: ${progressClock(elapsedMs)}  |  Speed: ${rate === null ? 'estimating...' : `${rate.toFixed(1)} ${unit}`}`];
  if (!progress.terminal && stageTotal && remaining && rate !== null && rateDone >= 3 &&
      (phase === 'ready' || working)) {
    lines.push(`Estimated time left: ${progressClock(remaining * 1000 / rate)}`);
  } else if (phase === 'prepare') {
    lines.push('Large files can take longer. Original files are preserved.');
  } else if (phase === 'wait' || phase === 'map-wait') {
    lines.push('Another launch is preparing this cache.');
  } else if (phase === 'discover' || phase === 'map-discover' || phase === 'validate' || phase === 'map-validate') {
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

async function prepareStartupAssets(options, native, settings) {
  const preparationStarted = performance.now();
  console.log(`[pmjs] preparation event=start workspace_bytes=${options.assetPreparation.workspaceBytes} ` +
    `processor=${JSON.stringify(native.assets.preparationVersion || null)} ` +
    `lz4_version=${JSON.stringify(native.assets.preparationLz4Version || null)}`);
  const { readAssetIndex, loadAssetIndex } = require('./asset-index.cjs');
  const { startupFiles } = require('./startup-files.cjs');
  const { loadCatalog, rebuildMarker } = require('./preparation-catalog.cjs');
  const saveFilesRoot = path.join(options.saveRoot, 'game-files', 'files');
  const sourceRoots = [...(options.preparedGameRoots || [])];
  if (fs.existsSync(saveFilesRoot)) sourceRoots.push(saveFilesRoot);
  const rebuildRequest = native.storage.readText(rebuildMarker);
  let indexReceipts = null;
  let portableIndexIdentity = null;
  if (options.assetIndex) {
    try {
      const stat = fs.statSync(options.assetIndex, { bigint: true });
      if (stat.isFile() && stat.size <= 64n * 1024n * 1024n) {
        indexReceipts = startupFiles(
          path.join(options.assetPreparation.cacheRoot, 'asset-index-receipt.json'),
          1,
          Boolean(rebuildRequest)
        );
        portableIndexIdentity = { loader: 1, sha256: indexReceipts.hash(options.assetIndex) };
      }
    } catch { /* Missing or unreadable portable index; readAssetIndex handles fallback. */ }
  }
  const preparationOptions = { gameRoot: options.gameRoot,
    virtualFiles: options.virtualFiles,
    sourceRoots,
    cacheRoot: options.assetPreparation.cacheRoot, native, ...options.assetPreparation,
    images: options.assetPreparation.enabled, recipes: options.assetPreparation.recipes,
    policyOverrides: options.assetPolicyOverrides, portableIndex: null,
    portableIndexIdentity,
    portableAssetRoot: portableIndexIdentity && path.dirname(options.assetIndex),
    bundleRoot: options.bundleRoot, portDescriptors: options.portDescriptors, adapters: options.preparationAdapters,
    width: options.width, height: options.height, fastStartup: true };
  if (rebuildRequest) { preparationOptions.verifyHashes = true; preparationOptions.forceRebuild = true; }
  if (!rebuildRequest) {
    const cached = await loadCatalog(preparationOptions);
    if (cached) {
      try { indexReceipts?.save(); } catch {}
      options.portArtifacts = Object.fromEntries(cached.portArtifacts);
      options.portArtifactHashes = cached.portArtifactHashes;
      console.log('[pmjs] using completed asset preparation catalog');
      return { preparation: summarizePreparation({ ...cached.images, maps: cached.maps }),
        cancelled: false, invalidate: cached.invalidate,
        invalidateCatalog: cached.invalidateCatalog };
    }
  }
  let indexed = readAssetIndex(options.assetIndex);
  try { indexReceipts?.save(); } catch {}
  preparationOptions.portableIndexIdentity = indexed?.identity || null;
  preparationOptions.portableAssetRoot = indexed ? path.dirname(options.assetIndex) : null;
  preparationOptions.portableIndex = indexed ? loadAssetIndex(options.assetIndex, native, options, indexed.contents) : null;
  indexed = null;
  if (!preparationOptions.portableIndex) preparationOptions.portableAssetRoot = null;
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
  let menuVisible = false;
  const showProgress = (present = true, force = false) => {
    if (preparationFailed || (cancelled && !current.terminal) ||
        typeof native.runtime.preparationProgress !== 'function') return;
    const elapsedMs = performance.now() - screenStarted;
    // Coalesce file notifications before formatting or crossing into native drawing.
    if (!force && !current.terminal && elapsedMs - screenUpdated < 500) return;
    screenUpdated = elapsedMs;
    const stepped = stageProgress(current, elapsedMs, stageBaseline);
    stageBaseline = stepped.baseline;
    const progress = stepped.progress;
    const hasOverall = progress.stageCount > 1 && progress.overallTotal > 0;
    const barCompleted = hasOverall ? (progress.overallCompleted || 0)
      : (progress.workTotal > 0 ? (progress.workCompleted ?? 0) : (progress.completed || 0));
    const barTotal = hasOverall ? progress.overallTotal
      : (progress.workTotal > 0 ? progress.workTotal : (progress.total || 0));
    native.runtime.preparationProgress({ ...progress, completed: barCompleted, total: barTotal,
      force, present, lines: progressLines(progress), fonts: options.preparationFonts });
  };
  showProgress();
  let activeLog;
  const pump = setInterval(() => {
    if (cancelled) return;
    try {
      if (!native.pollEvents()) {
        cancelled = true;
        return;
      }
      if (settings) {
        settings.update(native.input.snapshot());
        native.input.consumePressed();
        if (!settings.isOpen() && menuVisible) {
          settings.hide(); menuVisible = false;
          showProgress(true, true);
          return;
        }
        if (settings.isOpen()) {
          if (performance.now() - screenStarted - screenUpdated < 100) return;
          showProgress(false, true);
          settings.draw();
          menuVisible = true;
          native.renderFrame();
          native.swapFrame();
          return;
        }
      }
      activeLog?.heartbeat();
      showProgress();
    } catch (error) { failPreparation(error); }
  }, 16);
  let preparation, invalidate, invalidateCatalog, preparationStatus = 'failed', preparationThrew = false;
  try {
    const all = await prepareGameAssets({ ...preparationOptions, shouldCancel: () => cancelled,
      onProgress: progress => {
        if (progress.phase === 'start') {
          activeLog = createPreparationLog({ stage: progress.stage, codec: options.assetPreparation.pageCodec,
            cacheRoot: options.assetPreparation.cacheRoot, verifyHashes: options.assetPreparation.verifyHashes });
          stageBaseline = null;
        }
        activeLog?.progress(progress); current = progress;
        try { if (!settings?.isOpen()) showProgress(); } catch (error) { failPreparation(error); }
      },
      onPhaseComplete: (stage, value) => { if (stage !== 'port') activeLog?.finish(value); }
    });
    if (all.catalogSaved && rebuildRequest && native.storage.readText(rebuildMarker) === rebuildRequest) {
      try { native.storage.remove(rebuildMarker); }
      catch (error) { console.warn('[pmjs] cannot clear asset rebuild request: ' + error.message); }
    }
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
    preparation = summarizePreparation({ ...(all.images || {}), maps: all.maps, cancelled: all.cancelled,
      inventory: all.inventory, validation: all.validation });
    invalidate = all.invalidate;
    options.portArtifacts = Object.fromEntries(all.portArtifacts);
    options.portArtifactHashes = all.portArtifactHashes || {};
    invalidateCatalog = all.invalidateCatalog;
    preparationStatus = preparationFailed ? 'failed' :
      cancelled || preparation.cancelled || preparation.maps?.cancelled ? 'cancelled' :
        preparation.error || preparation.maps?.error ? 'failed' :
          preparation.failedFiles || preparation.installFailures ? 'partial' : 'complete';
  } catch (error) {
    preparationThrew = true;
    activeLog?.finish({ ...current, cancelled }, preparationFailed ? preparationError : error);
    throw preparationFailed ? preparationError : error;
  } finally {
    clearInterval(pump);
    try {
      if (typeof native.runtime.preparationClear === 'function') native.runtime.preparationClear();
    } catch (error) {
      if (!preparationThrew && !preparationFailed) throw error;
      console.warn('[pmjs] preparation cleanup failed:', error.message);
    }
    console.log(`[pmjs] preparation event=finish status=${preparationStatus} duration_ms=${(performance.now() - preparationStarted).toFixed(1)}`);
  }
  if (preparationFailed) throw preparationError;
  return { preparation, cancelled,
    invalidate, invalidateCatalog };
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
  const defaultRenderHz = timing.renderHz;
  function setRenderLimit(limit) {
    const hz = limit === null ? defaultRenderHz : limit;
    if (hz === timing.renderHz) return false;
    timing.renderHz = hz;
    timing.uncapped = hz === 0;
    timing.renderPeriod = hz === 0 ? Infinity : 1000 / hz;
    if (globalThis.__pmjsTimingConfig) globalThis.__pmjsTimingConfig.renderHz = hz;
    return true;
  }
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
    programCacheRoot: path.join(options.assetPreparation.cacheRoot, 'programs'),
    ...(options.imageWarmCacheBytes === undefined ? {} :
      { imageWarmCacheBytes: options.imageWarmCacheBytes }),
    preparedPageSplitThresholdBytes: options.preparedPageSplitThresholdBytes,
    imagePalettization: options.imagePalettization,
    preparedCompactSampling: options.preparedCompactSampling,
    preparedCropUploads: options.preparedCropUploads }));
  diagnostics.stage('native-ready');
  const memoryReclaimer = createMemoryReclaimer({ native,
    readMemory: () => reclamationMemoryState({ processObject: hostProcess }),
    now: () => performance.now(),
    collectGarbage: hostCollectGarbage });
  const scan = native.runtime.vfsIndexStats?.();
  if (scan) console.log(`[pmjs] startup stage=vfs-index statistics=${JSON.stringify(scan)}`);
  console.log(`[pmjs] startup stage=host-initialized elapsed_ms=${(performance.now() - startupStarted).toFixed(1)}`);
  let pendingInvalidations = 0, retryInvalidationAt = 0;
  let invalidatePreparation, invalidatePreparationCatalog;
  let dispatcher, settings, fpsCounter;
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
    console.warn('[pmjs] preparation invalidation queued');
    if (invalidatePreparationCatalog) {
      let write;
      write = Promise.resolve().then(() => invalidatePreparationCatalog())
        .catch(error => console.warn('[pmjs] cannot invalidate preparation catalog: ' + error.message))
        .finally(() => pendingInvalidationWrites.delete(write));
      pendingInvalidationWrites.add(write);
    }
    if (invalidatePreparation && typeof native.assets.consumePreparationFailures === 'function') {
      const failures = native.assets.consumePreparationFailures();
      if (failures.length) recordPreparationInvalidation(failures);
    }
    pendingInvalidations = 0;
    retryInvalidationAt = performance.now() + 1000;
  }
  try {
    native.storage = createStorage(options.saveRoot);
    settings = createSettings({ native,
      fonts: options.preparationFonts, storage: native.storage, width: options.width, height: options.height });
    native.fs = createGameFilesystem(native.fs, path.join(options.saveRoot, 'game-files'));
    options.preparedGameRoots = prepareGameFiles(options, native);
    if (options.assetPreparation.enabled || options.portDescriptors?.length || options.preparationAdapters?.length) {
      diagnostics.stage('asset-preparation');
      const startup = await prepareStartupAssets(options, native, settings);
      invalidatePreparation = startup.invalidate;
      invalidatePreparationCatalog = startup.invalidateCatalog;
      native.assets.preparationStats = startup.preparation;
      if (startup.cancelled || startup.preparation.cancelled) { native.runtime.quit(); return; }
      await memoryReclaimer.atBoundary('startup');
    } else if (native.assets && typeof native.assets.installPrepared === 'function') {
      native.assets.installPrepared([]);
      if (native.assets.installDecrypted) native.assets.installDecrypted([]);
    }
    native.runtime.refreshAssets = async roots => {
      options.preparedGameRoots = roots;
      const startup = await prepareStartupAssets(options, native, settings);
      invalidatePreparation = startup.invalidate;
      invalidatePreparationCatalog = startup.invalidateCatalog;
      native.assets.preparationStats = startup.preparation;
      if (startup.cancelled || startup.preparation.cancelled) throw new Error('asset preparation cancelled');
    };
    native.assets.mapPreparationEnabled = options.assetPreparation.maps;
    console.log(`[pmjs] map preparation=${options.assetPreparation.maps ? "on" : "off"}`);
    native.runtime.now = () => performance.now();
    native.runtime.platform = () => ({ platform: process.platform, arch: process.arch });
    function executeScript(source, filename) {
      const evaluate = () => vm.runInThisContext(source, { filename });
      const tasks = globalThis.PMJS && globalThis.PMJS.tasks;
      return tasks ? tasks.runGuest('browser', evaluate) : evaluate();
    }
    native.runtime.loadScript = (relative, transformSource) => {
      let source = native.runtime.readGameScript ? native.runtime.readGameScript(relative) : native.fs.readText(relative);
      if (source === null) throw new Error(`cannot load script: ${relative}`);
      if (transformSource) source = transformSource(source);
      return executeScript(source, path.join(options.gameRoot, relative));
    };
    native.runtime.runScript = source => executeScript(String(source), 'inline-script.js');
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
      native.assets.decompressPortArtifact, { hashes: options.portArtifactHashes || {},
        onInvalid: id => recordPreparationInvalidation(id, 'prepared artifact') });
    const hostSetTimeout = hostTimers.setTimeout;
    const hostSetImmediate = hostTimers.setImmediate;
    native.runtime.scheduling = { ...hostTimers, nextTick: hostProcess.nextTick.bind(hostProcess) };
    const physicalDisplay = (native.runtime && typeof native.runtime.displaySize === 'function')
      ? native.runtime.displaySize()
      : {
          width: Number(process.env.PMJS_SCREEN_WIDTH || 640),
          height: Number(process.env.PMJS_SCREEN_HEIGHT || 480)
        };
    function hostFilesystem(service) {
      const methods = new Map();
      for (const name of Reflect.ownKeys(service)) {
        const value = Reflect.get(service, name);
        if (typeof value !== 'function' || methods.has(value)) continue;
        methods.set(value, function(...args) {
          const tasks = globalThis.PMJS && globalThis.PMJS.tasks;
          return tasks ? tasks.runHost(value, service, args) : value.apply(service, args);
        });
      }
      return new Proxy(service, {
        get(target, name) {
          const value = Reflect.get(target, name);
          // Guest replacements must keep their identity for guarded restoration.
          return methods.get(value) || value;
        }
      });
    }
    globalThis.NativeHost = { runtime: native.runtime, render: native.render,
      plugins: native.plugins, mv: native.mv, compression: native.compression,
      scene: native.scene, images: native.images, assets: native.assets, fs: hostFilesystem(native.fs),
      storage: hostFilesystem(native.storage), input: native.input, canvas: native.canvas,
      media: native.media, dialog: native.dialog, effects: native.effects,
      greenworks };
    globalThis.__pmjsBuiltinRequire = require;
    globalThis.__pmjsNativeRuntime = true;
    setRenderLimit(settings.frameRate());
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

    let startupError;
    if (globalThis.__pmjsStartup) globalThis.__pmjsStartup.catch(error => { startupError = error; });
    if (reloadRequested) return { reload: true };
    let deadline = timing.uncapped ? 0 : native.runtime.monotonicNow() + timing.renderPeriod;
    console.log(`[pmjs] timing logic_hz=${timing.logicHz} ` +
      (timing.uncapped ? 'render_hz=uncapped' : `render_hz=${timing.renderHz}`));
    diagnostics.stage('playing');
    console.log(`[pmjs] ready size=${options.width}x${options.height} startup_ms=${(performance.now() - startupStarted).toFixed(1)}`);
    fpsCounter = createFpsCounter(native);
    let diagnosticsFrameIndex = 0;
    const filterInput = createInputFilter();
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
          if (startupError) throw startupError;
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
          const now = performance.now();
          const input = native.input.snapshot();
          const captured = settings.update(input);
          if (setRenderLimit(settings.frameRate()))
            deadline = timing.uncapped ? 0 : native.runtime.monotonicNow();
          if (captured) native.input.consumePressed();
          if (typeof globalThis.__pmjsReceiveInput === 'function')
            globalThis.__pmjsReceiveInput(filterInput(input, captured));
          const frame = () => {
            native.beginFrame();
            return Promise.resolve(globalThis.__pmjsTick(now)).then(() => {
              if (dispatcher && dispatcher.stopped) return;
              globalThis.__pmjsRender(now);
              if (settings.isOpen()) settings.draw();
              else if (settings.isVisible()) settings.hide();
              native.renderFrame();
              if (globalThis.__pmjsAfterPresent) globalThis.__pmjsAfterPresent();
              native.swapFrame();
              fpsCounter.frame(settings.fpsCounter(), native.runtime.monotonicNow());
              flushPreparationInvalidations();
            });
          };
          const complete = dispatcher ? dispatcher.runFrame(frame) : frame();
          complete.then(async () => {
            if (memoryReclaimer.pending) {
              // Engines without a boundary hook still get the critical-pressure trim.
              await memoryReclaimer.atBoundary(typeof globalThis.__pmjsMemoryReclamationBoundary === 'function' ?
                globalThis.__pmjsMemoryReclamationBoundary() : null);
            }
            // Sample one in eight frames: no extra clock read on the other seven.
            if ((++diagnosticsFrameIndex & 7) === 0) {
              const observedAt = performance.now();
              diagnostics.observeFrame(observedAt - now, observedAt);
              memoryReclaimer.poll(observedAt);
            }
            if (!timing.uncapped) {
              deadline = advanceDeadline(deadline, native.runtime.monotonicNow(), timing.renderPeriod);
            }
            schedule();
          }).catch(reject);
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
    if (fpsCounter) fpsCounter.dispose();
    if (settings) await settings.waitForSave();
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

module.exports = { run, prepareStartupAssets, createPreparationLog, validate, resolveDefaults, progressLines, stageProgress, stageKeyOf, parseTimingConfig, resolveSwapDefault, advanceDeadline,
  sendSupervisorHeartbeat, PMJS_MV_LOGIC_HZ, PMJS_SUPPORTED_RENDER_HZ };
