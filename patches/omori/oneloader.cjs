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


function prepare({ native, cacheRoot, read }) {
  delete native.runtime.oneLoader;
  if (!native.fs.exists('modloader/early_loader.js')) return null;
  const html = read('index.html').toString('utf8');
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)].map(match => {
    const source = match[1].match(/\bsrc\s*=\s*["']([^"']+)["']/i);
    return source ? { path: source[1].replace(/^\.\//, '') } : { source: match[2] };
  });
  if (!scripts.some(script => script.path === 'modloader/early_loader.js'))
    throw new Error('OneLoader installation is incomplete: index.html does not load early_loader.js');
  let mountedRoot;
  native.runtime.oneLoader = {
    scripts,
    importModule(name) {
      const source = read(name);
      return import('data:text/javascript;base64,' + source.toString('base64'));
    },
    async publish(entries) {
      const parent = path.join(cacheRoot, 'oneloader');
      fs.mkdirSync(parent, { recursive: true });
      const staging = fs.mkdtempSync(path.join(parent, '.build-')), outputs = new Map();
      try {
        for await (const entry of entries) {
          const name = entry.path;
          if (typeof name !== 'string' || !name || path.isAbsolute(name) || name.includes('\\') || name.includes('\0') ||
              name.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('invalid OneLoader output path');
          const file = path.join(staging, name), bytes = Buffer.from(entry.bytes);
          fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes);
          outputs.set(name, { file, hash: hash(bytes) });
        }
        const fingerprint = hash(JSON.stringify([...outputs].sort(([a], [b]) => a.localeCompare(b)).map(([name, output]) => [name, output.hash])));
        const root = path.join(parent, fingerprint);
        const valid = validCache(root, outputs, Buffer.allocUnsafe(64 * 1024));
        if (!valid) {
          fs.rmSync(root, { recursive: true, force: true }); fs.renameSync(staging, root);
        }
        if (mountedRoot !== root || !valid) {
          native.fs.mountReadOnlyOverlay(root);
          if (native.runtime.refreshAssets) await native.runtime.refreshAssets([root]);
          mountedRoot = root;
        }
        return root;
      } finally { fs.rmSync(staging, { recursive: true, force: true }); }
    }
  };
  return null;
}
module.exports = { prepare };
