'use strict';
const fs = require('node:fs');
const path = require('node:path');
const compatibility = require('./v1-compatibility.cjs');
const { createGameFiles } = require('./game-files.cjs');

function writeMetadata(options, write) {
  const { native } = options;
  const files = createGameFiles(options);
  native.runtime.gameFiles = { resolve: files.resolve, canonical: files.canonical,
    decode: files.decode, dependencies: files.dependencies };
  if (files.exists('data/System.json')) write('data/System.json', files.read('data/System.json'));
}

function prepareMetadata(options) {
  let output;
  try {
    writeMetadata(options, (name, bytes) => {
      if (!output) output = options.createLayer('omori-metadata');
      output.write(name, bytes);
    });
    return output ? output.finish() : null;
  } finally { if (output) output.dispose(); }
}

function prepare(options) {
  const { native, read } = options;
  let output, prepared;
  const metadataFiles = new Set();
  const createLayer = () => output || (output = options.createLayer('omori-files'));
  const files = createGameFiles(options);
  const logicalKey = name => files.canonical(name).replace(/[A-Z]/g, letter => letter.toLowerCase());
  const hasOneLoader = native.fs.exists('modloader/early_loader.js');
  const originalSnapshot = new Map();
  if (hasOneLoader) {
    for (const name of compatibility.watchedPaths) {
      if (files.exists(name)) originalSnapshot.set(logicalKey(name), files.read(name));
    }
  }
  const initialFiles = hasOneLoader ? {
    exists: name => originalSnapshot.has(logicalKey(name)),
    read: name => {
      const key = logicalKey(name);
      if (originalSnapshot.has(key)) return originalSnapshot.get(key);
      throw new Error('OMORI game file is missing: ' + files.canonical(name));
    }
  } : files;
  const initialEvaluation = compatibility.evaluate({ native, files: initialFiles });
  try {
    writeMetadata(options, (name, bytes) => { createLayer().write(name, bytes); metadataFiles.add(name); });
    for (const [name, bytes] of initialEvaluation.files) createLayer().write(name, bytes);
    prepared = output ? output.finish() : null;
    compatibility.applyDataBackports(native, initialEvaluation.backports);
  } finally { if (output) output.dispose(); }
  native.runtime.omoriFiles = files;
  native.runtime.gameFiles = { resolve: files.resolve, remove: files.remove, rename: files.rename,
    canonical: files.canonical, decode: files.decode, dependencies: files.dependencies,
    needsDecodedRead: files.needsDecodedRead,
    readBytesAsync: files.readAsync, readBytes: name => files.exists(name) ? files.read(name) : null };
  native.runtime.readGameScript = name => {
    if (!files.exists(name)) return null;
    let source = files.read(name).toString('utf8');
    if (name === 'modloader/encryption.js') source = source.replace(
      /(class\s+Encryption\s*\{\s*constructor\s*\([^)]*\)\s*\{)/,
      '$1\nthis.decrypt = NativeHost.runtime.omoriFiles.decodeText;\n');
    return source;
  };
  delete native.runtime.oneLoader;
  if (!hasOneLoader) return prepared;
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
      const layer = files.createLayer('oneloader');
      try {
        for (const name of metadataFiles) layer.write(name, fs.readFileSync(path.join(prepared.root, name)));
        const overridden = new Map();
        for await (const entry of entries) {
          const key = logicalKey(entry.path);
          if (compatibility.watchedKeys.has(key)) {
            const decoded = files.decode(entry.path, entry.bytes);
            overridden.set(key, decoded);
            layer.write(entry.path, decoded);
          } else {
            layer.write(entry.path, entry.bytes);
          }
        }
        const effectiveFiles = {
          exists(name) {
            const key = logicalKey(name);
            return overridden.has(key) || originalSnapshot.has(key);
          },
          read(name) {
            const key = logicalKey(name);
            if (overridden.has(key)) return overridden.get(key);
            if (originalSnapshot.has(key)) return originalSnapshot.get(key);
            throw new Error('OMORI game file is missing: ' + files.canonical(name));
          }
        };
        const evaluated = overridden.size > 0
          ? compatibility.evaluate({ native, files: effectiveFiles })
          : initialEvaluation;
        for (const [name, bytes] of evaluated.files) layer.write(name, bytes);
        const { root, changed } = layer.finish();
        if (mountedRoot !== root || changed) {
          native.fs.mountReadOnlyOverlay(root);
          if (native.runtime.refreshAssets) await native.runtime.refreshAssets([root]);
          mountedRoot = root;
        }
        compatibility.applyDataBackports(native, evaluated.backports);
        return root;
      } finally { layer.dispose(); }
    }
  };
  return prepared;
}
module.exports = { prepare, prepareAssetIndex: prepareMetadata };
