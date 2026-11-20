'use strict';
const fs = require('node:fs');
const path = require('node:path');

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
    read(name) {
      const bytes = native.fs.readBytes(name);
      if (bytes === null) throw new Error('game preparation input not found: ' + name);
      return Buffer.from(bytes);
    } });
  if (!result) return [];
  native.fs.mountReadOnlyOverlay(result.root);
  return [result.root];
}
module.exports = { prepareGameFiles };
