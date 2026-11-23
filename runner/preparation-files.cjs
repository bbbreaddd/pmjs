'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');

const HASH = /^[a-f0-9]{64}$/;
const FUSE_SUPER_MAGIC = 0x65735546;
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const fileIdentity = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.birthtimeNs].join(':');

function fileIdentityMatches(expected, stat, file, filesystemTypes = new Map()) {
  if (expected === fileIdentity(stat)) return true;
  if (!/^\d+(?::\d+){5}$/.test(expected || '')) return false;
  const before = expected.split(':');
  const after = fileIdentity(stat).split(':');
  if (before.length !== 6 || before.some((value, index) => index !== 1 && value !== after[index])) return false;
  if (!filesystemTypes.has(stat.dev)) {
    let type;
    try { type = fs.statfsSync(file).type; } catch (_) { type = null; }
    filesystemTypes.set(stat.dev, type);
  }
  return filesystemTypes.get(stat.dev) === FUSE_SUPER_MAGIC;
}

async function writeJson(file, value, flush = true) {
  const handle = await fsp.open(file, 'wx');
  try {
    await handle.writeFile(JSON.stringify(value) + '\n');
    if (flush) await handle.sync();
  } finally { await handle.close(); }
}

async function preparationFiles(session, verifyHashes = false) {
  const previous = session.data.files;
  const files = {}, known = new Map(), filesystemTypes = new Map();
  let readBuffer;
  const stats = { hashedFiles: 0, hashedBytes: 0, reusedFiles: 0, jsonReads: 0, jsonReuses: 0,
    copiedFiles: 0, copiedBytes: 0, publicationReuses: 0, hashedBytesByCategory: {} };
  function saveReceipt(file, receipt) {
    const cached = session.data.files[file];
    const same = cached && cached.identity === receipt.identity && cached.hash === receipt.hash &&
      cached.header === receipt.header;
    const stored = same ? cached : receipt;
    if (!same) session.markDirty?.();
    files[file] = stored;
    session.data.files[file] = stored;
    return stored;
  }
  const identity = fileIdentity;
  function matchesReceipt(receipt, signature, file, stat, allowInodeDrift) {
    if (!receipt || !HASH.test(receipt.hash)) return false;
    if (receipt.identity === signature) return true;
    return allowInodeDrift && fileIdentityMatches(receipt.identity, stat, file, filesystemTypes);
  }
  function containedGameFile(file) {
    return (session.sourceRoots || [session.gameRoot]).some(root => {
      if (!root) return false;
      const relative = path.relative(root, file);
      return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
    });
  }
  async function inspectPath(file) {
    const lexical = path.resolve(file);
    const link = await fsp.lstat(lexical, { bigint: true });
    if (!link.isSymbolicLink() || !containedGameFile(lexical)) return { file: lexical, stat: link };
    const resolved = await fsp.realpath(lexical);
    if (!containedGameFile(resolved)) throw new Error('preparation symlink target outside game root');
    const stat = await fsp.stat(resolved, { bigint: true });
    if (!stat.isFile()) throw new Error('preparation input is not a regular file');
    return { file: resolved, stat, gameRooted: true };
  }
  async function inspect(file, category = 'other') {
    file = path.resolve(file);
    const packed = session.packedFiles?.get(file);
    if (packed) {
      const checked = await require('./packed-cache.cjs').inspectPacked(packed, verifyHashes);
      if (checked.reused) ++stats.reusedFiles;
      else {
        ++stats.hashedFiles; stats.hashedBytes += checked.size;
        stats.hashedBytesByCategory[category] = (stats.hashedBytesByCategory[category] || 0) + checked.size;
      }
      return checked;
    }
    const inspected = await inspectPath(file), actual = inspected.file, before = inspected.stat;
    if (!before.isFile()) throw new Error('preparation input is not a regular file');
    const signature = identity(before);
    const cached = previous[file];
    const retained = known.get(signature);
    const receipt = !verifyHashes && matchesReceipt(cached, signature, actual, before, !inspected.gameRooted) ? cached : null;
    let header = retained?.header || (cached?.header ? Buffer.from(cached.header, "base64") : undefined);
    let checksum = retained?.hash || receipt?.hash;
    const reused = !!checksum;
    if (reused) ++stats.reusedFiles;
    else {
      const hasher = crypto.createHash('sha256');
      header = Buffer.alloc(0);
      const buffer = readBuffer || Buffer.allocUnsafe(256 * 1024);
      readBuffer = undefined;
      let handle;
      try {
        handle = await fsp.open(actual, 'r');
        for (;;) {
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
          if (!bytesRead) break;
          const chunk = buffer.subarray(0, bytesRead);
          hasher.update(chunk);
          if (header.length < 32) header = Buffer.concat([header, chunk.subarray(0, 32 - header.length)]);
        }
      } finally {
        try { await handle?.close(); }
        finally { readBuffer ||= buffer; }
      }
      checksum = hasher.digest('hex');
      ++stats.hashedFiles; stats.hashedBytes += Number(before.size);
      stats.hashedBytesByCategory[category] = (stats.hashedBytesByCategory[category] || 0) + Number(before.size);
      const after = await fsp.stat(actual, { bigint: true });
      if (!after.isFile() || identity(after) !== signature ||
          inspected.gameRooted && await fsp.realpath(file) !== actual)
        throw new Error('preparation input changed while verifying');
    }
    saveReceipt(file, { identity: receipt?.identity || signature, hash: checksum, ...(header ? { header: header.toString("base64") } : {}) });
    known.set(signature, { hash: checksum, header });
    return { hash: checksum, reused, size: Number(before.size), header };
  }
  function inspectSync(file, bytes, category = 'other') {
    file = path.resolve(file);
    const link = fs.lstatSync(file, { bigint: true });
    let stat = link;
    if (link.isSymbolicLink()) {
      if (!containedGameFile(file)) throw new Error('preparation input symlink is not authorized');
      const actual = fs.realpathSync(file);
      if (!containedGameFile(actual)) throw new Error('preparation symlink target outside game root');
      stat = fs.statSync(actual, { bigint: true });
    }
    if (!stat.isFile()) throw new Error('preparation input is not a regular file');
    const signature = identity(stat), retained = known.get(signature), cached = previous[file];
    const receipt = !verifyHashes && matchesReceipt(cached, signature, file, stat, !link.isSymbolicLink()) ? cached : null;
    let checksum = retained?.hash || receipt?.hash;
    if (!checksum) {
      checksum = digest(bytes);
      ++stats.hashedFiles; stats.hashedBytes += bytes.length;
      stats.hashedBytesByCategory[category] = (stats.hashedBytesByCategory[category] || 0) + bytes.length;
    } else ++stats.reusedFiles;
    const header = Buffer.from(bytes.subarray(0, 32));
    saveReceipt(file, { identity: receipt?.identity || signature, hash: checksum, header: header.toString('base64') });
    known.set(signature, { hash: checksum, header });
    return { hash: checksum, size: bytes.length, header };
  }
  async function size(file) {
    return session.packedFiles?.get(path.resolve(file))?.size ?? (await fsp.stat(file)).size;
  }
  async function hash(file, category) { return (await inspect(file, category)).hash; }
  async function writeVerified(target, chunks, { expectedHash, expectedSize, category = 'output' } = {}) {
    if (expectedHash !== undefined && !HASH.test(expectedHash)) throw new Error('invalid expected output checksum');
    let output, created = false;
    try {
      output = await fsp.open(target, 'wx'); created = true;
      const hasher = crypto.createHash('sha256');
      let header = Buffer.alloc(0), size = 0;
      for await (const chunk of chunks) {
        size += chunk.length;
        if (expectedSize !== undefined && size > expectedSize) throw new Error('output size differs');
        hasher.update(chunk);
        if (header.length < 32) header = Buffer.concat([header, chunk.subarray(0, 32 - header.length)]);
        await output.writeFile(chunk);
      }
      ++stats.hashedFiles; stats.hashedBytes += size;
      stats.hashedBytesByCategory[category] = (stats.hashedBytesByCategory[category] || 0) + size;
      const checksum = hasher.digest('hex');
      if (expectedHash !== undefined && checksum !== expectedHash) throw new Error('copied input checksum differs');
      if (expectedSize !== undefined && size !== expectedSize) throw new Error('output size differs');
      const written = await output.stat({ bigint: true });
      await output.close(); output = undefined;
      if (!written.isFile() || Number(written.size) !== size ||
          identity(written) !== identity(await fsp.lstat(target, { bigint: true })))
        throw new Error('output changed while writing');
      const signature = identity(written);
      saveReceipt(path.resolve(target), { identity: signature, hash: checksum });
      known.set(signature, { hash: checksum, header });
      return { hash: checksum, header, size };
    } catch (error) {
      if (created) await fsp.rm(target, { force: true });
      throw error;
    } finally { await output?.close(); }
  }
  async function copyVerified(source, target, expectedHash, category = 'import') {
    if (!HASH.test(expectedHash)) throw new Error('invalid expected copy checksum');
    const input = await fsp.open(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const before = await input.stat({ bigint: true });
      if (!before.isFile()) throw new Error('copy input is not a regular file');
      async function* chunks() {
        const buffer = Buffer.alloc(256 * 1024);
        for (;;) {
          const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
          if (!bytesRead) break;
          yield buffer.subarray(0, bytesRead);
        }
        if (identity(before) !== identity(await input.stat({ bigint: true })) ||
            identity(before) !== identity(await fsp.lstat(source, { bigint: true })))
          throw new Error('copy input changed while copying');
      }
      const checked = await writeVerified(target, chunks(), { expectedHash, expectedSize: Number(before.size), category });
      ++stats.copiedFiles; stats.copiedBytes += checked.size;
      return checked;
    } finally { await input.close(); }
  }
  async function publish(source, target) {
    const from = path.resolve(source), to = path.resolve(target), receipt = files[from];
    const before = receipt && await fsp.lstat(from, { bigint: true }).catch(() => null);
    await fsp.rename(source, target);
    // Directory renames preserve child identities, so inspect can reuse them directly.
    if (!before?.isFile() || identity(before) !== receipt.identity) return;
    const after = await fsp.lstat(to, { bigint: true });
    // A directly renamed file may acquire a new ctime; retain the other identity fields.
    if (!after.isFile() || ['dev', 'ino', 'size', 'mtimeNs', 'birthtimeNs'].some(key => before[key] !== after[key])) return;
    const signature = identity(after);
    saveReceipt(to, { ...receipt, identity: signature });
    known.set(signature, known.get(receipt.identity) || { hash: receipt.hash });
    ++stats.publicationReuses;
  }
  async function validatedManifest(directory, validate) {
    const value = session.readManifest(directory);
    if (!value || !await validate(value, !verifyHashes)) return null;
    session.touch(directory);
    return value;
  }
  async function validateOutputs(directory, outputs, checksumOf, validate) {
    for (const output of outputs) {
      const expected = checksumOf(output);
      if (!HASH.test(expected || '')) return false;
      const file = path.join(directory, output.path);
      const checked = await inspect(file, 'output');
      if (checked.hash !== expected || !await validate(output, file, checked)) return false;
    }
    return true;
  }
  async function save() {
    for (const [file, receipt] of Object.entries(files)) {
      if (session.data.files[file] !== receipt) {
        session.data.files[file] = receipt;
        session.markDirty?.();
      }
    }
    await session.checkpoint();
  }
  return { hash, inspect, inspectSync, size, writeVerified, copyVerified, publish, validatedManifest, validateOutputs, save, stats, receipts: files,
    writeManifest: session.writeManifest,
    publishManifest: session.publishManifest };

}

module.exports = { preparationFiles, writeJson, fileIdentity, fileIdentityMatches };
