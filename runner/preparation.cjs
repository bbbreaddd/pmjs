'use strict';

const path = require('node:path');
const { openPreparation, inventory, createInvalidators } = require('./preparation-state.cjs');
const { prepareAssetsPhase } = require('./asset-preparation.cjs');
const { prepareMapsPhase } = require('./map-preparation.cjs');
const { prepareForRun } = require('./port-preparation.cjs');

async function prepareGameAssets(options) {
  const { native, logger = console, shouldCancel = () => false,
    onProgress = () => {}, preparationContext = 'live' } = options;
  let session;
  try { session = await openPreparation({ ...options, offline: preparationContext === 'offline' }); }
  catch (error) {
    logger.warn('[pmjs] preparation unavailable: ' + error.message);
    const discovered = await inventory(options.gameRoot, native, path.resolve(options.cacheRoot)).catch(() => []);
    const total = discovered.filter(source => /^(img\/.+\.(png|png_|rpgmvp)|audio\/.+\.(ogg_|m4a_|rpgmvo|rpgmvm))$/i.test(source)).length;
    const images = { error: error.message, entries: [], decryptedEntries: [], installed: 0, prepared: 0,
      generated: 0, hits: 0, fallback: 0, failedFiles: 0, total, completed: 0, sourceBytes: 0, durationMs: 0 };
    onProgress({ ...images, stage: 'images', phase: 'discover', source: '', remaining: total, elapsedMs: 0 });
    onProgress({ ...images, stage: 'images', phase: 'error', source: '', remaining: total, elapsedMs: 0, terminal: true });
    return { portArtifacts: new Map(), images };
  }
  if (!session) return { cancelled: true, images: { cancelled: true }, portArtifacts: new Map() };
  const result = { cancelled: false, root: session.root, portArtifacts: new Map() };
  const phase = async (name, run) => {
    session.startPhase(name);
    onProgress({ stage: name, phase: 'start', source: '', completed: 0, total: 0 });
    let value;
    try {
      for (let attempt = 0; attempt < 2; ++attempt) {
        value = await run(progress => onProgress({ ...progress, stage: name }));
        const rejected = value?.activation?.rejected || [];
        for (const item of rejected) {
          logger.warn(`[pmjs] preparation ${name}/${item.id}: ${item.reason}; using original if repair fails`);
          session.repairSources.add(item.id);
          const encryptedSource = value.decryptedEntries?.find(entry => entry.logicalSource === item.id)?.source;
          for (const record of Object.values(session.data.results))
            if (record?.source === item.id || (encryptedSource && record?.source === encryptedSource) || record?.key === item.id) {
              if (record.source) session.repairSources.add(record.source);
              if (!record.failed) { record.failed = true; session.markDirty(); }
              ++session.invalidated;
              if (attempt === 1) session.outcome(name === 'maps' ? 'map:' + record.filename : 'image:' + record.source, 'ordinary-failure', item.reason);
            }
          }
        await session.checkpoint();
        if (!rejected.length || shouldCancel()) break;
      }
      const cancelled = shouldCancel() || value?.cancelled;
      session.finishPhase(name, cancelled ? 'cancelled' : value?.error ? 'failed' : 'completed');
      options.onPhaseComplete?.(name, value);
      return value;
    } catch (error) {
      session.finishPhase(name, shouldCancel() ? 'cancelled' : 'failed');
      throw error;
    }
  };
  try {
    if (options.images !== false) result.images = await phase('images', onProgress => prepareAssetsPhase({
      ...options, session, onProgress }));
    if (preparationContext === 'offline')
      for (const entry of result.images?.decryptedEntries || []) native.assets.addDerived?.(entry.logicalSource, entry.file);
    if (!shouldCancel() && options.maps && (session.inventory.some(file => /^data\/Map\d+\.json$/i.test(file)) || session.data.indices.maps))
      result.maps = await phase('maps', onProgress => prepareMapsPhase({ ...options, session, onProgress,
        portableIndex: options.portableIndex?.maps }));
    if (!shouldCancel() && (options.portDescriptors?.length || options.adapters?.length || options.bundleRoot))
      result.portArtifacts = await phase('port', () => prepareForRun({ ...options, session,
        descriptors: options.portDescriptors,
        compressArtifact: native.assets.compressPortArtifact,
        decompressArtifact: native.assets.decompressPortArtifact }));
    result.cancelled = shouldCancel() || result.images?.cancelled || result.maps?.cancelled || false;
    if (!result.cancelled) {
      try {
        await session.finish();
        result.portArtifactHashes = Object.fromEntries(Object.values(session.data.results)
          .filter(record => record?.id && record.outputs?.['data.pma1'] && result.portArtifacts.has(record.id))
          .map(record => [record.id, record.outputs['data.pma1']]));
        if (options.fastStartup) {
          try { result.catalogSaved = await require('./preparation-catalog.cjs').saveCatalog(options, session, result); }
          catch (error) { logger.warn('[pmjs] cannot save startup catalog: ' + error.message); }
        }
      }
      catch (error) {
        if (preparationContext === 'offline') throw error;
        logger.warn('[pmjs] preparation lease unavailable; using originals: ' + error.message);
        native.assets.installPrepared?.([]);
        native.assets.installDecrypted?.([]);
        native.assets.installImageStorage?.([]);
        native.assets.installTileSets?.([]);
        native.assets.preparedMapIndex = {};
        if (result.images) Object.assign(result.images, { error: error.message, installed: 0, decrypted: 0 });
        if (result.maps) Object.assign(result.maps, { error: error.message, installed: 0, index: {} });
        result.portArtifacts = new Map();
        for (const id of session.outcomes.keys()) session.outcome(id, 'ordinary-failure', error.message);
      }
    }
    result.records = session.data.results;
    result.portArtifactHashes ||= {};
    result.outcomes = [...session.outcomes.values()];
    result.invalidated = session.invalidated;
    result.outcomeCounts = {};
    for (const { outcome } of result.outcomes) result.outcomeCounts[outcome] = (result.outcomeCounts[outcome] || 0) + 1;
    result.validation = session.files.stats;
    result.inventory = { files: session.inventory.length, durationMs: session.inventoryMs };
    result.releaseCacheLease = session.releaseLease;
    Object.assign(result, createInvalidators(session.root, native, logger));
    logger.info?.(`[pmjs] preparation inventory=${result.inventory.files} scan_ms=${result.inventory.durationMs.toFixed(1)} ` +
      `outcomes=${JSON.stringify(result.outcomeCounts)} hashed_files=${result.validation.hashedFiles} hashed_bytes=${result.validation.hashedBytes} reused_files=${result.validation.reusedFiles}`);
    return result;
  } catch (error) {
    logger.warn('[pmjs] preparation unavailable: ' + error.message);
    throw error;
  } finally { await session.close(); }
}

function summarizePreparation(value) {
  const summary = {};
  for (const [key, item] of Object.entries(value || {})) {
    if (item === null || ['number', 'boolean', 'string'].includes(typeof item)) summary[key] = item;
    else if (Array.isArray(item)) summary[key + 'Count'] = item.length;
  }
  for (const key of ['maps', 'inventory', 'validation', 'activation', 'phaseMs', 'hashCategories']) {
    const item = value?.[key];
    if (item && typeof item === 'object' && !Array.isArray(item)) summary[key] = summarizePreparation(item);
  }
  return summary;
}

module.exports = { prepareGameAssets, summarizePreparation };
