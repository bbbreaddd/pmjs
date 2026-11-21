'use strict';
const fs = require('node:fs');
const path = require('node:path');
const compatibility = require('./v1-compatibility.cjs');
const { createGameFiles } = require('./game-files.cjs');

function writeMetadata(options, write) {
  const { native } = options;
  const files = createGameFiles(options);
  native.runtime.gameFiles = { resolve: files.resolve };
  function visit(directory) {
    for (const name of native.fs.readDirectory(directory || '.') || []) {
      const source = directory ? directory + '/' + name : name;
      if (native.fs.isDirectory(source)) visit(source);
      else if (/^(?:data|maps|js\/plugins)\//i.test(source) && /\.(?:KEL|AUBREY|OMORI)$/i.test(source)) {
        const extension = /\.OMORI$/i.test(source) ? '.js' : '.json';
        const logical = source.replace(/\.[^.]+$/, extension);
        const bytes = files.read(source);
        write(logical, bytes);
      }
    }
  }
  for (const directory of ['data', 'maps', 'js/plugins'])
    if (native.fs.exists(directory) && native.fs.isDirectory(directory)) visit(directory);
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
  const baseFiles = new Set();
  const createLayer = () => output || (output = options.createLayer('omori-files'));
  try {
    writeMetadata(options, (name, bytes) => { createLayer().write(name, bytes); baseFiles.add(name); });
    const backport = compatibility.prepare({ native, files: createGameFiles({ ...options, createLayer }) });
    for (const file of backport?.files || []) baseFiles.add(file.path);
    prepared = backport || (output ? output.finish() : null);
  } finally { if (output) output.dispose(); }
  const files = createGameFiles(options);
  native.runtime.omoriFiles = files;
  native.runtime.gameFiles = { resolve: files.resolve, remove: files.remove, rename: files.rename,
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
  if (!native.fs.exists('modloader/early_loader.js')) return prepared;
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
        for (const name of baseFiles) layer.write(name, fs.readFileSync(path.join(prepared.root, name)));
        for await (const entry of entries) layer.write(entry.path, entry.bytes);
        const { root, changed } = layer.finish();
        if (mountedRoot !== root || changed) {
          native.fs.mountReadOnlyOverlay(root);
          if (native.runtime.refreshAssets) await native.runtime.refreshAssets([root]);
          mountedRoot = root;
        }
        return root;
      } finally { layer.dispose(); }
    }
  };
  return prepared;
}
module.exports = { prepare, prepareAssetIndex: prepareMetadata };
