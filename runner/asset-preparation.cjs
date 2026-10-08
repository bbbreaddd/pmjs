'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { pipeline } = require('node:stream/promises');
const { preparationFiles } = require('./preparation-files.cjs');
const { acquireLock, createLease, retainLeases } = require('./preparation-lifetime.cjs');
const { catalogInvalidator, readCatalog, publishCatalog } = require('./preparation-catalog.cjs');

const CACHE_VERSION = 1;
const PROCESSOR_IDENTITY = { processor: 'lossless-images-v2', decoder: 'png-rgba-v1', pageSize: 2048 };
const HASH = /^[a-f0-9]{64}$/;
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ENCRYPTED_HEADER = Buffer.from('5250474d560000000003010000000000', 'hex');

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}
function identity(value) {
  return crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}
async function hashFile(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
function safeSource(source) {
  return typeof source === 'string' && source.startsWith('img/') &&
    !source.includes('\\') && !source.includes('\0') &&
    source.split('/').every(part => part && part !== '.' && part !== '..') && /\.png$/i.test(source);
}
function decryptedSource(source) {
  if (typeof source !== 'string' || source.includes('\\') || source.includes('\0') ||
      !source.split('/').every(part => part && part !== '.' && part !== '..')) return null;
  const image = source.match(/^(img\/.+)\.(png_|rpgmvp)$/i);
  if (image) return image[2].endsWith('_') ? source.slice(0, -1) : image[1] + '.png';
  const audio = source.match(/^(audio\/.+)\.(ogg_|m4a_|rpgmvo|rpgmvm)$/i);
  if (!audio) return null;
  if (audio[2].endsWith('_')) return source.slice(0, -1);
  return audio[1] + (audio[2].toLowerCase() === 'rpgmvo' ? '.ogg' : '.m4a');
}
function sourceFile(native, gameRoot, source) {
  if (typeof native.assets.sourcePath === 'function') {
    const file = native.assets.sourcePath(source);
    if (!file) throw new Error('source is unavailable');
    return file;
  }
  return path.join(gameRoot, source);
}
async function encryptionSettings(native, gameRoot) {
  try {
    const file = sourceFile(native, gameRoot, 'data/System.json');
    if (!fs.existsSync(file)) return { images: false, audio: false, key: null };
    let sourceIdentity = native.assets.sourceIdentity?.('data/System.json');
    const read = () => native.fs?.readBytes ? Buffer.from(native.fs.readBytes('data/System.json')) : fsp.readFile(file);
    const data = await read();
    const current = native.assets.sourceIdentity?.('data/System.json');
    if (sourceIdentity !== undefined && current !== sourceIdentity) {
      if (!(await read()).equals(data) || native.assets.sourceIdentity('data/System.json') !== current)
        throw new Error('encryption settings changed while reading');
      sourceIdentity = current;
    }
    const system = JSON.parse(data);
    return { images: system.hasEncryptedImages === true, audio: system.hasEncryptedAudio === true,
      key: /^[a-f0-9]{32}$/i.test(system.encryptionKey) ? Buffer.from(system.encryptionKey, 'hex') : null,
      hash: crypto.createHash('sha256').update(data).digest('hex'), sourceIdentity };
  } catch (_) { return { images: false, audio: false, key: null }; }
}
function mediaHeader(bytes, extension) {
  if (extension === '.png') return bytes.subarray(0, 8).equals(PNG);
  if (extension === '.ogg') return bytes.subarray(0, 4).toString() === 'OggS' ||
    (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WAVE');
  return extension === '.m4a' && bytes.subarray(4, 8).toString() === 'ftyp';
}
async function decryptFile(file, output, key, extension) {
  const handle = await fsp.open(file, 'r');
  const prefix = Buffer.alloc(32);
  try { if ((await handle.read(prefix, 0, 32, 0)).bytesRead !== 32) throw new Error('encrypted asset is truncated'); }
  finally { await handle.close(); }
  if (!prefix.subarray(0, 16).equals(ENCRYPTED_HEADER)) throw new Error('invalid encrypted asset header');
  const body = prefix.subarray(16);
  for (let i = 0; i < 16; ++i) body[i] ^= key[i];
  if (!mediaHeader(body, extension)) throw new Error('decrypted media signature does not match encryption settings');
  await fsp.writeFile(output, body, { flag: 'wx' });
  await pipeline(fs.createReadStream(file, { start: 32 }), fs.createWriteStream(output, { flags: 'a' }));
}
async function automaticRecipe(file, source, sourceHash) {
  let grid;
  if (source.startsWith('img/sv_actors/')) grid = [9, 6];
  else if (source.startsWith('img/characters/')) {
    grid = /^[!$]*\$/.test(path.basename(source)) ? [3, 4] : [12, 8];
  }
  if (!grid) return undefined;
  const handle = await fsp.open(file, 'r');
  const header = Buffer.alloc(24);
  try { await handle.read(header, 0, 24, 0); } finally { await handle.close(); }
  if (header.subarray(0, 8).equals(PNG) && header.readUInt32BE(16) % grid[0] === 0 &&
      header.readUInt32BE(20) % grid[1] === 0) return { source, sourceHash, grid };
}
function validRecipes(value) {
  if (!Array.isArray(value)) throw new Error('asset recipes must be an array');
  const sources = new Set();
  for (const recipe of value) {
    if (!recipe || !safeSource(recipe.source) || !HASH.test(recipe.sourceHash) || sources.has(recipe.source)) {
      throw new Error('asset recipes require unique safe image paths and SHA-256 sourceHash');
    }
    sources.add(recipe.source);
    if (!Array.isArray(recipe.grid) || recipe.grid.length !== 2 ||
        !recipe.grid.every(n => Number.isSafeInteger(n) && n > 0) || recipe.grid[0] * recipe.grid[1] > 4096) {
      throw new Error(`invalid asset recipe grid: ${recipe.source}`);
    }
    if (recipe.crop !== undefined && (!Array.isArray(recipe.crop) || recipe.crop.length !== 4 ||
        !recipe.crop.every(n => Number.isSafeInteger(n) && n >= 0) || !recipe.crop[2] || !recipe.crop[3])) {
      throw new Error(`invalid asset recipe crop: ${recipe.source}`);
    }
    if (recipe.backdrop !== undefined && !rgba(recipe.backdrop)) throw new Error(`invalid asset recipe backdrop: ${recipe.source}`);
  }
  return value;
}
function rgba(value) {
  return Array.isArray(value) && value.length === 4 && value.every(n => Number.isInteger(n) && n >= 0 && n <= 255);
}
function rect(value, positive = true) {
  return Array.isArray(value) && value.length === 4 && value.every(n => Number.isSafeInteger(n) && n >= 0) &&
    (positive ? value[2] > 0 && value[3] > 0 : true);
}
function validDescriptor(d) {
  if (!d || d.version !== 1 || !Number.isSafeInteger(d.width) || !Number.isSafeInteger(d.height) ||
      d.width < 1 || d.height < 1 || !Array.isArray(d.pages) || !Array.isArray(d.cells) || d.pages.length > 4096 || d.cells.length > 4096) return false;
  if (d.uniform !== undefined && !rgba(d.uniform)) return false;
  if (d.halo !== undefined && (!Number.isInteger(d.halo) || d.halo < 1 || d.halo > 2048)) return false;
  if (d.pages.some(p => !p || !/^page-\d+\.png$/.test(p.path) || !Number.isInteger(p.width) ||
      !Number.isInteger(p.height) || p.width < 1 || p.height < 1 || p.width > 2048 || p.height > 2048)) return false;
  if (new Set(d.pages.map(p => p.path)).size !== d.pages.length) return false;
  let area = 0;
  for (let i = 0; i < d.cells.length; ++i) {
    const c = d.cells[i];
    if (!c || !rect(c.rect) || !rect(c.crop, false) || !rgba(c.fill) ||
        ((c.crop[2] === 0) !== (c.crop[3] === 0)) ||
        c.rect[0] + c.rect[2] > d.width || c.rect[1] + c.rect[3] > d.height ||
        c.crop[0] + c.crop[2] > c.rect[2] || c.crop[1] + c.crop[3] > c.rect[3]) return false;
    if (c.crop[2] && c.crop[3]) {
      const page = d.pages[c.page];
      if (!Number.isInteger(c.page) || !page || !rect(c.atlas) ||
          c.atlas[2] !== c.crop[2] || c.atlas[3] !== c.crop[3] ||
          c.atlas[0] + c.atlas[2] > page.width || c.atlas[1] + c.atlas[3] > page.height ||
          (d.halo !== undefined && (c.atlas[0] < d.halo || c.atlas[1] < d.halo ||
            c.atlas[0] + c.atlas[2] + d.halo > page.width || c.atlas[1] + c.atlas[3] + d.halo > page.height))) return false;
    }
    for (let j = 0; j < i; ++j) {
      const other = d.cells[j].rect;
      if (c.rect[0] < other[0] + other[2] && other[0] < c.rect[0] + c.rect[2] &&
          c.rect[1] < other[1] + other[3] && other[1] < c.rect[1] + c.rect[3]) return false;
    }
    area += c.rect[2] * c.rect[3];
  }
  return area === d.width * d.height || (d.uniform !== undefined && d.cells.length === 0 && d.pages.length === 0);
}
async function discover(gameRoot, cacheRoot) {
  const result = [];
  const root = await fsp.realpath(gameRoot);
  const entryDirectory = path.resolve(cacheRoot, 'entries');
  const ownedEntries = await fsp.realpath(entryDirectory).catch(() => entryDirectory);
  async function visit(relative) {
    const directory = path.join(root, relative);
    if (directory === ownedEntries) return;
    let files;
    try { files = await fsp.readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of files.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const name = relative + '/' + entry.name;
      if (entry.isDirectory()) await visit(name);
      else if (entry.isFile() && (safeSource(name) || decryptedSource(name))) result.push(name);
    }
  }
  await visit('img');
  await visit('audio');
  return result;
}
async function readJson(file) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch (_) { return null; }
}
async function writeJson(file, data, flush = true) {
  const handle = await fsp.open(file, 'wx');
  try {
    await handle.writeFile(JSON.stringify(data) + '\n');
    if (flush) await handle.sync();
  } finally { await handle.close(); }
}
const installedLeases = new WeakMap();

async function createImageLease(cacheRoot, keys, assets) {
  const releaseLease = await createLease(cacheRoot, keys);
  function release() {
    releaseLease();
    if (installedLeases.get(assets) === release) installedLeases.delete(assets);
  }
  return release;
}
async function cachedEntry(directory, key, sourceHash, files) {
  try {
    return await files.validatedJson(path.join(directory, 'manifest.json'), async (manifest, reused) => {
      if (!manifest || manifest.version !== CACHE_VERSION || manifest.key !== key || manifest.sourceHash !== sourceHash ||
          manifest.descriptorHash !== identity(manifest.descriptor)) return false;
      if (manifest.decrypted !== undefined && !/^source\.(png|ogg|m4a)$/.test(manifest.decrypted)) return false;
      if (manifest.descriptor !== null && !validDescriptor(manifest.descriptor)) return false;
      const pages = manifest.descriptor ? manifest.descriptor.pages : [];
      if (!manifest.outputs || Object.keys(manifest.outputs).length !== pages.length + (manifest.decrypted ? 1 : 0)) return false;
      const outputs = [...pages, ...(manifest.decrypted ? [{ path: manifest.decrypted }] : [])];
      for (const page of outputs) {
        const file = path.join(directory, page.path);
        if (!HASH.test(manifest.outputs[page.path])) return false;
        const checked = await files.inspect(file);
        if (checked.hash !== manifest.outputs[page.path]) return false;
        if (reused && checked.reused) continue;
        const handle = await fsp.open(file, 'r');
        const header = Buffer.alloc(24);
        try { if ((await handle.read(header, 0, 24, 0)).bytesRead !== 24) return false; }
        finally { await handle.close(); }
        if (page.path === manifest.decrypted) {
          if (!mediaHeader(header, path.extname(page.path))) return false;
        } else if (!header.subarray(0, 8).equals(PNG) || header.readUInt32BE(16) !== page.width ||
            header.readUInt32BE(20) !== page.height) return false;
      }
      return true;
    });
  } catch (_) { return null; }
}

async function prepareAssets({ gameRoot, cacheRoot, recipes = [], native, onProgress = () => {},
  shouldCancel = () => false, logger = console, verifyHashes = false,
  processorIdentity = (native && native.assets && native.assets.preparationVersion) || PROCESSOR_IDENTITY }) {
  const started = performance.now();
  const result = { enabled: true, total: 0, completed: 0, generated: 0, hits: 0, negativeHits: 0,
    fallback: 0, prepared: 0, installed: 0, decrypted: 0, sourceBytes: 0, cacheBytes: 0,
    cancelled: false, entries: [], decryptedEntries: [], durationMs: 0 };
  const catalogFile = path.join(cacheRoot, 'catalog-'+identity(path.resolve(gameRoot))+'.json');
  result.invalidateCatalog = catalogInvalidator(catalogFile, logger);
  let release;
  let catalogNegativeHits = 0;
  let terminalPhase = 'complete';
  const report = (phase, source = '', terminal = false) => onProgress({
    phase, source, terminal, completed: result.completed, total: result.total,
    remaining: result.total - result.completed, generated: result.generated, hits: result.hits,
    fallback: result.fallback, sourceBytes: result.sourceBytes, elapsedMs: performance.now() - started
  });
  async function clearIndexes() {
    const results = await Promise.allSettled([
      Promise.resolve().then(() => native.assets.installPrepared([])),
      Promise.resolve().then(() => native.assets.installDecrypted?.([]))
    ]);
    for (const value of results) if (value.status === 'rejected')
      logger.warn('[pmjs] cannot clear preparation index: '+value.reason.message);
  }
  const cancelled = () => { if (shouldCancel()) result.cancelled = true; return result.cancelled; };
  try {
    report('discover');
    if (cancelled()) return result;
    validRecipes(recipes);
    if (!native.assets || typeof native.assets.processImage !== 'function' || typeof native.assets.installPrepared !== 'function') {
      throw new Error('image preparation is unavailable in this addon');
    }

    const binding = { gameRoot: path.resolve(gameRoot), cacheRoot: path.resolve(cacheRoot), processorIdentity, recipes };
    const catalogCapable = typeof native.assets.installPreparedCatalog === 'function' &&
      typeof native.assets.installDerivedCatalog === 'function';
    if (!verifyHashes && catalogCapable) {
      await fsp.mkdir(cacheRoot, { recursive: true });
      release = await acquireLock(cacheRoot, cancelled, () => report('wait'));
      if (!release) return result;
      const catalog = await readCatalog(catalogFile, binding, cacheRoot);
      if (catalog && !cancelled()) {
        let lease;
        try {
          lease = await createImageLease(cacheRoot, catalog.keys, native.assets);
          await native.assets.installDerivedCatalog(catalog.decryptedEntries);
          const installed = await native.assets.installPreparedCatalog(catalog.entries);
          if (installed !== catalog.entries.length) throw new Error('incomplete image catalog installation');
          if (cancelled()) throw new Error('catalog installation cancelled');
          const previous = installedLeases.get(native.assets);
          installedLeases.set(native.assets, lease);
          if (previous) previous();
          Object.assign(result, catalog.summary, { entries: catalog.entries, decryptedEntries: catalog.decryptedEntries,
            generated: 0, catalogHit: true, releaseCacheLease: lease });
          report('install');
          return result;
        } catch (_) {
          if (lease) lease();
          await clearIndexes();
        }
      }
      await release(); release = undefined;
      if (cancelled()) return result;
    }
    const sources = await discover(gameRoot, cacheRoot);
    const settings = await encryptionSettings(native, gameRoot);
    result.total = sources.length;
    report('discover');
    if (cancelled()) return result;
    if (!sources.length) {
      report('install');
      if (cancelled()) return result;
      await native.assets.installPrepared([]);
      if (native.assets.installDecrypted) native.assets.installDecrypted([]);
      return result;
    }
    await fsp.mkdir(path.join(cacheRoot, 'entries'), { recursive: true });
    release = await acquireLock(cacheRoot, cancelled, () => report('wait'));
    if (!release) return result;
    const files = await preparationFiles(cacheRoot, verifyHashes);
    result.validation = files.stats;
    async function refreshIdentity(source, expectedHash, previous) {
      const current = native.assets.sourceIdentity?.(source);
      if (current === undefined || current === previous) return current;
      const file = sourceFile(native, gameRoot, source);
      if (await files.hash(file) !== expectedHash || native.assets.sourceIdentity(source) !== current)
        throw new Error('source changed while validating '+source);
      return current;
    }
    const indexName = 'index-' + identity(path.resolve(gameRoot)) + '.json';
    const recipeMap = new Map(recipes.map(recipe => [recipe.source, recipe]));
    const keys = [];
    for (const source of sources) {
      if (cancelled()) break;
      report('validate', source);
      let stage;
      let sourcePhase = 'validate';
      try {
        const decryptedPath = decryptedSource(source);
        const encrypted = decryptedPath !== null;
        const logicalSource = decryptedPath || source;
        const extension = path.extname(logicalSource).toLowerCase();
        if (encrypted && (!settings.key || !(extension === '.png' ? settings.images : settings.audio) ||
            typeof native.assets.installDecrypted !== 'function')) throw new Error('cached decryption is unavailable');
        if (encrypted && fs.existsSync(path.join(gameRoot, logicalSource))) throw new Error('plaintext source path already exists');
        const file = sourceFile(native, gameRoot, source);
        let sourceIdentity = typeof native.assets.sourceIdentity === 'function' ? native.assets.sourceIdentity(source) : undefined;
        const checkedSource = await files.inspect(file), sourceHash = checkedSource.hash;
        if (sourceIdentity !== undefined && native.assets.sourceIdentity(source) !== sourceIdentity) throw new Error('source changed while hashing');
        result.sourceBytes += checkedSource.size;
        let recipe = recipeMap.get(logicalSource);
        if (!recipe && !encrypted) recipe = await automaticRecipe(file, logicalSource, sourceHash);
        if (recipe && recipe.sourceHash !== sourceHash) throw new Error('recipe source hash changed');
        const key = identity({ version: CACHE_VERSION, processorIdentity, sourceHash, source, recipe: recipe || null,
          ...(encrypted ? { encryption: { version: 1, settingsHash: settings.hash }, characterLayout: 'mz-standard-v1' } : {}) });
        const directory = path.join(cacheRoot, 'entries', key);
        let manifest = await cachedEntry(directory, key, sourceHash, files);
        if (manifest && encrypted && manifest.decrypted !== 'source' + extension) manifest = null;
        if (manifest) {
          result.hits += 1;
          if (!manifest.descriptor && !manifest.decrypted) result.negativeHits += 1;
        } else {
          sourcePhase = 'prepare';
          report('prepare', source);
          if (cancelled()) break;
          stage = await fsp.mkdtemp(path.join(cacheRoot, 'entries', '.stage-'));
          const decrypted = encrypted ? 'source' + extension : undefined;
          let input = file;
          if (decrypted) {
            input = path.join(stage, decrypted);
            await decryptFile(file, input, settings.key, extension);
            if (!recipe) recipe = await automaticRecipe(input, logicalSource, sourceHash);
          }
          if (cancelled()) break;
          const descriptor = extension === '.png' ? await native.assets.processImage(source, stage, recipe || null,
            ...(encrypted ? [input] : [])) : null;
          if (cancelled()) break;
          if (descriptor !== null && !validDescriptor(descriptor)) throw new Error('processor returned invalid logical image descriptor');
          if (await hashFile(file) !== sourceHash) throw new Error('source changed during image preparation');
          const outputs = {};
          if (decrypted) outputs[decrypted] = await hashFile(input);
          for (const page of descriptor ? descriptor.pages : []) outputs[page.path] = await hashFile(path.join(stage, page.path));
          manifest = { version: CACHE_VERSION, key, sourceHash, descriptor, descriptorHash: identity(descriptor), outputs,
            ...(decrypted ? { decrypted } : {}) };
          // Cache entries are disposable and hash-validated; locks, leases and indexes still flush.
          await writeJson(path.join(stage, 'manifest.json'), manifest, false);
          if (!await cachedEntry(stage, key, sourceHash, files)) throw new Error('prepared output validation failed');
          await fsp.rm(directory, { recursive: true, force: true });
          await fsp.rename(stage, directory);
          stage = null;
          for (const output of Object.keys(outputs)) await files.hash(path.join(directory, output));
          if (!await cachedEntry(directory, key, sourceHash, files)) throw new Error('published output validation failed');
          result.generated += 1;
        }
        sourceIdentity = await refreshIdentity(source, sourceHash, sourceIdentity);
        if (encrypted) settings.sourceIdentity = await refreshIdentity('data/System.json', settings.hash, settings.sourceIdentity);
        keys.push(key);
        if (manifest.decrypted) {
          result.decryptedEntries.push({ source, logicalSource, file: path.join(directory, manifest.decrypted),
            sourceIdentity, sourceHash, settingsIdentity: settings.sourceIdentity });
          result.cacheBytes += (await fsp.stat(path.join(directory, manifest.decrypted))).size;
        }
        if (manifest.descriptor) {
          for (const page of manifest.descriptor.pages) result.cacheBytes += (await fsp.stat(path.join(directory, page.path))).size;
          result.entries.push({ source: logicalSource, directory, descriptor: manifest.descriptor, sourceHash, sourceIdentity,
            ...(encrypted ? { decryptedFile: path.join(directory, manifest.decrypted) } : {}) });
        } else if (!manifest.decrypted) { result.fallback += 1; ++catalogNegativeHits; }
      } catch (error) {
        result.fallback += 1;
        logger.warn(`[pmjs] asset preparation fallback ${source}: ${error.message}`);
      } finally {
        if (stage) await fsp.rm(stage, { recursive: true, force: true });
      }
      result.completed += 1;
      report(sourcePhase, source);
    }
    if (!cancelled()) {
      report('install');
      if (cancelled()) return result;
      if (result.decryptedEntries.length) {
        settings.sourceIdentity = await refreshIdentity('data/System.json', settings.hash, settings.sourceIdentity);
        for (const entry of result.decryptedEntries) {
          entry.sourceIdentity = await refreshIdentity(entry.source, entry.sourceHash, entry.sourceIdentity);
          entry.settingsIdentity = settings.sourceIdentity;
        }
      }
      const releaseCacheLease = await createImageLease(cacheRoot, keys, native.assets);
      const previousLease = installedLeases.get(native.assets);
      installedLeases.set(native.assets, releaseCacheLease);
      result.releaseCacheLease = releaseCacheLease;
      if (native.assets.installDecrypted) {
        await native.assets.installDecrypted(result.decryptedEntries, catalogCapable);
        result.decrypted = result.decryptedEntries.filter(entry => native.assets.hasDecrypted(entry.logicalSource)).length;
        result.fallback += result.decryptedEntries.length - result.decrypted;
        result.entries = result.entries.filter(entry => {
          if (!entry.decryptedFile) return true;
          if (!native.assets.hasDecrypted(entry.source)) return false;
          entry.sourceIdentity = native.assets.sourceIdentity(entry.source);
          if (native.assets.sourcePath(entry.source) !== entry.decryptedFile) return false;
          delete entry.decryptedFile;
          return true;
        });
      }
      const installed = await native.assets.installPrepared(result.entries, catalogCapable);
      if (previousLease) previousLease();
      result.prepared = result.entries.length;
      result.installed = Number.isInteger(installed) ? installed : result.entries.length;
      result.fallback += result.prepared - result.installed;
      if (result.installed < result.prepared) {
        logger.warn(`[pmjs] prepared image index installed ${result.installed}/${result.prepared}; remaining images use ordinary loading`);
      }
      if (catalogCapable && result.installed === result.entries.length && result.decrypted === result.decryptedEntries.length) {
        const summary = Object.fromEntries(Object.entries(result).filter(([, value]) => typeof value === 'number'));
        summary.hits = keys.length;
        summary.negativeHits = catalogNegativeHits;
        await publishCatalog(catalogFile, binding, cacheRoot, { keys, entries: result.entries,
          decryptedEntries: result.decryptedEntries, summary });
      }
      report('cleanup');
      await files.save();
      const indexStage = path.join(cacheRoot, '.' + indexName + '-' + crypto.randomBytes(6).toString('hex'));
      await writeJson(indexStage, { version: CACHE_VERSION, keys });
      await fsp.rename(indexStage, path.join(cacheRoot, indexName));
      const retained = new Set(keys);
      for (const filename of await fsp.readdir(cacheRoot)) {
        if (!/^(index|catalog)-/.test(filename) || !filename.endsWith('.json') || filename === indexName) continue;
        const other = await readJson(path.join(cacheRoot, filename));
        for (const key of other && Array.isArray(other.keys || other.payload?.keys) ? (other.keys || other.payload.keys) : []) if (HASH.test(key)) retained.add(key);
      }
      const mapRoot = path.join(cacheRoot, 'maps');
      for (const filename of await fsp.readdir(mapRoot).catch(() => [])) {
        if (!/^catalog-[a-f0-9]{64}\.json$/.test(filename)) continue;
        const catalog = await readJson(path.join(mapRoot, filename));
        for (const key of Array.isArray(catalog?.payload?.keys) ? catalog.payload.keys : []) if (HASH.test(key)) retained.add(key);
      }
      if (fs.existsSync(mapRoot)) await retainLeases(mapRoot, retained);
      await retainLeases(cacheRoot, retained);
      for (const name of await fsp.readdir(path.join(cacheRoot, 'entries'))) {
        if (name.startsWith('.stage-') || (HASH.test(name) && !retained.has(name))) {
          await fsp.rm(path.join(cacheRoot, 'entries', name), { recursive: true, force: true });
        }
      }
    }
  } catch (error) {
    terminalPhase = 'error';
    if (result.releaseCacheLease) {
      result.releaseCacheLease(); delete result.releaseCacheLease;
      await clearIndexes();
      result.installed = result.decrypted = 0;
    }
    result.fallback += result.total - result.completed;
    logger.warn(`[pmjs] asset preparation unavailable: ${error.message}`);
  } finally {
    if (release) {
      try { await release(); }
      catch (error) { logger.warn(`[pmjs] cannot release asset preparation lock: ${error.message}`); }
    }
    result.durationMs = performance.now() - started;
    cancelled();
    if (result.cancelled && result.releaseCacheLease) {
      result.releaseCacheLease(); delete result.releaseCacheLease;
      await clearIndexes();
      result.installed = result.decrypted = 0;
    }
    report(result.cancelled ? 'cancelled' : terminalPhase, '', true);
  }
  return result;
}

module.exports = { prepareAssets, validRecipes, validDescriptor, PROCESSOR_IDENTITY };
