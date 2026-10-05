'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');

const HASH = /^[a-f0-9]{64}$/;
const digest = value => crypto.createHash('sha256').update(value).digest('hex');

async function preparationFiles(directory, verifyHashes = false) {
  const index = path.join(directory, 'verified-files.json');
  let previous = {}, previousHash;
  try {
    const saved = JSON.parse(await fsp.readFile(index, 'utf8'));
    if (saved.version === 1 && saved.files && saved.hash === digest(JSON.stringify(saved.files))) {
      previous = saved.files; previousHash = saved.hash;
    }
  } catch (_) { /* Missing or interrupted receipts require full verification. */ }
  const files = {}, known = new Map(), jsonValues = new Map();
  const stats = { hashedFiles: 0, hashedBytes: 0, reusedFiles: 0, jsonReads: 0, jsonReuses: 0 };
  function identity(stat) {
    return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.birthtimeNs].join(':');
  }
  async function inspect(file) {
    file = path.resolve(file);
    const before = await fsp.lstat(file, { bigint: true });
    if (!before.isFile()) throw new Error('preparation input is not a regular file');
    const signature = identity(before);
    const cached = previous[file];
    let checksum = !verifyHashes && (known.get(signature) ||
      cached && cached.identity === signature && HASH.test(cached.hash) && cached.hash);
    const reused = !!checksum;
    if (reused) ++stats.reusedFiles;
    else {
      const hasher = crypto.createHash('sha256');
      for await (const chunk of fs.createReadStream(file)) hasher.update(chunk);
      checksum = hasher.digest('hex');
      ++stats.hashedFiles; stats.hashedBytes += Number(before.size);
    }
    const after = await fsp.lstat(file, { bigint: true });
    if (!after.isFile() || identity(after) !== signature) throw new Error('preparation input changed while verifying');
    files[file] = { identity: signature, hash: checksum };
    known.set(signature, checksum);
    return { hash: checksum, reused, size: Number(before.size) };
  }
  async function hash(file) { return (await inspect(file)).hash; }
  async function validatedJson(file, validate) {
    file = path.resolve(file);
    const before = await fsp.lstat(file, { bigint: true });
    if (!before.isFile()) return null;
    const signature = identity(before), cached = previous[file] || jsonValues.get(signature);
    const reused = !verifyHashes && cached?.identity === signature && cached.json !== undefined;
    let value, checksum;
    if (reused) { value = cached.json; checksum = cached.hash; ++stats.jsonReuses; }
    else {
      const bytes = await fsp.readFile(file);
      value = JSON.parse(bytes); checksum = digest(bytes); ++stats.jsonReads;
    }
    if (!await validate(value, reused)) return null;
    const after = await fsp.lstat(file, { bigint: true });
    if (!after.isFile() || identity(after) !== signature) return null;
    files[file] = { identity: signature, hash: checksum, json: value };
    jsonValues.set(signature, files[file]);
    return value;
  }
  async function save() {
    const checksum = digest(JSON.stringify(files));
    if (checksum === previousHash) return;
    const temporary = index + '.stage-' + crypto.randomBytes(6).toString('hex');
    try {
      await fsp.writeFile(temporary, JSON.stringify({ version: 1, files, hash: checksum }) + '\n', { flag: 'wx' });
      await fsp.rename(temporary, index);
    } finally { await fsp.rm(temporary, { force: true }); }
  }
  return { hash, inspect, validatedJson, save, stats };
}

module.exports = { preparationFiles };
