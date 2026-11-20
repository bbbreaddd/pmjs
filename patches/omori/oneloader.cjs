'use strict';
const compatibility = require('./v1-compatibility.cjs');
const { createGameFiles } = require('./game-files.cjs');

function prepare(options) {
  const { native, read } = options;
  const files = createGameFiles(options);
  native.runtime.omoriFiles = files;
  native.runtime.gameFiles = { resolve: files.resolve, readBytesAsync: files.readAsync, readBytes: name => files.exists(name) ? files.read(name) : null };
  native.runtime.readGameScript = name => files.exists(name) ? files.read(name).toString('utf8') : null;
  const backport = compatibility.prepare({ native, files });
  delete native.runtime.oneLoader;
  if (!native.fs.exists('modloader/early_loader.js')) return backport;
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
        for (const entry of backport?.files || []) layer.write(entry.path, entry.bytes);
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
  return backport;
}
module.exports = { prepare };
