'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { fileIdentity, fileIdentityMatches } = require('./preparation-files.cjs');
const maximumPackBytes = 64 * 1024 * 1024;
const filename = 'packed-images.json';
const maximumIndexBytes = 16 * 1024 * 1024;
const maximumEntries = 100000;
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const identity = fileIdentity;
const imageName = /^entries\/[a-f0-9]{64}(?:-[a-f0-9]{12})?\/(?:page-\d+\.pml4|texture\.pmtx)$/;
const packName = /^pack-[a-f0-9]{16}-\d+\.pmpk$/;

async function readPackedIndex(root) {
  const entries = new Map(), file = path.join(root, filename);
  let stat;
  try { stat = await fsp.stat(file); }
  catch (error) { if (error.code === 'ENOENT') return { entries, packs: [] }; throw error; }
  if (stat.size > maximumIndexBytes) throw new Error('packed image index exceeds limit');
  const record = JSON.parse(await fsp.readFile(file, 'utf8'));
  const data = record.data;
  if (record.version !== 1 || record.checksum !== hash(JSON.stringify(data)) ||
      !Array.isArray(data?.files) || data.files.length > maximumEntries || !Array.isArray(data.packs))
    throw new Error('invalid packed image index');
  const packs = new Set(), mountedPacks = [], filesystemTypes = new Map();
  for (const pack of data.packs) {
    if (!packName.test(pack.name) || packs.has(pack.name)) throw new Error('invalid prepared pack name');
    const stat = await fsp.lstat(path.join(root, pack.name), { bigint: true });
    if (!stat.isFile() || stat.size > BigInt(maximumPackBytes) || !fileIdentityMatches(pack.identity, stat, path.join(root, pack.name), filesystemTypes))
      throw new Error('prepared pack changed');
    packs.add(pack.name);
    mountedPacks.push({ name: pack.name, identity: identity(stat) });
  }
  const sizes = new Map(data.packs.map(pack => [pack.name, Number(pack.identity.split(':')[2])]));
  for (const item of data.files) {
    if (!imageName.test(item.name) || !packs.has(item.pack) ||
        !Number.isSafeInteger(item.offset) || !Number.isSafeInteger(item.size) ||
        item.offset < 0 || item.size <= 0 || item.offset > sizes.get(item.pack) - item.size ||
        !/^[a-f0-9]{64}$/.test(item.hash) || typeof item.header !== 'string' ||
        Buffer.from(item.header, 'base64').length !== Math.min(32, item.size))
      throw new Error('invalid packed image range');
    const file = path.join(root, item.name);
    if (entries.has(file)) throw new Error('duplicate packed image path');
    entries.set(file, { ...item, path: file, pack: path.join(root, item.pack) });
  }
  return { entries, packs: mountedPacks };
}

async function loadPackedCache(root, native, logger = console) {
  try {
    const { entries, packs } = await readPackedIndex(root);
    if (entries.size && typeof native.assets.installPackedFiles !== 'function') throw new Error('packed image reader unavailable');
    native.assets.installPackedFiles?.([...entries.values()]);
    for (const pack of packs)
      if (identity(await fsp.lstat(path.join(root, pack.name), { bigint: true })) !== pack.identity)
        throw new Error('prepared pack changed during mounting');
    if (entries.size) logger.info?.(`[pmjs] packed images files=${entries.size} packs=${new Set([...entries.values()].map(item => item.pack)).size}`);
    return entries;
  } catch (error) {
    logger.warn('[pmjs] packed images unavailable: ' + error.message);
    native.assets.installPackedFiles?.([]);
    return null;
  }
}

async function inspectPacked(item, verify) {
  if (verify) {
    const handle = await fsp.open(item.pack, 'r');
    try {
      const before = identity(await handle.stat({ bigint: true }));
      const digest = crypto.createHash('sha256'), buffer = Buffer.alloc(256 * 1024);
      for (let offset = 0; offset < item.size;) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, item.size - offset), item.offset + offset);
        if (!bytesRead) throw new Error('truncated prepared pack');
        digest.update(buffer.subarray(0, bytesRead)); offset += bytesRead;
      }
      if (digest.digest('hex') !== item.hash || before !== identity(await handle.stat({ bigint: true })))
        throw new Error('packed image checksum differs');
    } finally { await handle.close(); }
  }
  return { hash: item.hash, size: item.size, header: Buffer.from(item.header, 'base64'), reused: !verify };
}

async function packCache(root, assets, { maximumBytes = maximumPackBytes } = {}) {
  root = await fsp.realpath(root);
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 32 || maximumBytes > maximumPackBytes)
    throw new Error('invalid prepared pack size');
  const token = assets.tryAcquirePreparationLock(root);
  if (!token) throw new Error('preparation cache is busy');
  const uncommitted = new Set();
  const syncDirectory = async directory => {
    const handle = await fsp.open(directory, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
  };
  async function prunePacks(retained, syncBefore = false) {
    const stale = (await fsp.readdir(root)).filter(name =>
      (packName.test(name) && !retained.has(name)) || /^packed-images\.json\.stage-[a-f0-9]{16}$/.test(name));
    if (!stale.length) return;
    if (syncBefore) await syncDirectory(root);
    for (const name of stale) await fsp.unlink(path.join(root, name));
    await syncDirectory(root);
  }
  let output;
  try {
    const { retainLeases } = require('./preparation-lifetime.cjs');
    await retainLeases(root, new Set());
    if ((await fsp.readdir(root)).some(name => /^\.lease-\d+-[a-f0-9]+\.json$/.test(name)))
      throw new Error('preparation cache has live readers');
    assets.installPackedFiles?.([]);
    const previous = await readPackedIndex(root).catch(() => ({ entries: new Map(), packs: [], invalid: true }));
    const statePath = path.join(root, 'preparation-state.json');
    if ((await fsp.stat(statePath)).size > 48 * 1024 * 1024) throw new Error('preparation state exceeds limit');
    const state = JSON.parse(await fsp.readFile(statePath, 'utf8'));
    if (state.version !== 1 || state.checksum !== hash(JSON.stringify(state.data))) throw new Error('invalid preparation state');
    const pending = new Map();
    for (const [directory, record] of Object.entries(state.data.results))
      for (const [name, expected] of Object.entries(record.outputs || {})) {
        const relative = directory + '/' + name;
        if (imageName.test(relative)) pending.set(relative, expected);
      }
    if (pending.size > maximumEntries) throw new Error('too many packed images');
    const current = new Map([...previous.entries.values()].filter(item => pending.has(item.name))
      .map(item => [item.name, { name: item.name, pack: path.basename(item.pack), offset: item.offset, size: item.size, hash: item.hash, header: item.header }]));
    let packs = new Map(previous.packs.map(pack => [pack.name, pack]));
    const loose = [], packed = new Map();
    for (const [name, expected] of [...pending].sort(([a], [b]) => a.localeCompare(b))) {
      const file = path.join(root, name);
      const stat = await fsp.lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      const old = stat ? null : previous.entries.get(file);
      if (!stat && !old) throw new Error('prepared image is missing: ' + name);
      const size = stat ? stat.size : old.size;
      if ((stat && !stat.isFile()) || !size || size > maximumBytes) throw new Error('prepared image exceeds pack limit');
      const item = { name, expected, file, size, old };
      if (stat) loose.push(item);
      else {
        if (!packed.has(old.pack)) packed.set(old.pack, []);
        packed.get(old.pack).push(item);
      }
    }
    const batches = [];
    let batch = [], batchBytes = 0;
    for (const unit of [...loose.map(item => [item]), ...packed.values()]) {
      const size = unit.reduce((sum, item) => sum + item.size, 0);
      if (size > maximumPackBytes) throw new Error('prepared pack ranges exceed pack limit');
      if (batchBytes + size > maximumBytes && batch.length) { batches.push(batch); batch = []; batchBytes = 0; }
      batch.push(...unit); batchBytes += size;
      if (batchBytes >= maximumBytes) { batches.push(batch); batch = []; batchBytes = 0; }
    }
    if (batch.length || !batches.length) batches.push(batch);
    if (!previous.invalid) await prunePacks(new Set(previous.packs.map(pack => pack.name)), true);
    const prefix = crypto.randomBytes(8).toString('hex'), buffer = Buffer.alloc(256 * 1024);
    let sequence = 0;
    for (const batch of batches) {
      const replacements = [], originals = [], newPacks = [];
      let pack, used = 0;
      const finishPack = async () => {
        if (!output) return;
        await output.sync(); await output.close(); output = null;
        const stat = await fsp.lstat(path.join(root, pack), { bigint: true });
        newPacks.push({ name: pack, identity: identity(stat) });
      };
      for (const item of batch) {
        const inputPath = item.old ? item.old.pack : item.file;
        const input = await fsp.open(inputPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        try {
          const stat = await input.stat({ bigint: true });
          if (!stat.isFile() || (!item.old && Number(stat.size) !== item.size)) throw new Error('prepared image changed during packing');
          if (!output || used + item.size > maximumBytes) {
            await finishPack(); pack = `pack-${prefix}-${sequence++}.pmpk`; used = 0;
            const target = path.join(root, pack); output = await fsp.open(target, 'wx'); uncommitted.add(target);
          }
          const digest = crypto.createHash('sha256');
          let offset = 0, header = Buffer.alloc(0);
          while (offset < item.size) {
            const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, item.size - offset), (item.old?.offset || 0) + offset);
            if (!bytesRead) throw new Error('truncated prepared image');
            const chunk = buffer.subarray(0, bytesRead);
            if (header.length < 32) header = Buffer.concat([header, chunk.subarray(0, 32 - header.length)]);
            digest.update(chunk); await output.writeFile(chunk); offset += bytesRead;
          }
          if (digest.digest('hex') !== item.expected || identity(stat) !== identity(await input.stat({ bigint: true })) ||
              identity(stat) !== identity(await fsp.lstat(inputPath, { bigint: true })))
            throw new Error('prepared image changed during packing');
          replacements.push({ name: item.name, pack, offset: used, size: item.size, hash: item.expected, header: header.toString('base64') });
          used += item.size;
          if (!item.old) originals.push(item.file);
        } finally { await input.close(); }
      }
      await finishPack();
      for (const item of replacements) current.set(item.name, item);
      for (const pack of newPacks) packs.set(pack.name, pack);
      const retained = new Set([...current.values()].map(item => item.pack));
      packs = new Map([...packs].filter(([name]) => retained.has(name)));
      const data = { packs: [...packs.values()], files: [...current.values()] };
      const serialized = JSON.stringify({ version: 1, checksum: hash(JSON.stringify(data)), data });
      if (Buffer.byteLength(serialized) > maximumIndexBytes) throw new Error('packed image index exceeds limit');
      const temporary = path.join(root, filename + '.stage-' + prefix); uncommitted.add(temporary);
      const handle = await fsp.open(temporary, 'wx');
      try { await handle.writeFile(serialized); await handle.sync(); }
      finally { await handle.close(); }
      await syncDirectory(root);
      await fsp.rename(temporary, path.join(root, filename));
      uncommitted.clear();
      await syncDirectory(root);
      await fsp.rm(path.join(root, 'startup-catalog.json'), { force: true });
      const directories = new Set(originals.map(file => path.dirname(file)));
      for (const file of originals) await fsp.unlink(file);
      for (const directory of directories) {
        await syncDirectory(directory);
        await fsp.rmdir(directory).catch(error => { if (!['ENOTEMPTY', 'ENOENT'].includes(error.code)) throw error; });
      }
      for (const directory of new Set([...directories].map(directory => path.dirname(directory)))) await syncDirectory(directory);
      await prunePacks(retained);
    }
    return { files: current.size, packs: packs.size, bytes: [...current.values()].reduce((sum, item) => sum + item.size, 0) };
  } finally {
    try { await output?.close(); }
    finally {
      try { for (const file of uncommitted) await fsp.rm(file, { force: true }); }
      finally { assets.releasePreparationLock(token); }
    }
  }
}

module.exports = { loadPackedCache, inspectPacked, packCache };
