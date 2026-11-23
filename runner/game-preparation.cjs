'use strict';
const fs = require('node:fs');
const path = require('node:path');

const crypto = require('node:crypto');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function fileHash(filename, buffer) {
  const descriptor = fs.openSync(filename, 'r'), checksum = crypto.createHash('sha256');
  try {
    let count;
    while ((count = fs.readSync(descriptor, buffer, 0, buffer.length, null))) {
      const bytes = buffer.subarray(0, count);
      checksum.update(bytes);
    }
    return checksum.digest('hex');
  } finally { fs.closeSync(descriptor); }
}
function validCache(root, outputs, buffer) {
  const remaining = new Set(outputs.keys()), directories = new Set();
  for (const name of outputs.keys()) {
    let directory = path.posix.dirname(name);
    while (directory !== '.') { directories.add(directory); directory = path.posix.dirname(directory); }
  }
  function visit(directory, prefix = '') {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const name = prefix + entry.name, filename = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!directories.has(name) || !visit(filename, name + '/')) return false;
      } else if (!entry.isFile() || !remaining.delete(name) || fileHash(filename, buffer) !== outputs.get(name).hash) return false;
    }
    return true;
  }
  try { return fs.lstatSync(root).isDirectory() && visit(root) && remaining.size === 0; }
  catch { return false; }
}

class GameFileLayer {
  constructor(cacheRoot, name) {
    this.parent = path.join(cacheRoot, name);
    fs.mkdirSync(this.parent, { recursive: true });
    this.outputs = new Map();
    this.previous = new Map();
    const current = path.join(this.parent, 'current.json');
    try {
      const manifest = JSON.parse(fs.readFileSync(current, 'utf8'));
      if (manifest && /^[a-f0-9]{64}$/.test(manifest.fingerprint) &&
          Array.isArray(manifest.outputs) && manifest.outputs.every(entry =>
            Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string' && /^[a-f0-9]{64}$/.test(entry[1]))) {
        this.previousRoot = path.join(this.parent, manifest.fingerprint);
        for (const [name, checksum] of manifest.outputs) this.previous.set(name, checksum);
      }
    } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    this.spellings = new Map();
    this.staging = fs.mkdtempSync(path.join(this.parent, '.build-'));
  }
  write(name, input) {
    if (typeof name !== 'string' || !name || path.isAbsolute(name) || name.includes('\\') || name.includes('\0') ||
        name.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('invalid prepared game file path');
    let prefix = '';
    name = name.split('/').map(part => {
      prefix += '/' + part.replace(/[A-Z]/g, letter => letter.toLowerCase());
      if (!this.spellings.has(prefix)) this.spellings.set(prefix, part);
      return this.spellings.get(prefix);
    }).join('/');
    const file = path.join(this.staging, name), bytes = Buffer.from(input);
    const checksum = hash(bytes);
    const previous = this.previousRoot && path.join(this.previousRoot, name);
    let reusable = false;
    if (this.previous.get(name) === checksum) {
      try {
        reusable = fs.lstatSync(previous).isFile() &&
          fileHash(previous, Buffer.allocUnsafe(64 * 1024)) === checksum;
      } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
    }
    if (!reusable) {
      fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes);
    } else {
      fs.rmSync(file, { force: true });
    }
    this.outputs.set(name, { hash: checksum, previous: reusable ? previous : null });
  }
  finish() {
    const fingerprint = hash(JSON.stringify([...this.outputs].sort(([a], [b]) => a.localeCompare(b)).map(([name, output]) => [name, output.hash])));
    const root = path.join(this.parent, fingerprint);
    const valid = validCache(root, this.outputs, Buffer.allocUnsafe(64 * 1024));
    if (!valid) {
      for (const [name, output] of this.outputs) if (output.previous) {
        const file = path.join(this.staging, name);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.copyFileSync(output.previous, file);
      }
      if (!validCache(this.staging, this.outputs, Buffer.allocUnsafe(64 * 1024)))
        throw new Error('prepared game layer changed during publication');
      fs.rmSync(root, { recursive: true, force: true }); fs.renameSync(this.staging, root);
    }
    const manifest = path.join(this.parent, path.basename(this.staging) + '.json');
    try {
      fs.writeFileSync(manifest, JSON.stringify({ fingerprint, outputs: [...this.outputs].map(([name, output]) => [name, output.hash]) }));
      fs.renameSync(manifest, path.join(this.parent, 'current.json'));
    } finally { fs.rmSync(manifest, { force: true }); }
    return { root, changed: !valid };
  }
  dispose() { fs.rmSync(this.staging, { recursive: true, force: true }); }
}

function prepareGameFiles(options, native, phase = 'prepare') {
  if (!options.gamePreparation) return [];
  const root = fs.existsSync(path.join(__dirname, 'patches')) ? __dirname : path.resolve(__dirname, '..');
  const declaration = options.gamePreparation;
  if (typeof declaration !== 'string' || !declaration.endsWith('.cjs'))
    throw new Error('gamePreparation must name a runtime .cjs module');
  const filename = fs.realpathSync(path.resolve(root, declaration));
  if (!filename.startsWith(root + path.sep)) throw new Error('gamePreparation must be inside the runtime');
  const prepare = require(filename)[phase];
  if (phase === 'prepareAssetIndex' && typeof prepare !== 'function') return [];
  const result = prepare({ native, gameRoot: options.gameRoot, saveRoot: options.saveRoot,
    cacheRoot: options.assetPreparation.cacheRoot,
    configuration: options.config ? JSON.parse(fs.readFileSync(options.config, 'utf8')) : {},
    createLayer(name) { return new GameFileLayer(options.assetPreparation.cacheRoot, name); },
    readAsync(name) { return native.fs.readBytesAsync(name); },
    read(name) {
      const bytes = native.fs.readBytes(name);
      if (bytes === null) throw new Error('game preparation input not found: ' + name);
      return Buffer.from(bytes);
    } });
  if (!result) return [];
  native.fs.mountReadOnlyOverlay(result.root);
  return [result.root];
}
module.exports = { prepareGameFiles, GameFileLayer };
