'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const maximumPackBytes = 64 * 1024 * 1024;
const filename = 'packed-images.json';
const maximumIndexBytes = 16 * 1024 * 1024;
const maximumEntries = 100000;
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const identity = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.birthtimeNs].join(':');
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
  const packs = new Set();
  for (const pack of data.packs) {
    if (!packName.test(pack.name) || packs.has(pack.name)) throw new Error('invalid prepared pack name');
    const stat = await fsp.lstat(path.join(root, pack.name), { bigint: true });
    if (!stat.isFile() || stat.size > BigInt(maximumPackBytes) || identity(stat) !== pack.identity)
      throw new Error('prepared pack changed');
    packs.add(pack.name);
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
  return { entries, packs: data.packs };
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
  const created = [], originals = [], directories = new Set();
  const syncDirectory = async () => {
    const handle = await fsp.open(root, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
  };
  let output, committed = false;
  try {
    const { retainLeases } = require('./preparation-lifetime.cjs');
    await retainLeases(root, new Set());
    if ((await fsp.readdir(root)).some(name => /^\.lease-\d+-[a-f0-9]+\.json$/.test(name)))
      throw new Error('preparation cache has live readers');
    // Only verified state outputs are copied; an invalid old index can be replaced
    // after ordinary preparation has regenerated the missing loose outputs.
    const previous = await readPackedIndex(root).then(index => index.entries).catch(() => null);
    const state = JSON.parse(await fsp.readFile(path.join(root, 'preparation-state.json'), 'utf8'));
    if (state.version !== 1 || state.checksum !== hash(JSON.stringify(state.data))) throw new Error('invalid preparation state');
    const pending = new Map();
    for (const [directory, record] of Object.entries(state.data.results))
      for (const [name, expected] of Object.entries(record.outputs || {})) {
        const relative = directory + '/' + name;
        if (imageName.test(relative)) pending.set(relative, expected);
      }
    if (pending.size > maximumEntries) throw new Error('too many packed images');
    const data = { packs: [], files: [] }, prefix = crypto.randomBytes(8).toString('hex');
    let pack, used = 0, bytes = 0;
    const finishPack = async () => {
      if (!output) return;
      await output.sync(); await output.close(); output = null;
      const stat = await fsp.lstat(path.join(root, pack), { bigint: true });
      data.packs.push({ name: pack, identity: identity(stat) });
    };
    const buffer = Buffer.alloc(256 * 1024);
    for (const [name, expected] of [...pending].sort(([a], [b]) => a.localeCompare(b))) {
      const file = path.join(root, name);
      let packed, input;
      try { input = await fsp.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); }
      catch (error) {
        if (error.code !== 'ENOENT' || !previous?.has(file)) throw error;
        packed = previous.get(file);
        input = await fsp.open(packed.pack, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      }
      try {
        const stat = await input.stat({ bigint: true }), size = packed?.size ?? Number(stat.size);
        if (!stat.isFile() || !size || size > maximumBytes) throw new Error('prepared image exceeds pack limit');
        if (!output || used + size > maximumBytes) {
          await finishPack(); pack = `pack-${prefix}-${data.packs.length}.pmpk`; used = 0;
          const target = path.join(root, pack); output = await fsp.open(target, 'wx'); created.push(target);
        }
        const digest = crypto.createHash('sha256');
        let offset = 0, header = Buffer.alloc(0);
        while (offset < size) {
          const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, size - offset), (packed?.offset || 0) + offset);
          if (!bytesRead) throw new Error('truncated prepared image');
          const chunk = buffer.subarray(0, bytesRead);
          if (header.length < 32) header = Buffer.concat([header, chunk.subarray(0, 32 - header.length)]);
          digest.update(chunk); await output.writeFile(chunk); offset += bytesRead;
        }
        if (digest.digest('hex') !== expected || identity(stat) !== identity(await input.stat({ bigint: true })))
          throw new Error('prepared image changed during packing');
        data.files.push({ name, pack, offset: used, size, hash: expected, header: header.toString('base64') });
        used += size; bytes += size;
        if (!packed) { originals.push(file); directories.add(path.dirname(file)); }
      } finally { await input.close(); }
    }
    await finishPack();
    const temporary = path.join(root, filename + '.stage-' + prefix); created.push(temporary);
    const serialized = JSON.stringify({ version: 1, checksum: hash(JSON.stringify(data)), data });
    if (Buffer.byteLength(serialized) > maximumIndexBytes) throw new Error('packed image index exceeds limit');
    const handle = await fsp.open(temporary, 'wx');
    try { await handle.writeFile(serialized); await handle.sync(); }
    finally { await handle.close(); }
    // Persist the pack names before publishing their index, then persist the
    // index before removing either representation it replaces.
    await syncDirectory();
    await fsp.rename(temporary, path.join(root, filename)); committed = true;
    await syncDirectory();
    await fsp.rm(path.join(root, 'startup-catalog.json'), { force: true });
    for (const file of originals) await fsp.unlink(file);
    for (const directory of directories) await fsp.rmdir(directory).catch(error => { if (!['ENOTEMPTY', 'ENOENT'].includes(error.code)) throw error; });
    const retained = new Set(data.packs.map(item => item.name));
    for (const name of await fsp.readdir(root))
      if ((packName.test(name) && !retained.has(name)) || /^packed-images\.json\.stage-[a-f0-9]{16}$/.test(name))
        await fsp.unlink(path.join(root, name));
    await syncDirectory();
    return { files: data.files.length, packs: data.packs.length, bytes };
  } finally {
    try {
      await output?.close();
      if (!committed) for (const file of created) await fsp.rm(file, { force: true });
    } finally { assets.releasePreparationLock(token); }
  }
}

module.exports = { loadPackedCache, inspectPacked, packCache };
