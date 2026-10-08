'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { performance } = require('node:perf_hooks');
const HASH = /^[a-f0-9]{64}$/;

async function readJson(file) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch (_) { return null; }
}
async function writeJson(file, data) {
  const handle = await fsp.open(file, 'wx');
  try {
    await handle.writeFile(JSON.stringify(data) + '\n');
    await handle.sync();
  } finally { await handle.close(); }
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
  await writeJson(file, { pid: process.pid, hostname: os.hostname(), start: processStart(process.pid), keys });
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
          throw new Error('preparation cache is locked by another host');
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

module.exports = { acquireLock, createLease, retainLeases };
