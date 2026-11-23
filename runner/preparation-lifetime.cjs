'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { performance } = require('node:perf_hooks');
const { writeJson } = require('./preparation-files.cjs');
const HASH = /^[a-f0-9]{64}(?:-[a-f0-9]{12})?$/;

async function readJson(file) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch (_) { return null; }
}
const activeLeases = new Map();
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
async function createLease(cacheRoot, keys) {
  const file = path.join(cacheRoot, `.lease-${process.pid}-${crypto.randomBytes(8).toString('hex')}.json`);
  // The preparation lock serializes every lease reader and writer, so page-cache
  // visibility is sufficient: leases only protect live processes, making them
  // meaningless after a crash that durability would survive. Skipping fsync here
  // removes one slow sync per launch without weakening cleanup safety.
  await writeJson(file, { pid: process.pid, hostname: os.hostname(), start: processStart(process.pid), keys }, false);
  function release() {
    activeLeases.delete(file);
    try { fs.unlinkSync(file); } catch (_) {}
  }
  activeLeases.set(file, release);
  if (!exitCleanupInstalled) {
    process.once('exit', () => { for (const release of [...activeLeases.values()]) release(); });
    exitCleanupInstalled = true;
  }
  return release;
}
const installedLeases = new WeakMap();
async function adoptInstalledLease(assets, root, keys) {
  let owner = installedLeases.get(assets);
  if (!owner) {
    owner = new Map();
    installedLeases.set(assets, owner);
  }
  const previous = owner.get(root);
  const retained = new Set(previous?.keys);
  for (const key of keys) retained.add(key);
  if (!previous || retained.size !== previous.keys.size) {
    const release = await createLease(root, [...retained]);
    owner.set(root, { keys: retained, release });
    previous?.release();
  }
  // Installed catalogs may leave lazy readers in live image slots. Only the
  // asset-store owner, after stopping those readers, can release their files.
  return function releaseInstalledLeases() {
    for (const lease of owner.values()) lease.release();
    owner.clear();
    if (installedLeases.get(assets) === owner) installedLeases.delete(assets);
  };
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
async function acquireLock(cacheRoot, cancelled, onWait, assets, waitMilliseconds = 15000) {
  if (typeof assets?.tryAcquirePreparationLock !== 'function' ||
      typeof assets?.releasePreparationLock !== 'function')
    throw new Error('kernel preparation locking is unavailable');
  const started = performance.now();
  for (;;) {
    if (cancelled()) return null;
    const token = assets.tryAcquirePreparationLock(cacheRoot);
    if (token) return () => assets.releasePreparationLock(token);
    if (performance.now() - started >= waitMilliseconds)
      throw new Error('preparation cache lock wait timed out');
    onWait();
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

module.exports = { acquireLock, createLease, adoptInstalledLease, retainLeases };
