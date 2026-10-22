'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { pipeline } = require('node:stream/promises');
const { yedSideviewFrames } = require('./yed-sideview-recipes.cjs');

const CACHE_VERSION = 1;
const PROCESSOR_IDENTITY = { processor: 'images-v15-sparse-palette-astcenc4.7', decoder: 'png-rgba-v1', pageSize: 2048 };
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
function hasPathPrefix(source, prefix) {
  return typeof source === 'string' && source.toLowerCase().startsWith(prefix.toLowerCase());
}
async function hashFile(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
function validLosslessPrefixes(value = []) {
  if (!Array.isArray(value) || value.some(prefix => {
    if (typeof prefix !== 'string' || !hasPathPrefix(prefix, 'img/') || prefix.includes('\\') || prefix.includes('\0')) return true;
    const parts = (prefix.endsWith('/') ? prefix.slice(0, -1) : prefix).split('/');
    return parts.some(part => !part || part === '.' || part === '..');
  })) throw new Error('assetPreparation.losslessPrefixes must contain safe image path prefixes');
  return value.slice();
}
function astcSettings(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      (value.enabled !== undefined && typeof value.enabled !== 'boolean') ||
      (value.quality !== undefined && !['fast', 'medium', 'thorough'].includes(value.quality)))
    throw new Error('assetPreparation.astc requires a boolean enabled and quality fast, medium or thorough');
  return { enabled: value.enabled ?? false, quality: value.quality ?? 'medium' };
}
function safeSource(source) {
  return typeof source === 'string' && hasPathPrefix(source, 'img/') &&
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
async function encryptionSettings(native, gameRoot, files) {
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
      hash: files.inspectSync(file, data, 'settings').hash, sourceIdentity };
  } catch (_) { return { images: false, audio: false, key: null }; }
}
function mediaHeader(bytes, extension) {
  if (extension === '.png') return bytes.subarray(0, 8).equals(PNG);
  if (extension === '.ogg') return bytes.subarray(0, 4).toString() === 'OggS' ||
    (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WAVE');
  return extension === '.m4a' && bytes.subarray(4, 8).toString() === 'ftyp';
}
function pageHeaderMatches(header, page, size) {
  if (page.path.endsWith('.astc')) {
    const dimension = offset => header.readUIntLE(offset, 3);
    return header.length >= 16 && header.readUInt32LE(0) === 0x5ca1ab13 &&
      header[4] === 4 && header[5] === 4 && header[6] === 1 && dimension(7) === page.width &&
      dimension(10) === page.height && dimension(13) === 1 &&
      size === 16 + Math.ceil(page.width / 4) * Math.ceil(page.height / 4) * 16;
  }
  if (page.path.endsWith('.pml4')) {
    const version = header.readUInt32LE(4), width = header.readUInt32LE(8), height = header.readUInt32LE(12);
    const decoded = header.readUInt32LE(16), length = header.readUInt32LE(20), count = width * height;
    return header.length >= 32 && header.toString('ascii', 0, 4) === 'PML4' && [1, 2, 3].includes(version) &&
      width === page.width && height === page.height &&
      (version === 1 ? decoded === count * 4 :
        version === 2 ? decoded >= 8 && decoded <= count * 4 :
          decoded >= count + 8 && decoded <= count + 1028) &&
      length > 0 && length === size - 32;
  }
  return header.length >= 24 && header.subarray(0, 8).equals(PNG) &&
    header.readUInt32BE(16) === page.width && header.readUInt32BE(20) === page.height;
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
async function automaticRecipe(file, source, sourceHash, header, frames = new Map()) {
  let grid;
  const frame = frames.get(source.toLowerCase()) ?? frames.get(source);
  const filenameGrid = path.basename(source).match(/\[([1-9]\d*)x([1-9]\d*)\]\.png$/i);
  if (filenameGrid) {
    grid = filenameGrid.slice(1).map(Number);
    if (!grid.every(Number.isSafeInteger) || grid[0] > 4096 / grid[1]) return undefined;
  } else if (hasPathPrefix(source, 'img/sv_actors/')) grid = [9, 6];
  else if (hasPathPrefix(source, 'img/characters/')) {
    grid = /^[!$]*\$/.test(path.basename(source)) ? [3, 4] : [12, 8];
  }
  if (!grid && !hasPathPrefix(source, 'img/parallaxes/')) return undefined;
  if (!header) {
    const handle = await fsp.open(file, 'r');
    header = Buffer.alloc(24);
    try { if ((await handle.read(header, 0, 24, 0)).bytesRead !== 24) return undefined; }
    finally { await handle.close(); }
  }
  if (frame !== undefined) {
    if (!frame || header.length < 24 || !header.subarray(0, 8).equals(PNG)) return undefined;
    grid = [header.readUInt32BE(16) / frame.width, header.readUInt32BE(20) / frame.height];
    if (!grid.every(n => Number.isSafeInteger(n) && n > 0) || grid[0] > 4096 / grid[1]) return undefined;
  } else if (!filenameGrid && hasPathPrefix(source, 'img/sv_actors/') &&
      header.length >= 24 && header.subarray(0, 8).equals(PNG)) {
    const width = header.readUInt32BE(16), height = header.readUInt32BE(20);
    grid = [[9, 6], [4, 6], [4, 8], [4, 1], [3, 4]].find(
      ([columns, rows]) => width > 0 && height > 0 && width % columns === 0 && height % rows === 0);
  }
  if (!grid && header.length >= 24 && header.subarray(0, 8).equals(PNG)) {
    const width = header.readUInt32BE(16), height = header.readUInt32BE(20);
    if (width >= 2048 && height >= 2048) {
      const divisions = extent => {
        for (let count = Math.ceil(extent / 1536); count <= extent; ++count)
          if (extent % count === 0) return count;
        return null;
      };
      const columns = divisions(width), rows = divisions(height);
      if (columns && rows && columns * rows <= 4096) grid = [columns, rows];
    }
  }
  if (!grid) return undefined;
  if (header.length >= 24 && header.subarray(0, 8).equals(PNG) && header.readUInt32BE(16) > 0 && header.readUInt32BE(20) > 0 &&
      header.readUInt32BE(16) % grid[0] === 0 &&
      header.readUInt32BE(20) % grid[1] === 0) return { source, sourceHash, grid };
}
function validRecipes(value) {
  if (!Array.isArray(value)) throw new Error('asset recipes must be an array');
  const sources = new Set();
  for (const recipe of value) {
    const key = typeof recipe?.source === 'string' ? recipe.source.toLowerCase() : '';
    if (!recipe || !safeSource(recipe.source) || !HASH.test(recipe.sourceHash) || sources.has(key)) {
      throw new Error('asset recipes require unique safe image paths and SHA-256 sourceHash');
    }
    sources.add(key);
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
function validStorageDecision(value) {
  return value && value.version === 1 &&
    [value.width, value.height].every(n => Number.isSafeInteger(n) && n > 0 && n <= 8192) &&
    [0, 8, 16].includes(value.paletteBits) && [1, 2, 4].includes(value.channels) &&
    Array.isArray(value.source) && value.source.length === 4 &&
    value.source.every(n => Number.isInteger(n) && n >= 0 && n < 4) &&
    Array.isArray(value.swizzle) && value.swizzle.length === 4 &&
    value.swizzle.every(n => Number.isInteger(n) && (n >= 0 && n < value.channels || n === 4 || n === 5)) &&
    (!value.paletteBits || value.channels === 4) &&
    (value.pixelFactsVersion === undefined || value.pixelFactsVersion === 1 &&
      typeof value.opaque === 'boolean' && typeof value.allZero === 'boolean' &&
      !(value.opaque && value.allZero) &&
      (value.sparseRegions === null || Array.isArray(value.sparseRegions) && value.sparseRegions.length <= 64 &&
        value.sparseRegions.every(r => rect(r) && r[0] + r[2] <= value.width && r[1] + r[3] <= value.height)));
}

function validDescriptor(d) {
  if (!d || d.version !== 1 || !Number.isSafeInteger(d.width) || !Number.isSafeInteger(d.height) ||
      d.width < 1 || d.height < 1 || !Array.isArray(d.pages) || !Array.isArray(d.cells) || d.pages.length > 4096 || d.cells.length > 4096) return false;
  if (d.workspaceConstrained !== undefined && typeof d.workspaceConstrained !== 'boolean') return false;
  if (d.compression !== undefined) {
    return d.compression === 'astc-4x4' && d.width <= 8192 && d.height <= 8192 &&
      d.width * d.height <= 32 * 1024 * 1024 && d.halo === 1 && d.uniform === undefined &&
      d.blockGrid === undefined && d.cells.length === 0 && [1, 2].includes(d.pages.length) &&
      d.pages.every((p, i) => p && p.path === `page-${i}.astc` && p.width === d.width && p.height === d.height);
  }
  if (d.uniform !== undefined && !rgba(d.uniform)) return false;
  if (d.halo !== undefined && (!Number.isInteger(d.halo) || d.halo < 1 || d.halo > 2048)) return false;
  if (d.compactEligible !== undefined && typeof d.compactEligible !== 'boolean') return false;
  if (d.blockChannels !== undefined && (!d.blockGrid || ![0, 1, 2].includes(d.blockChannels))) return false;
  if (d.blockGrid !== undefined) {
    const g = d.blockGrid;
    if (d.uniform !== undefined || !Array.isArray(g) || g.length !== 3 || g[0] !== 64 ||
        !g.every(n => Number.isSafeInteger(n) && n > 0) || d.width % g[1] || d.height % g[2] ||
        Math.ceil(g[1] / 64) * Math.ceil(g[2] / 64) * (d.width / g[1]) * (d.height / g[2]) > 65536) return false;
  }
  if (d.pages.some(p => !p || !/^page-\d+\.(png|pml4|astc)$/.test(p.path) || !Number.isInteger(p.width) ||
      !Number.isInteger(p.height) || p.width < 1 || p.height < 1 || p.width > 2048 || p.height > 2048)) return false;
  if (d.pages.some(p => p.storage !== undefined && (!validStorageDecision(p.storage) ||
      p.storage.width !== p.width || p.storage.height !== p.height))) return false;
  if (new Set(d.pages.map(p => p.path)).size !== d.pages.length) return false;
  let area = 0;
  let occupiedBlocks;
  let blocksPerFrameX = 0, blocksPerFrameY = 0, blocksAcross = 0;
  if (d.blockGrid) {
    const [, frameWidth, frameHeight] = d.blockGrid;
    blocksPerFrameX = Math.ceil(frameWidth / 64);
    blocksPerFrameY = Math.ceil(frameHeight / 64);
    blocksAcross = blocksPerFrameX * (d.width / frameWidth);
    const totalBlocks = blocksAcross * blocksPerFrameY * (d.height / frameHeight);
    occupiedBlocks = new Uint8Array(totalBlocks);
  }
  for (let i = 0; i < d.cells.length; ++i) {
    const c = d.cells[i];
    if (!c || !rect(c.rect) || !rect(c.crop, false) || !rgba(c.fill) ||
        ((c.crop[2] === 0) !== (c.crop[3] === 0)) ||
        c.rect[0] + c.rect[2] > d.width || c.rect[1] + c.rect[3] > d.height ||
        c.crop[0] + c.crop[2] > c.rect[2] || c.crop[1] + c.crop[3] > c.rect[3]) return false;
    if (d.blockGrid) {
      const [, fw, fh] = d.blockGrid;
      const [x, y, w, h] = c.rect, lx = x % fw, ly = y % fh;
      if (lx + w > fw || ly + h > fh || lx % 64 || ly % 64 ||
          ((lx + w) % 64 && lx + w !== fw) || ((ly + h) % 64 && ly + h !== fh) ||
          (c.crop[2] && (w !== Math.min(64, fw - lx) || h !== Math.min(64, fh - ly) ||
            c.crop[0] !== 0 || c.crop[1] !== 0 || c.crop[2] !== w || c.crop[3] !== h))) return false;
    }
    if (c.crop[2] && c.crop[3]) {
      const page = d.pages[c.page];
      if (!Number.isInteger(c.page) || !page || !rect(c.atlas) ||
          c.atlas[2] !== c.crop[2] || c.atlas[3] !== c.crop[3] ||
          c.atlas[0] + c.atlas[2] > page.width || c.atlas[1] + c.atlas[3] > page.height ||
          (d.halo !== undefined && (c.atlas[0] < d.halo || c.atlas[1] < d.halo ||
            c.atlas[0] + c.atlas[2] + d.halo > page.width || c.atlas[1] + c.atlas[3] + d.halo > page.height))) return false;
    }
    if (occupiedBlocks) {
      const [, frameWidth, frameHeight] = d.blockGrid;
      const [x, y, w, h] = c.rect;
      const frameX = Math.floor(x / frameWidth), frameY = Math.floor(y / frameHeight);
      const localX = x % frameWidth, localY = y % frameHeight;
      const firstBlockX = frameX * blocksPerFrameX + Math.floor(localX / 64);
      const lastBlockX = frameX * blocksPerFrameX + Math.ceil((localX + w) / 64);
      const firstBlockY = frameY * blocksPerFrameY + Math.floor(localY / 64);
      const lastBlockY = frameY * blocksPerFrameY + Math.ceil((localY + h) / 64);
      for (let blockY = firstBlockY; blockY < lastBlockY; ++blockY) {
        for (let blockX = firstBlockX; blockX < lastBlockX; ++blockX) {
          const index = blockY * blocksAcross + blockX;
          if (occupiedBlocks[index]) return false;
          occupiedBlocks[index] = 1;
        }
      }
    } else {
      for (let j = 0; j < i; ++j) {
        const other = d.cells[j].rect;
        if (c.rect[0] < other[0] + other[2] && other[0] < c.rect[0] + c.rect[2] &&
            c.rect[1] < other[1] + other[3] && other[1] < c.rect[1] + c.rect[3]) return false;
      }
    }
    area += c.rect[2] * c.rect[3];
  }
  return area === d.width * d.height || (d.uniform !== undefined && d.cells.length === 0 && d.pages.length === 0);
}
async function cachedEntry(directory, key, sourceHash, files) {
  try {
    return await files.validatedManifest(directory, async (manifest, reused) => {
      if (!manifest || manifest.version !== CACHE_VERSION || manifest.key !== key || manifest.sourceHash !== sourceHash ||
          manifest.descriptorHash !== identity(manifest.descriptor)) return false;
      if (manifest.decrypted !== undefined && !/^source\.(png|ogg|m4a)$/.test(manifest.decrypted)) return false;
      if (manifest.descriptor !== null && !validDescriptor(manifest.descriptor)) return false;
      const pages = manifest.descriptor ? manifest.descriptor.pages : [];
      if (!manifest.outputs || Object.keys(manifest.outputs).length !== pages.length + (manifest.decrypted ? 1 : 0)) return false;
      const outputs = [...pages, ...(manifest.decrypted ? [{ path: manifest.decrypted }] : [])];
      return files.validateOutputs(directory, outputs, page => manifest.outputs[page.path], async (page, file, checked) => {
        if (reused && checked.reused) return true;
        let header = checked.header;
        if (!header) {
          const handle = await fsp.open(file, 'r');
          header = Buffer.alloc(page.path.endsWith('.pml4') ? 32 : 24);
          try { if ((await handle.read(header, 0, header.length, 0)).bytesRead !== header.length) return false; }
          finally { await handle.close(); }
        }
        if (page.path === manifest.decrypted) {
          return mediaHeader(header, path.extname(page.path));
        }
        return pageHeaderMatches(header, page, checked.size);
      });
    });
  } catch (_) { return null; }
}

async function prepareAssetsPhase({ gameRoot, cacheRoot, recipes, native, onProgress = () => {},
  shouldCancel = () => false, logger = console, verifyHashes = false,
  workspaceBytes = 256 * 1024 * 1024,
  pageCodec = 'lz4',
  losslessPrefixes,
  astc,
  preparationContext = 'live',
  portableIndex = null, portableAssetRoot = null, policyOverrides = null,
  processorIdentity = (native && native.assets && native.assets.preparationVersion) || PROCESSOR_IDENTITY, session }) {
  if (!session) throw new Error('asset preparation phase requires a preparation session');
  cacheRoot = session.root;
  policyOverrides ||= { astc: astc !== undefined, losslessPrefixes: losslessPrefixes !== undefined,
    recipes: recipes !== undefined };
  recipes ||= [];
  losslessPrefixes = validLosslessPrefixes(losslessPrefixes || []);
  astc = astcSettings(astc);
  if (!['live', 'offline'].includes(preparationContext)) throw new Error('invalid preparation context');
  if (!['png', 'lz4'].includes(pageCodec)) throw new Error('assetPreparation.pageCodec must be png or lz4');
  if (!Number.isSafeInteger(workspaceBytes) || workspaceBytes < 0 || workspaceBytes > 256 * 1024 * 1024)
    throw new Error('assetPreparation.workspaceBytes must be an integer from 0 to 268435456');
  const offline = preparationContext === 'offline';
  const audioViewSupport = !offline && typeof native?.media?.installAudioViews === 'function';
  const audioSettings = audioViewSupport ? await encryptionSettings(native, gameRoot, session.files) : null;
  const indexedImages = new Map();
  for (const record of portableIndex?.images || []) {
    const records = indexedImages.get(record.source);
    if (records) records.push(record);
    else indexedImages.set(record.source, [record]);
  }
  const started = performance.now();
  const result = { enabled: true, total: 0, completed: 0, generated: 0, hits: 0, negativeHits: 0,
    fallback: 0, failedFiles: 0, installFailures: 0, prepared: 0, installed: 0, decrypted: 0, sourceBytes: 0, cacheBytes: 0,
    indexedNegative: 0, indexedLayoutAttempts: 0, indexedZeroPage: 0,
    indexedPageCopies: 0, unindexedProcessed: 0, processingMs: 0,
    cancelled: false, entries: [], decryptedEntries: [], audioViewEntries: [], audioViews: 0, decisions: [], storageEntries: [], durationMs: 0 };


  let terminalPhase = 'complete', activationStarted = false;
  const report = (phase, source = '', terminal = false) => onProgress({
    phase, source, terminal, completed: result.completed, total: result.total,
    remaining: result.total - result.completed, generated: result.generated, hits: result.hits,
    fallback: result.fallback, sourceBytes: result.sourceBytes, elapsedMs: performance.now() - started
  });
  async function clearIndexes() {
    const results = await Promise.allSettled([
      Promise.resolve().then(() => native.assets.installPrepared([])),
      Promise.resolve().then(() => native.assets.installImageStorage?.([])),
      Promise.resolve().then(() => native.assets.installDecrypted?.([])),
      Promise.resolve().then(() => native.media?.installAudioViews?.([]))
    ]);
    for (const value of results) if (value.status === 'rejected')
      logger.warn('[pmjs] cannot clear preparation index: '+value.reason.message);
  }
  const cancelled = () => { if (shouldCancel()) result.cancelled = true; return result.cancelled; };
  try {
    report('discover');
    if (cancelled()) return result;
    validRecipes(recipes);
    if (pageCodec === 'lz4') {
      if (native.assets?.preparationWorkspaceVersion !== 1 || typeof native.assets?.preparationLz4Version !== 'string')
        throw new Error('LZ4 image preparation is unavailable in this addon; requires preparationWorkspaceVersion 1 and preparationLz4Version');
      processorIdentity = { ...processorIdentity, pageCodec: native.assets.preparationLz4Version };
    }
    if (!native.assets || typeof native.assets.processImage !== 'function' ||
        (!offline && typeof native.assets.installPrepared !== 'function')) {
      throw new Error('image preparation is unavailable in this addon');
    }

    const discoveredFrames = await yedSideviewFrames(async source => {
      if (native.fs?.readBytes) {
        const bytes = native.fs.readBytes(source);
        return bytes === null ? null : Buffer.from(bytes);
      }
      const file = typeof native.assets.sourcePath === 'function'
        ? native.assets.sourcePath(source) : path.join(gameRoot, source);
      if (!file) return null;
      try { return await fsp.readFile(file); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    }, logger);
    const frames = new Map([...discoveredFrames].map(([source, frame]) => [source.toLowerCase(), frame]));
    const automaticRecipes = { version: 1, sideview: [...frames].sort(([a], [b]) => a.localeCompare(b)) };
    report('discover');
    const sources = session.inventory.filter(source => safeSource(source) || decryptedSource(source));
    const settings = await encryptionSettings(native, gameRoot, session.files);
    result.total = sources.length;
    report('discover');
    if (cancelled()) return result;
    if (!sources.length) {
      report('install');
      if (cancelled()) return result;
      if (!offline) {
        await native.assets.installPrepared([]);
        if (native.assets.installDecrypted) await native.assets.installDecrypted([]);
        if (audioViewSupport) native.media.installAudioViews([]);
      }
      return result;
    }
    await fsp.mkdir(path.join(cacheRoot, 'entries'), { recursive: true });
    report('validate');
    const files = session.files;
    result.validation = files.stats;
    async function refreshIdentity(source, expectedHash, previous) {
      const current = native.assets.sourceIdentity?.(source);
      if (current === undefined || current === previous) return current;
      const file = sourceFile(native, gameRoot, source);
      if (await files.hash(file) !== expectedHash || native.assets.sourceIdentity(source) !== current)
        throw new Error('source changed while validating '+source);
      return current;
    }
    const recipeMap = new Map(recipes.map(recipe => [recipe.source.toLowerCase(), recipe]));
    for (const source of sources) {
      if (cancelled()) break;
      report('validate', source);
      let stage, fallbackEntry;
      let logicalSource, encrypted, sourceIdentity, sourceHash, directory, indexed, recipe;
      let sourcePhase = 'validate', outcome = 'ordinary-choice';
      try {
        const decryptedPath = decryptedSource(source);
        encrypted = decryptedPath !== null;
        logicalSource = decryptedPath || source;
        const extension = path.extname(logicalSource).toLowerCase();
        const audioView = audioViewSupport && encrypted && hasPathPrefix(source, 'audio/');
        if (encrypted && (!settings.key || !(extension === '.png' ? settings.images : settings.audio) ||
            (!offline && !audioView && typeof native.assets.installDecrypted !== 'function'))) throw new Error('cached decryption is unavailable');
        if (encrypted && !audioView && fs.existsSync(path.join(gameRoot, logicalSource))) throw new Error('plaintext source path already exists');
        const file = sourceFile(native, gameRoot, source);
        if (audioView) {
          const size = (await fsp.stat(file)).size;
          result.audioViewEntries.push({ source, logicalSource, key: settings.key.toString('hex') });
          result.sourceBytes += size;
          result.completed += 1;
          report('audio-view', source);
          continue;
        }
        sourceIdentity = typeof native.assets.sourceIdentity === 'function' ? native.assets.sourceIdentity(source) : undefined;
        const checkedSource = await files.inspect(file, 'source');
        sourceHash = checkedSource.hash;
        if (sourceIdentity !== undefined && native.assets.sourceIdentity(source) !== sourceIdentity) throw new Error('source changed while hashing');
        result.sourceBytes += checkedSource.size;
        const policy = portableIndex?.policies?.[source] || {};
        if (typeof policy !== 'object' || Array.isArray(policy) ||
            policy.lossless !== undefined && typeof policy.lossless !== 'boolean') throw new Error('invalid image policy');
        if (policy.astc !== undefined) astcSettings(policy.astc);
        if (policy.recipe !== undefined && (!policy.recipe || typeof policy.recipe !== 'object' || Array.isArray(policy.recipe)))
          throw new Error('invalid explicit image recipe');
        const explicitRecipe = recipeMap.get(logicalSource.toLowerCase());
        recipe = policyOverrides.recipes && explicitRecipe ? explicitRecipe : policy.recipe || explicitRecipe;
        if (recipe) { recipe = { ...recipe, source: logicalSource, sourceHash }; validRecipes([recipe]); }
        if (!recipe && !encrypted) recipe = await automaticRecipe(file, logicalSource, sourceHash, checkedSource.header, frames);
        if (recipe && recipe.sourceHash !== sourceHash) throw new Error('recipe source hash changed');
        const imageAstc = astcSettings(policyOverrides.astc ? astc : policy.astc || astc);
        const lossless = policyOverrides.losslessPrefixes
          ? losslessPrefixes.some(prefix => hasPathPrefix(logicalSource, prefix))
          : policy.lossless ?? losslessPrefixes.some(prefix => hasPathPrefix(logicalSource, prefix));
        const allowAstc = imageAstc.enabled && !lossless;
        const key = identity({ version: CACHE_VERSION, processorIdentity, sourceHash, source, recipe: recipe || null, allowAstc,
          automaticRecipes: { version: automaticRecipes.version, frame: frames.get(logicalSource.toLowerCase()) },
          astcQuality: allowAstc ? imageAstc.quality : null,
          ...(encrypted ? { encryption: { version: 1, settingsHash: settings.hash }, characterLayout: 'mz-standard-v1' } : {}) });
        const findIndexed = () => !session.repairSources.has(source) && indexedImages.get(source)?.find(record => {
          const constrained = record.workspaceConstrained === true || record.descriptor?.workspaceConstrained === true;
          const cachedWorkspaceBytes = record.resolvedSettings?.workspaceBytes;
          const resolvedSettings = { allowAstc, astcQuality: allowAstc ? imageAstc.quality : null, pageCodec,
            ...(constrained ? { workspaceBytes: cachedWorkspaceBytes } : {}) };
          return record.sourceHash === sourceHash && identity(record.recipe) === identity(recipe || null) &&
          record.encryptionSettingsSha256 === (encrypted ? settings.hash : null) &&
          (!constrained || Number.isSafeInteger(cachedWorkspaceBytes) && cachedWorkspaceBytes >= workspaceBytes) &&
          (!record.resolvedSettings || identity(record.resolvedSettings) === identity(resolvedSettings)) &&
          (record.descriptor === null && Array.isArray(record.outputs) && !record.outputs.length ||
            record.descriptor && validDescriptor(record.descriptor));
        });
        indexed = encrypted ? null : findIndexed();
        {
          directory = session.directory('entries', key);
          let manifest = await cachedEntry(directory, key, sourceHash, files);
          if (manifest?.workspaceConstrained && workspaceBytes > (manifest.workspaceBytes || 0)) {
            fallbackEntry = { directory, manifest };
            session.touch(directory);
            directory = session.newDirectory('entries', key);
            manifest = null;
          }
          if (manifest && encrypted && manifest.decrypted !== 'source' + extension) manifest = null;
          if (manifest) {
            if (encrypted && extension === '.png' && !recipe)
              recipe = await automaticRecipe(path.join(directory, manifest.decrypted), logicalSource, sourceHash, undefined, frames);
            result.hits += 1;
            outcome = manifest.descriptor ? 'reused-local' : 'ordinary-choice';
            if (!manifest.descriptor && !manifest.decrypted) result.negativeHits += 1;
          } else {
            sourcePhase = 'prepare';
            if (fs.existsSync(directory)) directory = session.newDirectory('entries', key);
            report('prepare', source);
            if (cancelled()) break;
            stage = await fsp.mkdtemp(path.join(cacheRoot, 'entries', '.stage-'));
            const decrypted = encrypted ? 'source' + extension : undefined;
            let input = file;
            if (decrypted) {
              input = path.join(stage, decrypted);
              await decryptFile(file, input, settings.key, extension);
              if (!recipe) recipe = await automaticRecipe(input, logicalSource, sourceHash, undefined, frames);
              indexed = findIndexed();
            }
            if (cancelled()) break;
            let descriptor = null, copied = false, processorWorkspaceConstrained = false;
            const indexedFallback = indexed?.descriptor === null;
            if (indexedFallback) ++result.indexedNegative;
            if (indexed?.descriptor && (indexed.descriptor.compression === 'astc-4x4' || indexed.descriptor.pages.every(p => p.path.endsWith(pageCodec === 'lz4' ? '.pml4' : '.png'))) &&
                portableAssetRoot && Array.isArray(indexed.outputs) &&
                indexed.outputs.length === indexed.descriptor.pages.length) {
              const pages = indexed.descriptor.pages;
              try {
                for (let i = 0; i < pages.length; ++i) {
                  const item = indexed.outputs[i];
                  if (!item || typeof item.path !== 'string' || !/^assets\/images\/[a-f0-9]{64}\/page-\d+\.(png|pml4|astc)$/.test(item.path) ||
                      path.basename(item.path) !== pages[i].path || !HASH.test(item.hash)) throw new Error('invalid indexed page');
                  const candidate = path.join(portableAssetRoot, item.path);
                  const checked = await files.copyVerified(candidate, path.join(stage, pages[i].path), item.hash);
                  if (!pageHeaderMatches(checked.header, pages[i], checked.size))
                    throw new Error('indexed page header differs');
                }
                descriptor = indexed.descriptor;
                copied = true;
                if (pages.length) ++result.indexedPageCopies;
                else ++result.indexedZeroPage;
              } catch (_) {
                for (const page of pages) await fsp.rm(path.join(stage, page.path), { force: true });
              }
            }
            if (recipe && (recipeMap.has(logicalSource.toLowerCase()) || policy.recipe)) {
              const header = (await files.inspect(input, 'source')).header;
              if (header?.subarray(0, 8).equals(PNG)) {
                const width = header.readUInt32BE(16), height = header.readUInt32BE(20);
                const [columns, rows] = recipe.grid;
                if (width % columns || height % rows || recipe.crop &&
                    (recipe.crop[0] + recipe.crop[2] > width / columns || recipe.crop[1] + recipe.crop[3] > height / rows))
                  throw new Error('explicit image recipe is not applicable to the current dimensions');
              }
            }
            if (!copied && !indexedFallback && extension === '.png') {
              if (indexed) ++result.indexedLayoutAttempts;
              else ++result.unindexedProcessed;
              const processingStarted = performance.now();
              try {
                descriptor = await native.assets.processImage(source, stage, recipe || null,
                  input, ...(native.assets.preparationWorkspaceVersion === 1
                    ? [indexed ? indexed.descriptor : null, { workspaceBytes, allowAstc, astcQuality: imageAstc.quality, ...(pageCodec === 'lz4' ? { pageCodec } : {}) }]
                    : indexed ? [indexed.descriptor] : []));
                if (descriptor?.resultVersion === 1 && descriptor.workspaceConstrained === true && descriptor.descriptor === null) {
                  processorWorkspaceConstrained = true;
                  descriptor = null;
                }
              }
              finally { result.processingMs += performance.now() - processingStarted; }
            }
            if (cancelled()) break;
            if (descriptor?.compression && !allowAstc) throw new Error('lossless image policy forbids compressed output');
            if (descriptor !== null && !validDescriptor(descriptor)) throw new Error('processor returned invalid logical image descriptor');
            if (!descriptor?.compression && descriptor?.pages.some(p => !p.path.endsWith(pageCodec === 'lz4' ? '.pml4' : '.png')))
              throw new Error('processor returned a different page codec');
            // Ordinary boot assumes game assets remain unchanged while preparing.
            if (verifyHashes && await hashFile(file) !== sourceHash) throw new Error('source changed during image preparation');
            const outputs = {};
            if (decrypted) outputs[decrypted] = await files.hash(input);
            for (const page of descriptor ? descriptor.pages : []) outputs[page.path] = await files.hash(path.join(stage, page.path), 'output');
            manifest = { version: CACHE_VERSION, key, source, sourceHash, descriptor, descriptorHash: identity(descriptor), outputs,
              ...(decrypted ? { decrypted } : {}) };
            // Cache entries are disposable and hash-validated; locks, leases and indexes still flush.
            const workspaceConstrained = descriptor?.workspaceConstrained === true ||
              indexed?.workspaceConstrained === true || indexed?.descriptor?.workspaceConstrained === true || processorWorkspaceConstrained;
            const constrainedWorkspaceBytes = descriptor?.workspaceConstrained === true || processorWorkspaceConstrained ? workspaceBytes :
              indexed?.resolvedSettings?.workspaceBytes;
            files.writeManifest(stage, { ...manifest,
              workspaceConstrained,
              ...(workspaceConstrained ? { workspaceBytes: constrainedWorkspaceBytes ?? workspaceBytes } : {}),
              settings: { recipe, allowAstc, astcQuality: imageAstc.quality }, processor: processorIdentity,
              dependencies: [{ source, hash: sourceHash }, ...(encrypted ? [{ source: 'data/System.json', hash: settings.hash }] : [])],
              outcome: descriptor ? copied ? 'reused-package' : 'generated' : 'ordinary-choice' });
            if (!await cachedEntry(stage, key, sourceHash, files)) throw new Error('prepared output validation failed');
            await fsp.rename(stage, directory);
            files.publishManifest(stage, directory);
            stage = null;
            if (fallbackEntry) {
              session.discard(fallbackEntry.directory);
              fallbackEntry = null;
            }
            result.generated += 1;
            outcome = descriptor ? copied ? 'reused-package' : 'generated' : 'ordinary-choice';
          }
          sourceIdentity = await refreshIdentity(source, sourceHash, sourceIdentity);
          if (validStorageDecision(indexed?.storage))
            result.storageEntries.push({ source: logicalSource, sourceIdentity,
              backingHash: manifest.decrypted ? manifest.outputs[manifest.decrypted] : sourceHash, storage: indexed.storage });
          if (offline) result.decisions.push({ source, sourceHash, recipe: recipe || null,
            encryptionSettingsSha256: encrypted ? settings.hash : null,
            descriptor: manifest.descriptor, workspaceConstrained: manifest.workspaceConstrained === true,
            outputs: Object.fromEntries(Object.entries(manifest.outputs)
              .filter(([name]) => name !== manifest.decrypted)) });
          if (encrypted) settings.sourceIdentity = await refreshIdentity('data/System.json', settings.hash, settings.sourceIdentity);
          if (manifest.decrypted) {
            result.decryptedEntries.push({ source, logicalSource, file: path.join(directory, manifest.decrypted),
              sourceIdentity, sourceHash, settingsIdentity: settings.sourceIdentity,
              settingsHash: settings.hash, fileHash: manifest.outputs[manifest.decrypted] });
            result.cacheBytes += (await fsp.stat(path.join(directory, manifest.decrypted))).size;
          }
          let installDescriptor = manifest.descriptor;
          if (installDescriptor && indexed?.descriptor) {
            installDescriptor = { ...installDescriptor, pages: installDescriptor.pages.map(page => {
              const known = indexed.descriptor.pages.find(p => p.path === page.path && p.width === page.width && p.height === page.height);
              const output = indexed.outputs?.find(o => path.basename(o.path) === page.path);
              return known?.storage && output?.hash === manifest.outputs[page.path]
                ? { ...page, storage: known.storage } : page;
            }) };
          }
          if (installDescriptor) {
            for (const page of installDescriptor.pages) result.cacheBytes += (await fsp.stat(path.join(directory, page.path))).size;
            result.entries.push({ source: logicalSource, directory, descriptor: installDescriptor, sourceHash, sourceIdentity,
              backingHash: manifest.decrypted ? manifest.outputs[manifest.decrypted] : sourceHash,
              pageHashes: installDescriptor.pages.map(page => manifest.outputs[page.path]),
              ...(encrypted ? { decryptedFile: path.join(directory, manifest.decrypted) } : {}) });
          } else if (!manifest.decrypted) { result.fallback += 1; }
        }
        session.outcome('image:' + source, outcome);
      } catch (error) {
        if (fallbackEntry && logicalSource && sourceHash) {
          const { directory: oldDirectory, manifest } = fallbackEntry;
          try {
            sourceIdentity = await refreshIdentity(source, sourceHash, sourceIdentity);
            result.hits += 1;
            outcome = manifest.descriptor ? 'reused-local' : 'ordinary-choice';
            if (!manifest.descriptor && !manifest.decrypted) ++result.negativeHits;
            if (offline) result.decisions.push({ source, sourceHash, recipe: recipe || null,
              encryptionSettingsSha256: encrypted ? settings.hash : null,
              descriptor: manifest.descriptor, workspaceConstrained: true,
              outputs: Object.fromEntries(Object.entries(manifest.outputs).filter(([name]) => name !== manifest.decrypted)) });
            if (manifest.decrypted) {
              settings.sourceIdentity = await refreshIdentity('data/System.json', settings.hash, settings.sourceIdentity);
              result.decryptedEntries.push({ source, logicalSource, file: path.join(oldDirectory, manifest.decrypted),
                sourceIdentity, sourceHash, settingsIdentity: settings.sourceIdentity,
                settingsHash: settings.hash, fileHash: manifest.outputs[manifest.decrypted] });
              result.cacheBytes += (await fsp.stat(path.join(oldDirectory, manifest.decrypted))).size;
            }
            if (manifest.descriptor) {
              for (const page of manifest.descriptor.pages) result.cacheBytes += (await fsp.stat(path.join(oldDirectory, page.path))).size;
              result.entries.push({ source: logicalSource, directory: oldDirectory, descriptor: manifest.descriptor,
                sourceHash, sourceIdentity, backingHash: manifest.decrypted ? manifest.outputs[manifest.decrypted] : sourceHash,
                pageHashes: manifest.descriptor.pages.map(page => manifest.outputs[page.path]),
                ...(encrypted ? { decryptedFile: path.join(oldDirectory, manifest.decrypted) } : {}) });
            } else if (!manifest.decrypted) ++result.fallback;
            logger.warn(`[pmjs] workspace improvement failed for ${source}; reusing prior prepared output: ${error.message}`);
          } catch (fallbackError) {
            session.outcome('image:' + source, 'ordinary-failure', fallbackError.message);
            result.fallback += 1;
            result.failedFiles += 1;
            logger.warn(`[pmjs] asset preparation fallback ${source}: ${fallbackError.message}`);
          }
        } else {
          session.outcome('image:' + source, 'ordinary-failure', error.message);
          result.fallback += 1;
          result.failedFiles += 1;
          logger.warn(`[pmjs] asset preparation fallback ${source}: ${error.message}`);
        }
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
      if (offline) {
        result.prepared = result.installed = result.entries.length;
        result.decrypted = result.decryptedEntries.length;
        await files.save();
        return result;
      }
      activationStarted = true;
      if (native.assets.installDecrypted) {
        const derivedReport = await native.assets.installDecrypted(result.decryptedEntries, false, true);
        result.activation = derivedReport?.rejected ? derivedReport : undefined;
        result.decrypted = result.decryptedEntries.filter(entry => native.assets.hasDecrypted(entry.logicalSource)).length;
        result.installFailures += result.decryptedEntries.length - result.decrypted;
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
      if (audioViewSupport) {
        if ((await encryptionSettings(native, gameRoot, session.files)).hash !== audioSettings.hash)
          throw new Error('audio encryption settings changed during preparation');
        result.audioViews = native.media.installAudioViews(result.audioViewEntries);
        result.fallback += result.audioViewEntries.length - result.audioViews;
        result.installFailures += result.audioViewEntries.length - result.audioViews;
      }
      const decryptedSources = new Set(result.decryptedEntries.map(entry => entry.logicalSource));
      result.storageEntries = result.storageEntries.filter(entry => {
        if (!decryptedSources.has(entry.source)) return true;
        if (!native.assets.hasDecrypted(entry.source)) return false;
        entry.sourceIdentity = native.assets.sourceIdentity(entry.source);
        return true;
      });
      const storage = native.assets.installImageStorage ? await native.assets.installImageStorage(result.storageEntries, true) : null;
      const installed = await native.assets.installPrepared(result.entries, false, true);
      result.activation = { accepted: installed?.accepted || [], rejected: [...(result.activation?.rejected || []), ...(storage?.rejected || []), ...(installed?.rejected || [])] };
      result.prepared = result.entries.length;
      result.installed = installed?.accepted ? installed.accepted.length : Number.isInteger(installed) ? installed : result.entries.length;
      result.fallback += result.prepared - result.installed;
      result.installFailures += result.prepared - result.installed;
      if (result.installed < result.prepared) {
        logger.warn(`[pmjs] prepared image index installed ${result.installed}/${result.prepared}; remaining images use ordinary loading`);
      }
      report('cleanup');
      await files.save();

    }
  } catch (error) {
    terminalPhase = 'error';
    result.error = error.message;
    result.fallback += result.total - result.completed;
    logger.warn(`[pmjs] asset preparation unavailable: ${error.message}`);
  } finally {
    result.durationMs = performance.now() - started;
    cancelled();
    if (result.cancelled && activationStarted) {
      await clearIndexes();
      result.installed = result.decrypted = result.audioViews = 0;
    }
    report(result.cancelled ? 'cancelled' : terminalPhase, '', true);
  }
  return result;
}

async function prepareAssets(options) {
  const onProgress = options.onProgress || (() => {});
  const result = await require('./preparation.cjs').prepareGameAssets({
    ...options,
    maps: false,
    onProgress: value => {
      if (value.phase !== 'start') onProgress(value);
    }
  });
  if (result.images) result.images.releaseCacheLease = result.releaseCacheLease;
  return result.images;
}

module.exports = { astcSettings, validLosslessPrefixes, prepareAssetsPhase, prepareAssets, validRecipes,
  validDescriptor, validStorageDecision, automaticRecipe, PROCESSOR_IDENTITY };
