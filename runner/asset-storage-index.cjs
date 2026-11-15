'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { validStorageDecision } = require('./asset-preparation.cjs');
const { fileIdentity } = require('./preparation-files.cjs');

const hash = value => crypto.createHash('sha256').update(value).digest('hex');

function storageClassifier(assets, cacheRoot) {
  const version = assets.imageStorageVersion;
  const file = path.join(cacheRoot, 'image-storage.json');
  let saved = {};
  try {
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (record && record.decisions && typeof record.decisions === 'object' && record.version === version &&
        record.checksum === hash(JSON.stringify(record.decisions))) saved = record.decisions;
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
  const pending = new Map(), decisions = {};
  const receipts = new Map();
  async function checksumOf(source) {
    const before = fileIdentity(await fs.promises.stat(source, { bigint: true }));
    const receipt = receipts.get(source);
    if (receipt?.identity === before) return receipt.hash;
    const digest = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(source)) digest.update(chunk);
    if (fileIdentity(await fs.promises.stat(source, { bigint: true })) !== before)
      throw new Error('image changed during storage classification');
    const checksum = digest.digest('hex');
    receipts.set(source, { identity: before, hash: checksum });
    return checksum;
  }
  return {
    async classify(source) {
      const checksum = await checksumOf(source);
      if (!pending.has(checksum)) {
        const work = (async () => {
          const storage = validStorageDecision(saved[checksum]) ? saved[checksum] :
            await assets.classifyImageStorage(source);
          if (!validStorageDecision(storage)) throw new Error('invalid image storage decision');
          if (await checksumOf(source) !== checksum)
            throw new Error('image changed during storage classification');
          decisions[checksum] = storage;
          return storage;
        })();
        pending.set(checksum, work);
        work.catch(() => pending.delete(checksum));
      }
      const storage = await pending.get(checksum);
      if (await checksumOf(source) !== checksum)
        throw new Error('image changed during storage classification');
      return storage;
    },
    save() {
      const ordered = Object.fromEntries(Object.entries(decisions).sort(([a], [b]) => a.localeCompare(b)));
      const next = file + '.stage-' + process.pid;
      try {
        fs.writeFileSync(next, JSON.stringify({ version,
          checksum: hash(JSON.stringify(ordered)), decisions: ordered }));
        fs.renameSync(next, file);
      } finally { fs.rmSync(next, { force: true }); }
    }
  };
}

async function mapStorageInputs(values, operation, concurrency = 4) {
  const results = new Array(values.length);
  let next = 0, failed = false;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (!failed && next < values.length) {
      const index = next++;
      try { results[index] = await operation(values[index]); }
      catch (error) { failed = true; throw error; }
    }
  });
  const settled = await Promise.allSettled(workers);
  const failure = settled.find(result => result.status === 'rejected');
  if (failure) throw failure.reason;
  return results;
}

module.exports = { storageClassifier, mapStorageInputs };
