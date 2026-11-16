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
  catch (error) { if (error.code === 'ENOENT') return { entries, packs: [], damagedPacks: [] }; throw error; }
  if (stat.size > maximumIndexBytes) throw new Error('packed image index exceeds limit');
  const record = JSON.parse(await fsp.readFile(file, 'utf8'));
  const data = record.data;
  if (record.version !== 1 || record.checksum !== hash(JSON.stringify(data)) ||
      !Array.isArray(data?.files) || data.files.length > maximumEntries || !Array.isArray(data.packs))
    throw new Error('invalid packed image index');
  const packs = new Set(), mountedPacks = [], damagedPacks = [], filesystemTypes = new Map();
  for (const pack of data.packs) {
    if (!packName.test(pack.name) || packs.has(pack.name) || !/^\d+(?::\d+){5}$/.test(pack.identity || '') ||
        Number(pack.identity.split(':')[2]) > maximumPackBytes) throw new Error('invalid prepared pack metadata');
    packs.add(pack.name);
    try {
      const stat = await fsp.lstat(path.join(root, pack.name), { bigint: true });
      if (!stat.isFile() || !fileIdentityMatches(pack.identity, stat, path.join(root, pack.name), filesystemTypes))
        throw new Error('prepared pack changed');
      mountedPacks.push({ name: pack.name, identity: identity(stat) });
    } catch (error) { damagedPacks.push({ name: pack.name, reason: error.message }); }
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
  const damagedNames = new Set(damagedPacks.map(pack => pack.name));
  for (const [file, entry] of entries) if (damagedNames.has(path.basename(entry.pack))) entries.delete(file);
  return { entries, packs: mountedPacks, damagedPacks };
}

async function loadPackedCache(root, native, logger = console) {
  try {
    const { entries, packs, damagedPacks } = await readPackedIndex(root);
    if (!entries.size && damagedPacks.length) throw new Error(damagedPacks[0].reason);
    if (entries.size && typeof native.assets.installPackedFiles !== 'function') throw new Error('packed image reader unavailable');
    let remaining = packs;
    for (;;) {
      let installError;
      try { native.assets.installPackedFiles?.([...entries.values()]); }
      catch (error) { installError = error; }
      const changed = [];
      for (const pack of remaining) {
        const stat = await fsp.lstat(path.join(root, pack.name), { bigint: true }).catch(() => null);
        if (!stat || identity(stat) !== pack.identity)
          changed.push({ name: pack.name, reason: 'prepared pack changed during mounting' });
      }
      if (!changed.length) {
        if (installError) throw installError;
        break;
      }
      const names = new Set(changed.map(pack => pack.name));
      for (const [file, entry] of entries) if (names.has(path.basename(entry.pack))) entries.delete(file);
      damagedPacks.push(...changed);
      remaining = remaining.filter(pack => !names.has(pack.name));
      if (!entries.size) throw new Error(changed[0].reason);
    }
    entries.packIdentities = remaining;
    entries.damagedPacks = damagedPacks;
    for (const pack of damagedPacks) logger.warn('[pmjs] packed images unavailable in ' + pack.name + ': ' + pack.reason);
    if (entries.size) logger.info?.(`[pmjs] packed images files=${entries.size} packs=${new Set([...entries.values()].map(item => item.pack)).size}`);
    return entries;
  } catch (error) {
    logger.warn('[pmjs] packed images unavailable: ' + error.message);
    native.assets.installPackedFiles?.([]);
    return null;
  }
}

async function repairPackedCache(root, entries) {
  if (!entries?.damagedPacks?.length) return;
  const data = { packs: entries.packIdentities, files: [...entries.values()].map(item => ({
    name: item.name, pack: path.basename(item.pack), offset: item.offset, size: item.size, hash: item.hash, header: item.header
  })) };
  await publishPackedIndex(root, data);
  entries.damagedPacks = [];
}

async function syncDirectory(directory) {
  const handle = await fsp.open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function publishPackedIndex(root, data, onPublished) {
  const serialized = JSON.stringify({ version: 1, checksum: hash(JSON.stringify(data)), data });
  if (Buffer.byteLength(serialized) > maximumIndexBytes) throw new Error('packed image index exceeds limit');
  const temporary = path.join(root, filename + '.stage-' + crypto.randomBytes(8).toString('hex'));
  try {
    const handle = await fsp.open(temporary, 'wx');
    try { await handle.writeFile(serialized); await handle.sync(); }
    finally { await handle.close(); }
    await syncDirectory(root);
    await fsp.rename(temporary, path.join(root, filename));
    onPublished?.();
    await syncDirectory(root);
  } finally { await fsp.rm(temporary, { force: true }); }
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

async function packCache(root, assets, { maximumBytes = maximumPackBytes, verifyHashes = false, compact = false } = {}) {
  root = await fsp.realpath(root);
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 32 || maximumBytes > maximumPackBytes)
    throw new Error('invalid prepared pack size');
  const token = assets.tryAcquirePreparationLock(root);
  if (!token) throw new Error('preparation cache is busy');
  const uncommitted = new Set();
  async function prunePacks(retained, syncBefore = false) {
    const stale = (await fsp.readdir(root)).filter(name =>
      (packName.test(name) && !retained.has(name)) || /^packed-images\.json\.stage-[a-f0-9]{16}$/.test(name));
    if (!stale.length) return;
    if (syncBefore) await syncDirectory(root);
    for (const name of stale) await fsp.unlink(path.join(root, name));
    await syncDirectory(root);
  }
  async function removeLooseFiles(files) {
    const directories = new Set(files.map(file => path.dirname(file)));
    for (const file of files) await fsp.unlink(file);
    for (const directory of directories) {
      await syncDirectory(directory);
      await fsp.rmdir(directory).catch(error => { if (!['ENOTEMPTY', 'ENOENT'].includes(error.code)) throw error; });
    }
    for (const directory of new Set([...directories].map(directory => path.dirname(directory)))) await syncDirectory(directory);
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
    const loose = [], packed = new Map(), duplicates = [];
    for (const [name, expected] of [...pending].sort(([a], [b]) => a.localeCompare(b))) {
      const file = path.join(root, name);
      const stat = await fsp.lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      let old = previous.entries.get(file);
      if (!stat && !old) throw new Error('prepared image is missing: ' + name);
      const size = stat ? stat.size : old.size;
      if ((stat && !stat.isFile()) || !size || size > maximumBytes) throw new Error('prepared image exceeds pack limit');
      if (stat && old?.hash === expected && old.size === size && !compact) {
        await inspectPacked(old, true);
        await inspectPacked({ ...old, pack: file, offset: 0 }, true);
        duplicates.push(file);
      } else if (stat) old = null;
      const item = { name, expected, file, size, old };
      if (!old) loose.push(item);
      else {
        if (!packed.has(old.pack)) packed.set(old.pack, []);
        packed.get(old.pack).push(item);
      }
    }
    const indexedCounts = new Map();
    for (const item of previous.entries.values()) indexedCounts.set(item.pack, (indexedCounts.get(item.pack) || 0) + 1);
    for (const [packPath, items] of packed) {
      if (compact) continue;
      const size = Number(packs.get(path.basename(packPath)).identity.split(':')[2]);
      let end = 0;
      const contiguous = items.slice().sort((a, b) => a.old.offset - b.old.offset).every(item => {
        const matches = item.old.offset === end;
        end += item.size;
        return matches;
      });
      if (size > maximumBytes || indexedCounts.get(packPath) !== items.length || !contiguous || end !== size ||
          items.some(item => item.old.hash !== item.expected)) continue;
      if (verifyHashes) for (const item of items) await inspectPacked(item.old, true);
      packed.delete(packPath);
    }
    const units = [...loose.map(item => [item]), ...packed.values()];
    for (const unit of units)
      if (unit.reduce((sum, item) => sum + item.size, 0) > maximumPackBytes)
        throw new Error('prepared pack ranges exceed pack limit');
    const work = units.flat();
    const positions = new Map(work.map((item, index) => [item.name, index]));
    const batches = [];
    let batch = [], batchBytes = 0;
    for (const unit of compact ? work.map(item => [item]) : units) {
      const size = unit.reduce((sum, item) => sum + item.size, 0);
      if (batchBytes + size > maximumBytes && batch.length) { batches.push(batch); batch = []; batchBytes = 0; }
      batch.push(...unit); batchBytes += size;
      if (batchBytes >= maximumBytes) { batches.push(batch); batch = []; batchBytes = 0; }
    }
    const retainedBefore = new Set([...current.values()].map(item => item.pack));
    const metadataChanged = previous.invalid || previous.damagedPacks?.length ||
      previous.entries.size !== current.size || previous.packs.length !== retainedBefore.size;
    if (batch.length || (!batches.length && metadataChanged)) batches.push(batch);
    if (!previous.invalid) await prunePacks(new Set([...previous.packs, ...(previous.damagedPacks || [])].map(pack => pack.name)), true);
    const prefix = crypto.randomBytes(8).toString('hex'), buffer = Buffer.alloc(256 * 1024);
    let sequence = 0;
    async function convertBatch(batch) {
      const sourcePacks = new Set();
      const replacements = [], originals = [], newPacks = [];
      let pack, used = 0;
      const finishPack = async () => {
        if (!output) return;
        await output.sync(); await output.close(); output = null;
        const stat = await fsp.lstat(path.join(root, pack), { bigint: true });
        newPacks.push({ name: pack, identity: identity(stat) });
      };
      for (const item of batch) {
        const packedSource = item.old ? current.get(item.name) : null;
        const inputPath = packedSource ? path.join(root, packedSource.pack) : item.file;
        if (packedSource) sourcePacks.add(packedSource.pack);
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
            const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, item.size - offset), (packedSource?.offset || 0) + offset);
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
      await publishPackedIndex(root, data, () => uncommitted.clear());
      await fsp.rm(path.join(root, 'startup-catalog.json'), { force: true });
      await removeLooseFiles(originals);
      await prunePacks(retained);
      return sourcePacks;
    }
    for (const batch of batches) {
      const sources = await convertBatch(batch);
      if (compact) for (const source of sources) {
        const carry = [...current.values()].filter(item => item.pack === source)
          .map(item => work[positions.get(item.name)]).sort((a, b) => positions.get(a.name) - positions.get(b.name));
        if (carry.length) await convertBatch(carry);
      }
    }
    if (duplicates.length) { await syncDirectory(root); await removeLooseFiles(duplicates); }
    return { files: current.size, packs: packs.size, bytes: [...current.values()].reduce((sum, item) => sum + item.size, 0) };
  } finally {
    try { await output?.close(); }
    finally {
      try { for (const file of uncommitted) await fsp.rm(file, { force: true }); }
      finally { assets.releasePreparationLock(token); }
    }
  }
}

module.exports = { loadPackedCache, inspectPacked, packCache, repairPackedCache };
