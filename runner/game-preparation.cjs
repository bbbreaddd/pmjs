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
    this.staging = fs.mkdtempSync(path.join(this.parent, '.build-'));
    this.outputs = new Map();
    this.spellings = new Map();
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
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes);
    this.outputs.set(name, { hash: hash(bytes) });
  }
  finish() {
    const fingerprint = hash(JSON.stringify([...this.outputs].sort(([a], [b]) => a.localeCompare(b)).map(([name, output]) => [name, output.hash])));
    const root = path.join(this.parent, fingerprint);
    const valid = validCache(root, this.outputs, Buffer.allocUnsafe(64 * 1024));
    if (!valid) {
      fs.rmSync(root, { recursive: true, force: true }); fs.renameSync(this.staging, root);
    }
    return { root, changed: !valid };
  }
  dispose() { fs.rmSync(this.staging, { recursive: true, force: true }); }
}

function prepareGameFiles(options, native) {
  if (!options.gamePreparation) return [];
  const root = fs.existsSync(path.join(__dirname, 'patches')) ? __dirname : path.resolve(__dirname, '..');
  const declaration = options.gamePreparation;
  if (typeof declaration !== 'string' || !declaration.endsWith('.cjs'))
    throw new Error('gamePreparation must name a runtime .cjs module');
  const filename = fs.realpathSync(path.resolve(root, declaration));
  if (!filename.startsWith(root + path.sep)) throw new Error('gamePreparation must be inside the runtime');
  const result = require(filename).prepare({ native, gameRoot: options.gameRoot, saveRoot: options.saveRoot,
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
