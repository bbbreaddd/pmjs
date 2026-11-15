'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { acquireLock, createLease } = require('./preparation-lifetime.cjs');
const { createInvalidators } = require('./preparation-state.cjs');
const { discoverAdapterProcessors, discoverBundledProcessors } = require('./port-preparation.cjs');
const { CACHE_VERSION, PROCESSOR_IDENTITY } = require('./asset-preparation.cjs');
const { COMPILER_VERSION } = require('./map-demand.cjs');
const { fileIdentity } = require('./preparation-files.cjs');

// Bump when catalog contents or preparation decisions change incompatibly.
const CATALOG_VERSION = 4;

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
    pageCodec: options.pageCodec, workspaceBytes: options.workspaceBytes, recipes: options.recipes,
    astc: options.astc, losslessPrefixes: options.losslessPrefixes, policyOverrides: options.policyOverrides,
    portableIndex: options.portableIndex, width: options.width, height: options.height,
    sourceRoots: options.sourceRoots, bundleRoot: options.bundleRoot, virtualFiles: options.virtualFiles,
    portDescriptors: options.portDescriptors, adapters: options.adapters };
}

async function saveCatalog(options, session, result) {
  const images = result.images || {}, maps = result.maps || {};
  const ordinaryFailures = images.ordinaryFailures || [];
  const recordedFailures = new Set(ordinaryFailures.map(item => 'image:' + item.source));
  if ((options.verifyHashes && !options.forceRebuild) || result.cancelled || session.persistenceWarning || images.error || maps.error ||
      (images.failedFiles || 0) !== ordinaryFailures.length || images.installFailures ||
      [...session.outcomes.values()].some(item => item.outcome === 'ordinary-failure' && !recordedFailures.has(item.id))) return false;
  const entries = images.entries || [], derived = images.decryptedEntries || [], tiles = maps.entries || [];
  if (entries.some(entry => !Array.isArray(entry.pageIdentities)) || derived.some(entry => !entry.fileIdentity) ||
      tiles.some(entry => !Array.isArray(entry.pageIdentities) || !Array.isArray(entry.snapshotIdentities))) return false;
  const keys = new Set(Object.keys(session.data.results).map(value => value.split('/').at(-1)));
  for (const record of Object.values(session.data.results))
    for (const input of record?.descriptor?.sources || [])
      if (input.snapshot) keys.add(path.basename(input.snapshot, '.png'));
  for (const key of [...(session.data.indices.maps?.snapshots || []), ...(session.data.indices.maps?.keys || [])]) keys.add(key);
  const discoveredProcessors = processorDiscovery(options);
  const processorFiles = [...new Set([...discoveredProcessors, ...(session.processorFiles || [])])].sort();
  const processorHashes = Object.fromEntries(processorFiles.map(file => [file, hash(fs.readFileSync(file))]));
  for (const file of session.processorFiles || [])
    if (session.files.receipts[file]?.hash !== processorHashes[file]) return false;
  const artifactHashes = result.portArtifactHashes;
  if ([...result.portArtifacts.keys()].some(id => !/^[a-f0-9]{64}$/.test(artifactHashes[id] || ''))) return false;
  const data = { signature: signature(options), entries, derived, tiles, mapIndex: maps.index || {},
    storage: images.storageEntries || [], audio: images.audioViewEntries || [], ordinaryFailures,
    portArtifacts: [...result.portArtifacts], artifactHashes, discoveredProcessors, processorHashes, keys: [...keys] };
  const serialized = JSON.stringify(data);
  const filename = path.join(session.root, 'startup-catalog.json');
  const temporary = filename + '.stage-' + crypto.randomBytes(6).toString('hex');
  try {
    await fsp.writeFile(temporary, JSON.stringify({ version: CATALOG_VERSION, checksum: hash(serialized), data }), { flag: 'wx' });
    await fsp.rename(temporary, filename);
    return true;
  } finally { await fsp.rm(temporary, { force: true }); }
}

async function loadCatalog(options) {
  const { native, logger = console, shouldCancel = () => false } = options;
  if (options.verifyHashes || options.verifyRegions || typeof native.assets.installPreparedCatalog !== 'function' ||
      typeof native.assets.installDerivedCatalog !== 'function' ||
      (options.maps && typeof native.assets.installTileSetCatalog !== 'function')) return null;
  let releaseLock, releaseLease;
  try {
    const gameRoot = await fsp.realpath(options.gameRoot);
    const cacheRoot = await fsp.realpath(options.cacheRoot);
    const root = path.join(cacheRoot, 'preparation-v1', hash(JSON.stringify(gameRoot)).slice(0, 16));
    releaseLock = await acquireLock(root, shouldCancel, () => {}, native.assets);
    if (!releaseLock) return null;
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
    if (changed.length) throw new Error('catalog signature changed: ' + changed.join(', '));
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
    releaseLease = await createLease(root, data.keys);
    const derived = await native.assets.installDerivedCatalog(data.derived, false, true);
    if (derived?.rejected?.length) throw new Error('derived catalog rejected');
    const images = await native.assets.installPreparedCatalog(data.entries, false, true);
    if (images?.rejected?.length || typeof images === 'number' && images !== data.entries.length) throw new Error('image catalog rejected');
    if (native.assets.installImageStorage) await native.assets.installImageStorage(data.storage, true);
    if (native.media?.installAudioViews && native.media.installAudioViews(data.audio) !== data.audio.length) throw new Error('audio catalog rejected');
    if (options.maps) {
      const tiles = await native.assets.installTileSetCatalog(data.tiles, false, true);
      if (tiles?.rejected?.length || typeof tiles === 'number' && tiles !== data.tiles.length) throw new Error('tile catalog rejected');
      native.assets.preparedMapIndex = data.mapIndex;
    }
    const lease = releaseLease; releaseLease = null;
    return { images: { entries: data.entries, decryptedEntries: data.derived, storageEntries: data.storage,
      installed: data.entries.length, failedFiles: data.ordinaryFailures.length, fallback: data.ordinaryFailures.length,
      ordinaryFailures: data.ordinaryFailures, catalogHit: true }, maps: { entries: data.tiles, index: data.mapIndex },
      portArtifacts: new Map(data.portArtifacts), portArtifactHashes: data.artifactHashes, releaseCacheLease: lease,
      ...createInvalidators(root, native, logger) };
  } catch (error) {
    if (error.code !== 'ENOENT') logger.warn('[pmjs] startup catalog unavailable; preparing assets: ' + error.message);
    return null;
  } finally { releaseLease?.(); releaseLock?.(); }
}

module.exports = { loadCatalog, saveCatalog, rebuildMarker };
