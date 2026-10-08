'use strict';

const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const checksum = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const HASH = /^[a-f0-9]{64}$/;
function relative(root, file) {
  const value = path.relative(path.resolve(root), path.resolve(file));
  if (!value || value.includes('\\') || value.includes('\0') || value.split('/').some(p => !p || p === '.' || p === '..'))
    throw new Error('unsafe catalog cache path');
  if (!/^(entries\/[a-f0-9]{64}(\/[\w.-]+)?|maps\/entries\/[a-f0-9]{64}(\/[\w.-]+)?|maps\/sources\/[a-f0-9]{64}\.png)$/.test(value))
    throw new Error('unsupported catalog cache path');
  return value;
}
function paths(payload, root, encode) {
  function cachePath(value) {
    if (typeof value !== 'string' || (!encode && path.isAbsolute(value))) throw new Error('invalid catalog path');
    const safe = relative(root, encode ? value : path.resolve(root, value));
    return encode ? safe : path.join(root, safe);
  }
  if (!Array.isArray(payload.entries)) throw new Error('invalid catalog entries');
  const entries = payload.entries.map(entry => ({ ...entry, directory: cachePath(entry.directory),
    descriptor: entry.descriptor.sources ? { ...entry.descriptor,
      sources: entry.descriptor.sources.map(source => ({ ...source, snapshot: cachePath(source.snapshot) })) } : entry.descriptor }));
  const decryptedEntries = payload.decryptedEntries?.map(entry => ({ ...entry, file: cachePath(entry.file) }));
  return { ...payload, entries, ...(decryptedEntries ? { decryptedEntries } : {}) };
}
async function readCatalog(file, binding, root) {
  try {
    const catalog = JSON.parse(await fs.readFile(file, 'utf8'));
    if (catalog.version !== 2 || catalog.binding !== checksum(binding) || catalog.checksum !== checksum(catalog.payload) ||
        !Array.isArray(catalog.payload.keys) || !catalog.payload.keys.every(key => HASH.test(key))) return null;
    const payload = catalog.payload;
    if (!Array.isArray(payload.entries) || payload.entries.length > 100000 || !payload.summary ||
        payload.summary.installed !== payload.entries.length ||
        !Object.values(payload.summary).every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0)) return null;
    if (payload.decryptedEntries !== undefined) {
      if (!Array.isArray(payload.decryptedEntries) || payload.decryptedEntries.length > 100000) return null;
    } else if (!Array.isArray(payload.maps) || !payload.index || typeof payload.index !== 'object' || Array.isArray(payload.index)) return null;
    return paths(payload, root, false);
  } catch (_) { return null; }
}
async function publishCatalog(file, binding, root, payload) {
  payload = paths(payload, root, true);
  const stage = file+'.stage-'+process.pid;
  await fs.rm(stage, { force: true });
  try {
    const handle = await fs.open(stage, 'wx');
    try {
      await handle.writeFile(JSON.stringify({ version: 2, binding: checksum(binding), checksum: checksum(payload), payload }));
      await handle.sync();
    } finally { await handle.close(); }
    await fs.rename(stage, file);
  } finally { await fs.rm(stage, { force: true }); }
}
function catalogInvalidator(file, logger) {
  let invalidated = false;
  return function() {
    if (invalidated) return true;
    try {
      syncFs.rmSync(file, { force: true });
      invalidated = true;
      return true;
    } catch (error) {
      logger.warn('[pmjs] cannot invalidate preparation catalog: '+error.message);
      return false;
    }
  };
}
module.exports = { checksum, readCatalog, publishCatalog, catalogInvalidator };
