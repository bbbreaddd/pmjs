'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { performance } = require('node:perf_hooks');
const { pipeline } = require('node:stream/promises');

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
function encryptedSource(source) {
  return typeof source === 'string' && !source.includes('\\') && !source.includes('\0') &&
    source.split('/').every(part => part && part !== '.' && part !== '..') &&
    (/^img\/.+\.png_$/i.test(source) || /^audio\/.+\.(ogg|m4a)_$/i.test(source));
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
    const sourceIdentity = native.assets.sourceIdentity?.('data/System.json');
    const data = await fsp.readFile(file);
    if (sourceIdentity !== undefined && native.assets.sourceIdentity('data/System.json') !== sourceIdentity) {
      throw new Error('encryption settings changed while reading');
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
      else if (entry.isFile() && (safeSource(name) || encryptedSource(name))) result.push(name);
    }
  }
  await visit('img');
  await visit('audio');
  return result;
}
async function readJson(file) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch (_) { return null; }
}
async function writeJson(file, data) {
  const handle = await fsp.open(file, 'wx');
  try { await handle.writeFile(JSON.stringify(data) + '\n'); await handle.sync(); } finally { await handle.close(); }
}
const activeLeases = new Map();
const installedLeases = new WeakMap();
let exitCleanupInstalled = false;

function processStart(pid) {
  try {
    const value = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return value.slice(value.lastIndexOf(')') + 2).split(' ')[19];
  } catch (_) { return null; }
}
function ownerAlive(owner) {
  if (!owner || !Number.isInteger(owner.pid) || owner.pid < 1) return false;
  if (owner.hostname !== os.hostname()) return true;
  try { process.kill(owner.pid, 0); }
  catch (error) { return error.code !== 'ESRCH'; }
  const start = processStart(owner.pid);
  return !owner.start || !start || owner.start === start;
}
async function createLease(cacheRoot, keys, native) {
  const file = path.join(cacheRoot, `.lease-${process.pid}-${crypto.randomBytes(8).toString('hex')}.json`);
  await writeJson(file, { pid: process.pid, hostname: os.hostname(), start: processStart(process.pid), keys });
  function release() {
    activeLeases.delete(file);
    try { fs.unlinkSync(file); } catch (_) {}
    if (installedLeases.get(native.assets) === release) installedLeases.delete(native.assets);
  }
  activeLeases.set(file, release);
  if (!exitCleanupInstalled) {
    process.once('exit', () => { for (const release of [...activeLeases.values()]) release(); });
    exitCleanupInstalled = true;
  }
  return release;
}
async function retainLeases(cacheRoot, retained) {
  for (const filename of await fsp.readdir(cacheRoot)) {
    if (!/^\.lease-\d+-[a-f0-9]+\.json$/.test(filename)) continue;
    const file = path.join(cacheRoot, filename);
    const lease = await readJson(file);
    if (!ownerAlive(lease) || !Array.isArray(lease.keys)) {
      await fsp.rm(file, { force: true });
      continue;
    }
    for (const key of lease.keys) if (HASH.test(key)) retained.add(key);
  }
}
async function acquireLock(cacheRoot, cancelled, onWait) {
  const lock = path.join(cacheRoot, '.prepare-lock');
  const started = performance.now();
  for (;;) {
    if (cancelled()) return null;
    try {
      await fsp.mkdir(lock);
      try { await writeJson(path.join(lock, 'owner.json'), { pid: process.pid, hostname: os.hostname(), start: processStart(process.pid) }); }
      catch (error) { await fsp.rm(lock, { recursive: true, force: true }); throw error; }
      return async () => fsp.rm(lock, { recursive: true, force: true });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const owner = await readJson(path.join(lock, 'owner.json'));
      let stale = false;
      if (owner && owner.hostname === os.hostname() && Number.isInteger(owner.pid) && owner.pid > 0) {
        stale = !ownerAlive(owner);
      } else if (owner && typeof owner.hostname === 'string' && Number.isInteger(owner.pid) && owner.pid > 0) {
        if (performance.now() - started >= 15000) {
          throw new Error('preparation cache is locked by another host; continuing with original images');
        }
      } else {
        try { stale = Date.now() - (await fsp.stat(lock)).mtimeMs > 60000; }
        catch (e) { if (e.code === 'ENOENT') continue; throw e; }
      }
      if (stale) { await fsp.rm(lock, { recursive: true, force: true }); continue; }
      onWait();
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
}
async function cachedEntry(directory, key, sourceHash) {
  const manifest = await readJson(path.join(directory, 'manifest.json'));
  if (!manifest || manifest.version !== CACHE_VERSION || manifest.key !== key || manifest.sourceHash !== sourceHash ||
      manifest.descriptorHash !== identity(manifest.descriptor)) return null;
  if (manifest.decrypted !== undefined && !/^source\.(png|ogg|m4a)$/.test(manifest.decrypted)) return null;
  if (manifest.descriptor !== null && !validDescriptor(manifest.descriptor)) return null;
  const pages = manifest.descriptor ? manifest.descriptor.pages : [];
  if (!manifest.outputs || Object.keys(manifest.outputs).length !== pages.length + (manifest.decrypted ? 1 : 0)) return null;
  const outputs = [...pages, ...(manifest.decrypted ? [{ path: manifest.decrypted }] : [])];
  for (const page of outputs) {
    const file = path.join(directory, page.path);
    const stat = await fsp.lstat(file).catch(() => null);
    if (!stat || !stat.isFile() || !HASH.test(manifest.outputs[page.path]) ||
        await hashFile(file) !== manifest.outputs[page.path]) return null;
    const handle = await fsp.open(file, 'r');
    const header = Buffer.alloc(24);
    try { if ((await handle.read(header, 0, 24, 0)).bytesRead !== 24) return null; }
    finally { await handle.close(); }
    if (page.path === manifest.decrypted) {
      if (!mediaHeader(header, path.extname(page.path))) return null;
    } else if (!header.subarray(0, 8).equals(PNG) || header.readUInt32BE(16) !== page.width ||
        header.readUInt32BE(20) !== page.height) return null;
  }
  return manifest;
}

async function prepareAssets({ gameRoot, cacheRoot, recipes = [], native, onProgress = () => {},
  shouldCancel = () => false, logger = console,
  processorIdentity = (native && native.assets && native.assets.preparationVersion) || PROCESSOR_IDENTITY }) {
  const started = performance.now();
  const result = { enabled: true, total: 0, completed: 0, generated: 0, hits: 0, negativeHits: 0,
    fallback: 0, prepared: 0, installed: 0, decrypted: 0, sourceBytes: 0, cacheBytes: 0,
    cancelled: false, entries: [], decryptedEntries: [], durationMs: 0 };
  let release;
  let terminalPhase = 'complete';
  const report = (phase, source = '', terminal = false) => onProgress({
    phase, source, terminal, completed: result.completed, total: result.total,
    remaining: result.total - result.completed, generated: result.generated, hits: result.hits,
    fallback: result.fallback, sourceBytes: result.sourceBytes, elapsedMs: performance.now() - started
  });
  const cancelled = () => { if (shouldCancel()) result.cancelled = true; return result.cancelled; };
  try {
    report('discover');
    if (cancelled()) return result;
    validRecipes(recipes);
    if (!native.assets || typeof native.assets.processImage !== 'function' || typeof native.assets.installPrepared !== 'function') {
      throw new Error('image preparation is unavailable in this addon');
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
    const indexName = 'index-' + identity(path.resolve(gameRoot)) + '.json';
    const recipeMap = new Map(recipes.map(recipe => [recipe.source, recipe]));
    const keys = [];
    for (const source of sources) {
      if (cancelled()) break;
      report('validate', source);
      let stage;
      let sourcePhase = 'validate';
      try {
        const encrypted = encryptedSource(source);
        const logicalSource = encrypted ? source.slice(0, -1) : source;
        const extension = path.extname(logicalSource).toLowerCase();
        if (encrypted && (!settings.key || !(extension === '.png' ? settings.images : settings.audio) ||
            typeof native.assets.installDecrypted !== 'function')) throw new Error('cached decryption is unavailable');
        if (encrypted && fs.existsSync(path.join(gameRoot, logicalSource))) throw new Error('plaintext source path already exists');
        const file = sourceFile(native, gameRoot, source);
        const sourceIdentity = typeof native.assets.sourceIdentity === 'function' ? native.assets.sourceIdentity(source) : undefined;
        const sourceHash = await hashFile(file);
        if (sourceIdentity !== undefined && native.assets.sourceIdentity(source) !== sourceIdentity) throw new Error('source changed while hashing');
        result.sourceBytes += (await fsp.stat(file)).size;
        let recipe = recipeMap.get(logicalSource);
        if (!recipe && !encrypted) recipe = await automaticRecipe(file, logicalSource, sourceHash);
        if (recipe && recipe.sourceHash !== sourceHash) throw new Error('recipe source hash changed');
        const key = identity({ version: CACHE_VERSION, processorIdentity, sourceHash, source, recipe: recipe || null,
          ...(encrypted ? { encryption: { version: 1, settingsHash: settings.hash }, characterLayout: 'mz-standard-v1' } : {}) });
        const directory = path.join(cacheRoot, 'entries', key);
        let manifest = await cachedEntry(directory, key, sourceHash);
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
          await writeJson(path.join(stage, 'manifest.json'), manifest);
          if (!await cachedEntry(stage, key, sourceHash)) throw new Error('prepared output validation failed');
          await fsp.rm(directory, { recursive: true, force: true });
          await fsp.rename(stage, directory);
          stage = null;
          result.generated += 1;
        }
        if (sourceIdentity !== undefined && native.assets.sourceIdentity(source) !== sourceIdentity) throw new Error('source changed during cache validation');
        if (encrypted && settings.sourceIdentity !== undefined &&
            native.assets.sourceIdentity('data/System.json') !== settings.sourceIdentity) throw new Error('encryption settings changed during preparation');
        keys.push(key);
        if (manifest.decrypted) {
          result.decryptedEntries.push({ source, logicalSource, file: path.join(directory, manifest.decrypted),
            sourceIdentity, settingsIdentity: settings.sourceIdentity });
          result.cacheBytes += (await fsp.stat(path.join(directory, manifest.decrypted))).size;
        }
        if (manifest.descriptor) {
          for (const page of manifest.descriptor.pages) result.cacheBytes += (await fsp.stat(path.join(directory, page.path))).size;
          result.entries.push({ source: logicalSource, directory, descriptor: manifest.descriptor, sourceHash, sourceIdentity,
            ...(encrypted ? { decryptedFile: path.join(directory, manifest.decrypted) } : {}) });
        } else if (!manifest.decrypted) result.fallback += 1;
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
      const releaseCacheLease = await createLease(cacheRoot, keys, native);
      const previousLease = installedLeases.get(native.assets);
      installedLeases.set(native.assets, releaseCacheLease);
      result.releaseCacheLease = releaseCacheLease;
      if (native.assets.installDecrypted) {
        await native.assets.installDecrypted(result.decryptedEntries);
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
      const installed = await native.assets.installPrepared(result.entries);
      if (previousLease) previousLease();
      result.prepared = result.entries.length;
      result.installed = Number.isInteger(installed) ? installed : result.entries.length;
      result.fallback += result.prepared - result.installed;
      if (result.installed < result.prepared) {
        logger.warn(`[pmjs] prepared image index installed ${result.installed}/${result.prepared}; remaining images use ordinary loading`);
      }
      report('cleanup');
      const indexStage = path.join(cacheRoot, '.' + indexName + '-' + crypto.randomBytes(6).toString('hex'));
      await writeJson(indexStage, { version: CACHE_VERSION, keys });
      await fsp.rename(indexStage, path.join(cacheRoot, indexName));
      const retained = new Set(keys);
      for (const filename of await fsp.readdir(cacheRoot)) {
        if (!filename.startsWith('index-') || !filename.endsWith('.json') || filename === indexName) continue;
        const other = await readJson(path.join(cacheRoot, filename));
        for (const key of other && Array.isArray(other.keys) ? other.keys : []) retained.add(key);
      }
      await retainLeases(cacheRoot, retained);
      for (const name of await fsp.readdir(path.join(cacheRoot, 'entries'))) {
        if (name.startsWith('.stage-') || (HASH.test(name) && !retained.has(name))) {
          await fsp.rm(path.join(cacheRoot, 'entries', name), { recursive: true, force: true });
        }
      }
    }
  } catch (error) {
    terminalPhase = 'error';
    result.fallback += result.total - result.completed;
    logger.warn(`[pmjs] asset preparation unavailable: ${error.message}`);
  } finally {
    if (release) {
      try { await release(); }
      catch (error) { logger.warn(`[pmjs] cannot release asset preparation lock: ${error.message}`); }
    }
    result.durationMs = performance.now() - started;
    cancelled();
    report(result.cancelled ? 'cancelled' : terminalPhase, '', true);
  }
  return result;
}

module.exports = { prepareAssets, validRecipes, validDescriptor, PROCESSOR_IDENTITY };
