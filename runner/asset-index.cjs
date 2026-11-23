'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { astcSettings, validDescriptor, validStorageDecision } = require('./asset-preparation.cjs');
const { validTileDescriptor } = require('./map-preparation.cjs');
const { prepareGameAssets } = require('./preparation.cjs');
const { COMPILER_VERSION } = require('./map-demand.cjs');
const { acquireLock } = require('./preparation-lifetime.cjs');
const { storageClassifier, mapStorageInputs } = require('./asset-storage-index.cjs');
const { fileIdentity } = require('./preparation-files.cjs');
const { discoverBundledProcessors } = require('./port-preparation.cjs');

const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const identity = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const matchesPrefix = (source, prefix) => source.toLowerCase().startsWith(prefix.toLowerCase());

function identicalFiles(left, right) {
  if (fs.statSync(left).size !== fs.statSync(right).size) return false;
  const a = fs.openSync(left, 'r');
  let b;
  try {
    b = fs.openSync(right, 'r');
    const x = Buffer.alloc(16384), y = Buffer.alloc(16384);
    for (;;) {
      const count = fs.readSync(a, x, 0, x.length, null);
      if (count !== fs.readSync(b, y, 0, y.length, null) || !x.subarray(0, count).equals(y.subarray(0, count))) return false;
      if (!count) return true;
    }
  } finally {
    fs.closeSync(a);
    if (b !== undefined) fs.closeSync(b);
  }
}

function offlineFilesystem(gameRoot, derived) {
  const root = fs.realpathSync(gameRoot);
  const files = new Map(), directories = new Map();
  const derivedFiles = new Map();
  const overlays = new Map();
  const normalize = logical => {
    if (typeof logical !== 'string' || logical.includes('\0') || path.posix.isAbsolute(logical)) return null;
    const normalized = path.posix.normalize(logical);
    if (normalized === '..' || normalized.startsWith('../')) return null;
    const parts = normalized.split('/').filter(part => part && part !== '.');
    if (!parts.length) return null;
    return parts.map(part => part.replace(/[A-Z]/g, character =>
      String.fromCharCode(character.charCodeAt(0) + 32))).join('/');
  };
  const contained = resolved => {
    const relative = path.relative(root, resolved);
    return !relative || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
  };
  const index = (target, directory, link = false) => {
    let resolved = target;
    if (link) {
      try { resolved = fs.realpathSync(target); } catch { return; }
      if (!contained(resolved)) return;
      try {
        const status = fs.statSync(resolved);
        if (!status.isFile() && !status.isDirectory()) return;
        directory = status.isDirectory();
      } catch { return; }
    }
    const logical = path.relative(root, target).split(path.sep).join('/');
    const key = normalize(logical);
    if (!key) return;
    const inventory = directory ? directories : files;
    const previous = inventory.get(key);
    if (previous && previous !== target) {
      if (!directory && identicalFiles(previous, target)) {
        inventory.set(key, previous < target ? previous : target);
        return;
      }
      throw new Error('case-insensitive path collision: ' + previous + ' and ' + target);
    }
    inventory.set(key, target);
  };
  const scan = directory => {
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
    catch (error) { if (directory === root) throw error; return; }
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) index(target, false, true);
      else if (entry.isFile()) index(target, false);
      else if (entry.isDirectory()) { index(target, true); scan(target); }
    }
  };
  scan(root);
  const sourceDirectories = new Map(directories);
  for (const [logical, file] of derived) {
    const key = normalize(logical);
    if (!key) continue;
    if (derivedFiles.has(key)) throw new Error('case-insensitive derived path collision: ' + logical);
    derivedFiles.set(key, { logical, file });
  }
  const masked = key => {
    let slash = key.lastIndexOf('/');
    while (slash >= 0) {
      if (overlays.get(key.slice(0, slash))?.directory === false) return true;
      slash = key.lastIndexOf('/', slash - 1);
    }
    return false;
  };
  const resolve = logical => {
    const key = normalize(logical);
    if (!key || masked(key)) return null;
    if (overlays.has(key)) return overlays.get(key).directory ? null : overlays.get(key).file;
    if (files.has(key)) return files.get(key);
    if (directories.has(key)) return null;
    return derivedFiles.get(key)?.file || null;
  };
  const directory = logical => {
    if (!logical || logical === '.') return root;
    const key = normalize(logical);
    return key && !masked(key) && overlays.get(key)?.directory !== false ?
      directories.get(key) || null : null;
  };
  const exists = logical => resolve(logical) !== null || directory(logical) !== null;
  const assets = {
    sourcePath: resolve,
    addDerived: (logical, file) => {
      const key = normalize(logical);
      if (!key) throw new Error('invalid derived logical path');
      if (derivedFiles.has(key)) throw new Error('case-insensitive derived path collision: ' + logical);
      derivedFiles.set(key, { logical, file });
    },
    sourceIdentity: logical => {
      const source = resolve(logical);
      if (!source) return null;
      const stat = fs.statSync(source);
      return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
    }
  };
  const game = {
    exists,
    isDirectory: logical => directory(logical) !== null,
    readBytes: logical => { const source = resolve(logical); return source ? fs.readFileSync(source) : null; },
    resolvePath: resolve,
    mountReadOnlyOverlay: overlay => {
      const nextOverlays = new Map(), nextDirectories = new Map(sourceDirectories);
      function visit(directory, prefix = '') {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
          const logical = prefix + entry.name, physical = path.join(directory, entry.name);
          if (!entry.isDirectory() && !entry.isFile())
            throw new Error('prepared game overlays must contain regular files and directories');
          const key = normalize(logical), previous = nextOverlays.get(key);
          if (previous) {
            if (previous.directory || entry.isDirectory() || !identicalFiles(previous.file, physical))
              throw new Error('case-insensitive path collision: ' + previous.file + ' and ' + physical);
            if (previous.file < physical) continue;
          }
          nextOverlays.set(key, { logical, file: physical, directory: entry.isDirectory() });
          if (entry.isDirectory()) {
            if (!nextDirectories.has(key)) nextDirectories.set(key, physical);
            visit(physical, logical + '/');
          }
        }
      }
      visit(overlay);
      overlays.clear(); directories.clear();
      for (const [key, entry] of nextOverlays) overlays.set(key, entry);
      for (const [key, physical] of nextDirectories) directories.set(key, physical);
    },
    readDirectory: logical => {
      const source = directory(logical);
      if (!source) return null;
      const parent = logical && logical !== '.' ? normalize(logical) : '';
      const entries = new Map();
      for (const name of fs.readdirSync(source)) {
        const child = parent ? parent + '/' + name : name;
        if (resolve(child) !== null || directory(child) !== null) {
          const key = normalize(child);
          if (key) entries.set(key, name);
        }
      }
      for (const [key, entry] of derivedFiles) {
        const slash = key.lastIndexOf('/');
        const entryParent = slash < 0 ? '' : key.slice(0, slash);
        if (entryParent === parent && resolve(entry.logical) !== null)
          entries.set(key, path.posix.basename(entry.logical));
      }
      for (const [key, entry] of overlays) {
        const slash = key.lastIndexOf('/');
        if ((slash < 0 ? '' : key.slice(0, slash)) === parent)
          entries.set(key, path.posix.basename(entry.logical));
      }
      return [...entries.values()].sort();
    }
  };
  return { assets, fs: game };
}

async function portableMaps(result, includeAssets, output, classifier) {
  const mapInputs = Object.fromEntries(Object.entries(result.mapInputs || {}).map(([name, entry]) =>
    [name, { ...entry, dependencies: entry.dependencies.map(({ logical, hash }) => ({ logical, hash })) }]));
  const entries = [];
  for (const [mapId, selected] of Object.entries(result.index)) {
    const entry = result.entries.find(item => item.identity === selected.identity);
    const directory = entry.directory;
    const manifest = entry;
    if (!validTileDescriptor(manifest.descriptor)) throw new Error('invalid generated map descriptor');
    const pages = [];
    for (const page of manifest.outputs) {
      const source = path.join(directory, page.path);
      if (await classifier.hash(source) !== page.hash) throw new Error('generated map page changed');
      const relative = path.posix.join('assets/maps', selected.identity, page.path);
      if (includeAssets) {
        fs.mkdirSync(path.dirname(path.join(output, relative)), { recursive: true });
        fs.copyFileSync(source, path.join(output, relative));
      }
      pages.push({ ...page, path: relative });
    }
    const descriptor = { ...manifest.descriptor,
      sources: manifest.descriptor.sources.map(({ snapshot, sourceIdentity, ...source }) => source) };
    entries.push({ mapId: Number(mapId), identity: selected.identity,
      descriptor, outputs: pages, estimates: manifest.estimates });
  }
  return { compiler: COMPILER_VERSION, compilations: result.compilations || {}, mapInputs, entries };
}

async function generateAssetIndex({ root, gameRoot, options, output, includeAssets, portDescriptors = [], includePortAssets = false, writeIndex = true, shouldCancel = () => false, cacheRoot: reusableCache }) {
  const nativeAddon = require(path.join(root, 'lib/pmjs_native.node'));
  const cacheRoot = reusableCache ? path.resolve(reusableCache) : path.join(output, '.preparation');
  const lockRoot = path.join(cacheRoot, 'index-lock');
  fs.mkdirSync(lockRoot, { recursive: true });
  const derived = new Map();
  const filesystem = offlineFilesystem(gameRoot, derived);
  const native = { runtime: {}, assets: Object.assign(Object.create(nativeAddon.assets), filesystem.assets), fs: filesystem.fs };
  const warnings = [];
  const logger = { warn: message => warnings.push(message) };
  const release = await acquireLock(lockRoot, shouldCancel, () => {}, nativeAddon.assets, 3600000);
  if (!release) throw new Error('asset indexing cancelled');
  try {
    const { prepareGameFiles } = require('./game-preparation.cjs');
    const sourceRoots = prepareGameFiles({ ...options, gameRoot, assetPreparation: { ...options.assetPreparation, cacheRoot } }, native, 'prepareAssetIndex');
    const prepared = await prepareGameAssets({ gameRoot, cacheRoot, native,
      ...options.assetPreparation, images: options.assetPreparation.enabled,
      materializeAudio: portDescriptors.length > 0 || discoverBundledProcessors(output).length > 0,
      maps: options.assetPreparation.enabled && options.assetPreparation.maps,
      preparationContext: 'offline', verifyHashes: true, logger, shouldCancel, sourceRoots,
      virtualFiles: options.virtualFiles,
      width: options.width, height: options.height, bundleRoot: output, portDescriptors });
    const images = prepared.images || { total: 0, prepared: 0, decisions: [], entries: [], decryptedEntries: [] };
    let maps = prepared.maps || null;
    if (prepared.cancelled) throw new Error('asset preparation cancelled');
    if (images.error || images.failedFiles > 0)
      throw new Error('asset index incomplete: ' + (images.error || `${images.failedFiles} asset preparation failures`));
    if (maps?.error) throw new Error('map index unavailable: ' + maps.error);
    for (const desc of portDescriptors) {
      desc.outputs = [];
      for (const record of Object.values(prepared.records || {})) {
        if (!record.id?.startsWith(desc.id + '/')) continue;
        const value = { id: record.id.slice(desc.id.length + 1), source: record.source, sourceSha256: record.sourceHash };
        const file = prepared.portArtifacts.get(record.id);
        if (file && includePortAssets) {
          value.file = 'assets/ports/' + desc.id + '/' + value.id + '.pma1';
          value.sha256 = hash(file);
          fs.mkdirSync(path.dirname(path.join(output, value.file)), { recursive: true });
          fs.copyFileSync(file, path.join(output, value.file));
        }
        desc.outputs.push(value);
      }
    }
    const imageEntries = new Map();
    images.entries.forEach((entry, index) => {
      if (!imageEntries.has(entry.source)) imageEntries.set(entry.source, { entry, index });
    });
    if (nativeAddon.assets.imageStorageVersion !== 1 || typeof nativeAddon.assets.classifyImageStorage !== 'function')
      throw new Error('image storage indexing requires a current host runtime');
    const decryptedInputs = new Map(images.decryptedEntries.map(entry => [entry.source, entry.file]));
    const classifier = storageClassifier(nativeAddon.assets, cacheRoot, prepared.fileReceipts);
    const imageWarnings = new Map();
    const imageRecords = await mapStorageInputs(images.decisions, async decision => {
      if (shouldCancel()) throw new Error('image storage indexing cancelled');
      if (decision.descriptor && !validDescriptor(decision.descriptor)) throw new Error('invalid generated image descriptor');
      const original = imageEntries.get(decision.source);
      const decrypted = imageEntries.get(decision.source.replace(/\.(png_|rpgmvp)$/i, '.png'));
      // Either source spelling can match; retain the first entry in preparation order.
      const entry = (!original || decrypted && decrypted.index < original.index ? decrypted : original)?.entry;
      const outputs = [];
      for (const [name, checksum] of Object.entries(decision.outputs)) {
        if (!entry) throw new Error('missing generated image entry');
        const source = path.join(entry.directory, name);
        if (await classifier.hash(source) !== checksum) throw new Error('generated image page changed');
        const relative = path.posix.join('assets/images', path.basename(entry.directory), name);
        if (includeAssets) {
          fs.mkdirSync(path.dirname(path.join(output, relative)), { recursive: true });
          fs.copyFileSync(source, path.join(output, relative));
        }
        outputs.push({ path: relative, hash: checksum });
      }
      let storage;
      const transformsPixels = decision.recipe?.crop ||
        decision.recipe?.backdrop?.some(channel => channel !== 0);
      const imageSource = decision.source.replace(/\.(png_|rpgmvp)$/i, '.png');
      if (imageSource.toLowerCase().endsWith('.png') && !transformsPixels) {
        try {
          storage = await classifier.classify(
            decryptedInputs.get(decision.source) || filesystem.assets.sourcePath(decision.source));
          if (!validStorageDecision(storage)) throw new Error('invalid storage decision');
          if (await classifier.hash(filesystem.assets.sourcePath(decision.source)) !== decision.sourceHash)
            throw new Error('image source changed during storage classification');
        } catch (error) {
          storage = undefined;
          imageWarnings.set(decision, '[pmjs] image storage index unavailable ' + decision.source + ': ' + error.message);
        }
      }
      let descriptor = decision.descriptor;
      if (descriptor && !descriptor.compression) {
        const pages = [];
        for (const page of descriptor.pages) {
          if (shouldCancel()) throw new Error('page storage indexing cancelled');
          const pageStorage = await classifier.classify(path.join(entry.directory, page.path));
          if (!validStorageDecision(pageStorage) || pageStorage.width !== page.width || pageStorage.height !== page.height)
            throw new Error('invalid prepared page storage decision');
          const expected = decision.outputs[page.path];
          if (await classifier.hash(path.join(entry.directory, page.path)) !== expected) throw new Error('prepared page changed during classification');
          pages.push({ ...page, storage: pageStorage });
        }
        descriptor = { ...descriptor, pages };
      }
      return { ...decision, descriptor, ...(storage ? { storage } : {}), outputs };
    });
    classifier.save();
    for (const decision of images.decisions) if (imageWarnings.has(decision)) warnings.push(imageWarnings.get(decision));
    const index = { schema: 3, kind: 'pmjs-asset-index',
      sections: { imageStorage: 1, images: 1, mapCompilation: 1, tileOutputs: 1 },
      allowPalettes: options.assetPreparation.allowPalettes ?? false,
      pageCodec: options.assetPreparation.pageCodec,
      pageCodecVersion: options.assetPreparation.pageCodec === 'lz4' ? nativeAddon.assets.preparationLz4Version : null,
      losslessPrefixes: options.assetPreparation.losslessPrefixes || [],
      astc: astcSettings(options.assetPreparation.astc),
      imageStorageVersion: nativeAddon.assets.imageStorageVersion,
      processor: nativeAddon.assets.preparationVersion,
      tileProcessor: nativeAddon.assets.tilePreparationVersion,
      width: options.width, height: options.height,
      images: imageRecords.map(({ source, ...calculated }) => {
        const astc = astcSettings(options.assetPreparation.astc);
        const lossless = (options.assetPreparation.losslessPrefixes || []).some(prefix => matchesPrefix(source, prefix));
        const logicalSource = source.replace(/\.(png_|rpgmvp)$/i, '.png').toLowerCase();
        const recipe = options.assetPreparation.recipes.find(recipe =>
          recipe.source.toLowerCase().replace(/\.(png_|rpgmvp)$/i, '.png') === logicalSource);
        const allowAstc = astc.enabled && !lossless;
        return { source, settings: { astc, lossless, ...(recipe ? { recipe } : {}) },
          calculated: { ...calculated, resolvedSettings: { allowPalettes: options.assetPreparation.allowPalettes ?? false, allowAstc,
            astcQuality: allowAstc ? astc.quality : null, pageCodec: options.assetPreparation.pageCodec,
            ...(calculated.workspaceConstrained || calculated.descriptor?.workspaceConstrained
              ? { workspaceBytes: options.assetPreparation.workspaceBytes } : {}) } } };
      }), maps: maps && await portableMaps(maps, includeAssets, output, classifier) };
    if (writeIndex) fs.writeFileSync(path.join(output, 'asset-index.json'), JSON.stringify(index) + '\n');
    return { images: images.total, preparedImages: images.prepared,
      maps: maps?.selected || 0, warnings: warnings.slice(0, 3), warningCount: warnings.length };
  } finally {
    release();
    if (!reusableCache) fs.rmSync(cacheRoot, { recursive: true, force: true });
  }
}

function readAssetIndex(file) {
  try {
    if (!file) return null;
    const before = fs.statSync(file, { bigint: true });
    if (before.size > 64n * 1024n * 1024n) return null;
    const contents = fs.readFileSync(file);
    if (fileIdentity(before) !== fileIdentity(fs.statSync(file, { bigint: true }))) return null;
    return { contents, identity: { loader: 1, sha256: crypto.createHash('sha256').update(contents).digest('hex') } };
  } catch { return null; }
}

function loadAssetIndex(file, native, options, contents) {
  try {
    contents ??= readAssetIndex(file)?.contents;
    if (!contents) return null;
    const index = JSON.parse(contents);
    if (![1, 2, 3].includes(index.schema) || index.kind !== 'pmjs-asset-index') return null;
    const policies = {};
    if (index.schema === 3 && Array.isArray(index.images)) {
      index.images = index.images.filter(record => record && typeof record.source === 'string').map(record => {
        policies[record.source] = record.settings || {};
        return { ...record.calculated, source: record.source };
      });
    } else {
      for (const record of Array.isArray(index.images) ? index.images : []) {
        if (!record || typeof record.source !== 'string') continue;
        policies[record.source] = {
          ...(index.astc ? { astc: index.astc } : {}),
          ...((index.losslessPrefixes || []).some(prefix => matchesPrefix(record.source, prefix)) ? { lossless: true } : {}) };
      }
      for (const recipe of options.assetPreparation.recipes)
        policies[recipe.source] = { ...policies[recipe.source], recipe };
    }
    const legacy = index.schema === 1;
    const imageCompatible = (legacy || index.sections?.images === 1) &&
      Array.isArray(index.images) && index.images.length <= 100000 &&
      JSON.stringify(index.processor) === JSON.stringify(native.assets.preparationVersion) &&
      (index.schema === 3 || index.recipesIdentity === identity(options.assetPreparation.recipes) &&
        JSON.stringify(index.losslessPrefixes || []) === JSON.stringify(options.assetPreparation.losslessPrefixes || []) &&
        JSON.stringify(astcSettings(index.astc)) === JSON.stringify(astcSettings(options.assetPreparation.astc))) &&
      (legacy || index.pageCodec === options.assetPreparation.pageCodec) &&
      (legacy || index.pageCodec !== 'lz4' || typeof native.assets.preparationLz4Version === 'string' &&
        index.pageCodecVersion === native.assets.preparationLz4Version);
    const compilationCompatible = (legacy || index.sections?.mapCompilation === 1) &&
      index.maps?.compiler === COMPILER_VERSION;
    const tilesCompatible = (legacy || index.sections?.tileOutputs === 1) &&
      index.tileProcessor === native.assets.tilePreparationVersion &&
      index.width === options.width && index.height === options.height;
    return { ...index, policies, images: imageCompatible ? index.images.filter(record => record && typeof record.source === 'string')
        .map(record => {
          const { storage, ...rest } = record;
          if (!rest.resolvedSettings) {
            const astc = astcSettings(index.astc);
            const allowAstc = astc.enabled && !(index.losslessPrefixes || []).some(prefix => matchesPrefix(record.source, prefix));
            rest.resolvedSettings = { allowPalettes: index.allowPalettes ?? true, allowAstc, astcQuality: allowAstc ? astc.quality : null, pageCodec: index.pageCodec || 'png' };
          }
          return index.sections?.imageStorage === 1 && index.imageStorageVersion === native.assets.imageStorageVersion &&
            index.imageStorageVersion === 1 && validStorageDecision(storage) ? { ...rest, storage } : rest;
        }) : [],
      negativeHints: !legacy && index.sections?.negativeHints === 1 &&
        Array.isArray(index.negativeHints) && index.negativeHints.length <= 100000 ? index.negativeHints : [],
      maps: compilationCompatible ? { ...index.maps,
        entries: tilesCompatible && Array.isArray(index.maps.entries) ? index.maps.entries : [] } : null };
  } catch { return null; }
}

function assetIndexArtifacts(index) {
  if (!index || ![1, 2, 3].includes(index.schema) || index.kind !== 'pmjs-asset-index')
    throw new Error('Unsupported bundle asset index');
  if (!Array.isArray(index.images)) throw new Error('Invalid bundle asset index images');
  const imageOutputs = index.schema === 3
    ? index.images.map(record => record?.calculated?.outputs)
    : index.images.map(record => record?.outputs);
  if (imageOutputs.some(outputs => !Array.isArray(outputs)))
    throw new Error('Invalid bundle asset index images');
  const mapIndex = index.maps;
  if (mapIndex !== null && mapIndex !== undefined &&
      (!mapIndex || typeof mapIndex !== 'object' || Array.isArray(mapIndex)))
    throw new Error('Invalid bundle map index');
  const maps = mapIndex?.entries ?? [];
  if (!Array.isArray(maps) || maps.some(entry => !entry || !Array.isArray(entry.outputs)))
    throw new Error('Invalid bundle map entries');
  const outputs = [...imageOutputs.flat(), ...maps.flatMap(entry => entry.outputs)];
  if (outputs.some(page => !page || typeof page.path !== 'string' || typeof page.hash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(page.hash))) throw new Error('Invalid generated asset reference');
  return outputs.map(({ path: file, hash }) => ({ path: file, hash }));
}

module.exports = { generateAssetIndex, readAssetIndex, loadAssetIndex, offlineFilesystem, assetIndexArtifacts };
