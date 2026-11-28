'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { acquireLock, adoptInstalledLease } = require('./preparation-lifetime.cjs');
const { createInvalidators, installationReport } = require('./preparation-state.cjs');
const { discoverAdapterProcessors, discoverBundledProcessors } = require('./port-preparation.cjs');
const { CACHE_VERSION, PROCESSOR_IDENTITY } = require('./asset-preparation.cjs');
const { COMPILER_VERSION } = require('./map-demand.cjs');
const { fileIdentity } = require('./preparation-files.cjs');

// Bump when catalog contents or preparation decisions change incompatibly.
const CATALOG_VERSION = 7;

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const rebuildMarker = 'runtime-settings/rebuild-assets';
const processorDiscovery = options => options.portDescriptors?.length ? [] :
  [...new Set([...discoverBundledProcessors(options.bundleRoot), ...discoverAdapterProcessors(options.adapters)])].sort();

function signature(options) {
  const { native } = options;
  return { imageFormat: CACHE_VERSION, mapCompiler: COMPILER_VERSION,
    imageProcessor: options.processorIdentity || native.assets.preparationVersion || PROCESSOR_IDENTITY,
    tileProcessor: native.assets.tilePreparationVersion,
    lz4: native.assets.preparationLz4Version, images: options.images, maps: options.maps,
    allowPalettes: options.allowPalettes ?? false, pageCodec: options.pageCodec, workspaceBytes: options.workspaceBytes, recipes: options.recipes,
    astc: options.astc, losslessPrefixes: options.losslessPrefixes, policyOverrides: options.policyOverrides,
    portableIndex: options.portableIndexIdentity ?? (options.portableIndex ? hash(JSON.stringify(options.portableIndex)) : null),
    imageStorageVersion: native.assets.imageStorageVersion, width: options.width, height: options.height,
    sourceRoots: options.sourceRoots, bundleRoot: options.bundleRoot, virtualFiles: options.virtualFiles,
    portDescriptors: options.portDescriptors, adapters: options.adapters };
}

async function saveCatalog(options, session, result) {
  const logger = options.logger || console;
  const info = message => (logger.info || logger.log)?.call(logger, message);
  const skip = reason => { (logger.warn || console.warn).call(logger, '[pmjs] startup catalog save skipped: ' + reason); return false; };
  const images = result.images || {}, maps = result.maps || {};
  const imageFailures = images.ordinaryFailures || [];
  const mapFailures = maps.ordinaryFailures || [];
  const ordinaryFailures = [
    ...imageFailures.map(item => ({ ...item, id: 'image:' + item.source })),
    ...mapFailures.map(item => ({ ...item, id: 'map:' + item.source }))
  ];
  const recordedFailures = new Set(ordinaryFailures.map(item => item.id));
  if (options.verifyHashes && !options.forceRebuild) return skip('verifyHashes without forceRebuild');
  if (result.cancelled) return skip('preparation cancelled');
  if (session.persistenceWarning) return skip('persistence warning: ' + session.persistenceWarning);
  if (images.error) return skip('images error: ' + images.error);
  if (maps.error) return skip('maps error: ' + maps.error);
  if ((images.failedFiles || 0) !== imageFailures.length) return skip('unrecorded image failure');
  if (images.installFailures) return skip('image install failures: ' + images.installFailures);
  const unrecordedFailure = [...session.outcomes.values()].find(item => item.outcome === 'ordinary-failure' && !recordedFailures.has(item.id));
  if (unrecordedFailure) return skip('unrecorded ordinary failure: ' + unrecordedFailure.id);
  const entries = images.entries || [], derived = images.decryptedEntries || [], tiles = maps.entries || [];
  if (entries.some(entry => !Array.isArray(entry.pageIdentities))) return skip('missing image page identities');
  if (derived.some(entry => !entry.fileIdentity)) return skip('missing derived file identity');
  if (tiles.some(entry => !Array.isArray(entry.pageIdentities) || !Array.isArray(entry.snapshotIdentities))) return skip('missing tile identities');
  const keys = new Set(Object.keys(session.data.results).map(value => value.split('/').at(-1)));
  for (const record of Object.values(session.data.results))
    for (const input of record?.descriptor?.sources || [])
      if (input.snapshot) keys.add(path.basename(input.snapshot, '.png'));
  for (const key of [...(session.data.indices.maps?.snapshots || []), ...(session.data.indices.maps?.keys || [])]) keys.add(key);
  const discoveredProcessors = processorDiscovery(options);
  const processorFiles = [...new Set([...discoveredProcessors, ...(session.processorFiles || [])])].sort();
  const processorHashes = Object.fromEntries(processorFiles.map(file => [file, hash(fs.readFileSync(file))]));
  for (const file of session.processorFiles || [])
    if (session.files.receipts[file]?.hash !== processorHashes[file]) return skip('processor file hash mismatch: ' + file);
  const artifactHashes = result.portArtifactHashes;
  if ([...result.portArtifacts.keys()].some(id => !/^[a-f0-9]{64}$/.test(artifactHashes[id] || ''))) return skip('missing port artifact hash');
  const data = { signature: signature(options), packedImages: !!session.packedFiles?.size, entries, derived, tiles, mapIndex: maps.index || {},
    storage: images.storageEntries || [], audio: images.audioViewEntries || [], ordinaryFailures,
    portArtifacts: [...result.portArtifacts], artifactHashes, discoveredProcessors, processorHashes, keys: [...keys] };
  const serialized = JSON.stringify(data);
  const filename = path.join(session.root, 'startup-catalog.json');
  const temporary = filename + '.stage-' + crypto.randomBytes(6).toString('hex');
  try {
    await fsp.writeFile(temporary, JSON.stringify({ version: CATALOG_VERSION, checksum: hash(serialized), data }), { flag: 'wx' });
    await fsp.rename(temporary, filename);
    info('[pmjs] startup catalog saved');
    return true;
  } finally { await fsp.rm(temporary, { force: true }); }
}

async function loadCatalog(options) {
  const { native, logger = console, shouldCancel = () => false } = options;
  const info = message => (logger.info || logger.log)?.call(logger, message);
  const warn = message => (logger.warn || console.warn).call(logger, message);
  if (options.verifyHashes || options.verifyRegions || typeof native.assets.installPreparedCatalog !== 'function' ||
      typeof native.assets.installDerivedCatalog !== 'function' ||
      (options.maps && typeof native.assets.installTileSetCatalog !== 'function')) {
    const reason = options.verifyHashes ? 'verifyHashes' : options.verifyRegions ? 'verifyRegions' : 'missing native catalog installer';
    info('[pmjs] startup catalog bypassed; preparing assets: ' + reason);
    return null;
  }
  let releaseLock;
  try {
    const gameRoot = await fsp.realpath(options.gameRoot);
    const cacheRoot = await fsp.realpath(options.cacheRoot);
    const root = path.join(cacheRoot, 'preparation-v1', hash(JSON.stringify(gameRoot)).slice(0, 16));
    releaseLock = await acquireLock(root, shouldCancel, () => {}, native.assets);
    if (!releaseLock) {
      warn('[pmjs] startup catalog unavailable; preparing assets: cannot acquire preparation lock');
      return null;
    }
    const invalidations = await fsp.readdir(path.join(root, 'invalidations')).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
    if (invalidations.some(name => /^[a-f0-9]{64}\.json$/.test(name))) throw new Error('pending asset invalidation');
    const filename = path.join(root, 'startup-catalog.json');
    if ((await fsp.stat(filename)).size > 48 * 1024 * 1024) throw new Error('catalog exceeds the memory budget');
    const record = JSON.parse(await fsp.readFile(filename, 'utf8'));
    const data = record.data;
    if (record.version !== CATALOG_VERSION) throw new Error('catalog format version changed');
    if (record.checksum !== hash(JSON.stringify(data))) throw new Error('catalog checksum mismatch');
    const expected = signature(options);
    if (!data.signature || typeof data.signature !== 'object') throw new Error('missing catalog signature');
    const changed = [...new Set([...Object.keys(data.signature), ...Object.keys(expected)])]
      .filter(key => JSON.stringify(data.signature[key]) !== JSON.stringify(expected[key]));
    if (changed.length) {
      const safeFields = new Set([
        'imageFormat', 'mapCompiler', 'imageProcessor', 'tileProcessor', 'lz4',
        'images', 'maps', 'allowPalettes', 'pageCodec', 'workspaceBytes',
        'width', 'height', 'imageStorageVersion', 'sourceRoots', 'bundleRoot'
      ]);
      const formatBound = value => {
        const text = JSON.stringify(value);
        if (text === undefined) return 'undefined';
        return text.length > 80 ? text.slice(0, 77) + '...' : text;
      };
      const details = [];
      for (const key of changed) {
        if (!safeFields.has(key)) continue;
        const prev = data.signature[key];
        const next = expected[key];
        if (key === 'sourceRoots' && Array.isArray(prev) && Array.isArray(next)) {
          const prevSet = new Set(prev);
          const nextSet = new Set(next);
          const removed = prev.filter(item => !nextSet.has(item)).slice(0, 3);
          const added = next.filter(item => !prevSet.has(item)).slice(0, 3);
          details.push(`sourceRoots(removed=${JSON.stringify(removed)},added=${JSON.stringify(added)})`);
        } else {
          details.push(`${key}:${formatBound(prev)}->${formatBound(next)}`);
        }
      }
      const suffix = details.length ? ` (${details.join('; ')})` : '';
      throw new Error('catalog signature changed: ' + changed.join(', ') + suffix);
    }
    if (typeof data.packedImages !== 'boolean') throw new Error('invalid packed image catalog state');
    if (!['entries', 'derived', 'tiles', 'storage', 'audio', 'ordinaryFailures', 'portArtifacts', 'keys'].every(key => Array.isArray(data[key])) ||
        !data.mapIndex || typeof data.mapIndex !== 'object' || !data.artifactHashes ||
        !Array.isArray(data.discoveredProcessors) || !data.processorHashes ||
        JSON.stringify(data.discoveredProcessors) !== JSON.stringify(processorDiscovery(options))) throw new Error('catalog metadata or processor discovery changed');
    for (const [file, expected] of Object.entries(data.processorHashes))
      if (hash(await fsp.readFile(file)) !== expected) throw new Error('processor file changed: ' + file);
    if (data.portArtifacts.some(([id]) => !/^[a-f0-9]{64}$/.test(data.artifactHashes[id] || ''))) throw new Error('missing artifact checksum');
    for (const failure of data.ordinaryFailures) {
      if (!failure || typeof failure.source !== 'string' || typeof failure.reason !== 'string' ||
          !Array.isArray(failure.dependencies) || !failure.dependencies.length)
        throw new Error('invalid ordinary source failure');
      for (const dependency of failure.dependencies) {
        if (!dependency || !['source', 'file', 'identity', 'hash'].every(key => typeof dependency[key] === 'string') ||
            !/^[a-f0-9]{64}$/.test(dependency.hash)) throw new Error('invalid ordinary failure dependency');
        const file = native.assets.sourcePath ? native.assets.sourcePath(dependency.source) : path.join(gameRoot, dependency.source);
        if (file !== dependency.file)
          throw new Error('previously unprocessable source changed: ' + failure.source);
        const current = fileIdentity(await fsp.stat(file, { bigint: true }));
        if (current !== dependency.identity) {
          const checksum = crypto.createHash('sha256');
          for await (const chunk of fs.createReadStream(file)) checksum.update(chunk);
          if (checksum.digest('hex') !== dependency.hash || fileIdentity(await fsp.stat(file, { bigint: true })) !== current)
            throw new Error('previously unprocessable source changed: ' + failure.source);
        }
      }
    }
    if (options.images === false) native.assets.installPackedFiles?.([]);
    const packed = options.images === false ? new Map() : await require('./packed-cache.cjs').loadPackedCache(root, native, logger);
    if (packed === null || packed.damagedPacks?.length || data.packedImages !== (packed.size > 0)) throw new Error('packed image catalog changed');
    const releaseLease = await adoptInstalledLease(native.assets, root, data.keys);
    const derived = installationReport(await native.assets.installDerivedCatalog(data.derived, false, true), 'derived catalog');
    if (derived.rejected.length || derived.accepted.length !== data.derived.length) throw new Error('derived catalog rejected');
    const images = installationReport(await native.assets.installPreparedCatalog(data.entries, false, true), 'image catalog');
    if (images.rejected.length || images.accepted.length !== data.entries.length) throw new Error('image catalog rejected');
    if (native.assets.installImageStorage) {
      const storage = installationReport(await native.assets.installImageStorage(data.storage, true), 'image storage');
      if (storage.rejected.length || storage.accepted.length !== data.storage.length) throw new Error('storage catalog rejected');
    }
    if (native.media?.installAudioViews) {
      const audio = installationReport(native.media.installAudioViews(data.audio, true), 'audio views');
      if (audio.rejected.length || audio.accepted.length !== data.audio.length) throw new Error('audio catalog rejected');
    }
    if (options.maps) {
      const tiles = installationReport(await native.assets.installTileSetCatalog(data.tiles, false, true), 'tile catalog');
      if (tiles.rejected.length || tiles.accepted.length !== data.tiles.length) throw new Error('tile catalog rejected');
      native.assets.preparedMapIndex = data.mapIndex;
    }
    const lease = releaseLease;
    const imageFailures = data.ordinaryFailures.filter(item => !item.id || item.id.startsWith('image:'));
    return { images: { entries: data.entries, decryptedEntries: data.derived, storageEntries: data.storage,
      installed: data.entries.length, failedFiles: imageFailures.length, fallback: imageFailures.length,
      ordinaryFailures: imageFailures, catalogHit: true }, maps: { entries: data.tiles, index: data.mapIndex,
      ordinaryFailures: data.ordinaryFailures.filter(item => item.id?.startsWith('map:')) },
      portArtifacts: new Map(data.portArtifacts), portArtifactHashes: data.artifactHashes, releaseCacheLease: lease,
      ...createInvalidators(root, native, logger) };
  } catch (error) {
    if (error.code === 'ENOENT') info('[pmjs] startup catalog missing; preparing assets');
    else warn('[pmjs] startup catalog unavailable; preparing assets: ' + error.message);
    return null;
  } finally { releaseLock?.(); }
}

module.exports = { loadCatalog, saveCatalog, rebuildMarker };
