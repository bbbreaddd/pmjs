'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { temporaryDirectory } = require('./helpers/temp.cjs');
const { png } = require('./helpers/png.cjs');
const { prepareGameFiles } = require('../runner/game-preparation.cjs');
const { createGameFilesystem } = require('../runner/storage.cjs');
const { prepareAssets } = require('../runner/asset-preparation.cjs');
const native = require(path.resolve(process.argv[2]));
const root = temporaryDirectory('readonly-overlay-'), gameRoot = path.join(root, 'game');
function write(name, bytes) {
  const filename = path.join(root, name); fs.mkdirSync(path.dirname(filename), { recursive: true }); fs.writeFileSync(filename, bytes);
}
write('game/descriptor.txt', 'original');
write('game/js/plugins.js', 'var $plugins = [];');
write('game/index.html', '<script src="modloader/early_loader.js"></script>');
write('game/modloader/early_loader.js', '// installed loader');
write('game/img/pictures/É.png', png(1, 1, new Uint8Array(4).fill(255)));
const outputs = [
  { path: 'img/pictures/new.png', bytes: png(3, 2, new Uint8Array(3 * 2 * 4).fill(255)) },
  { path: 'img/pictures/É.png', bytes: png(4, 2, new Uint8Array(4 * 2 * 4).fill(255)) },
  { path: 'js/plugins/test.js', bytes: Buffer.from('globalThis.modLoaded = true;') },
  { path: 'js/plugins/Énergie.js', bytes: Buffer.from('globalThis.unicodeLoaded = true;') }
];
async function main() {
native.initialize({ gameRoot, width: 16, height: 16, windowTitle: 'Read-only overlay' });
try {
  const options = { gameRoot, saveRoot: path.join(root, 'save'), assetPreparation: { cacheRoot: path.join(root, 'cache') },
    gamePreparation: 'patches/omori/oneloader.cjs' };
  assert.deepEqual(prepareGameFiles(options, native), []);
  const roots = [await native.runtime.oneLoader.publish(outputs)];
  assert.equal(roots.length, 1);
  assert.equal(native.fs.readText('js/plugins/test.js'), 'globalThis.modLoaded = true;');
  assert.deepEqual(native.fs.readDirectory('IMG/PICTURES'), ['new.png', 'É.png']);
  assert.equal(native.assets.sourcePath('img/pictures/new.png'), path.join(roots[0], 'img/pictures/new.png'));
  write('outside.js', 'globalThis.modLoaded = true;');
  const script = path.join(roots[0], 'js/plugins/test.js');
  fs.unlinkSync(script); fs.symlinkSync(path.join(root, 'outside.js'), script);
  fs.copyFileSync(path.join(roots[0], 'img/pictures/new.png'), path.join(roots[0], 'img/pictures/stale.png'));
  assert.deepEqual([await native.runtime.oneLoader.publish(outputs)], roots);
  assert.equal(fs.lstatSync(script).isSymbolicLink(), false);
  assert.equal(native.fs.readText('js/plugins/test.js'), 'globalThis.modLoaded = true;');
  assert.equal(native.fs.exists('img/pictures/stale.png'), false);
  assert.deepEqual(native.fs.readDirectory('img/pictures'), ['new.png', 'É.png']);
  const prepared = await prepareAssets({ gameRoot, cacheRoot: options.assetPreparation.cacheRoot, sourceRoots: roots, native });
  assert.equal(prepared.installFailures, 0);
  assert.equal(prepared.failedFiles, 0);
  assert.ok(prepared.entries.some(entry => entry.source === 'img/pictures/new.png'));
  const image = native.images.load('IMG/pictures/NEW.png');
  assert.equal(image.width, 3); assert.equal(image.height, 2); native.images.release(image.handle);
  assert.equal(native.fs.readText('js/plugins/Énergie.js'), 'globalThis.unicodeLoaded = true;');
  const unicodeImage = native.images.load('IMG/pictures/É.png');
  assert.equal(unicodeImage.width, 4); assert.equal(unicodeImage.height, 2);
  native.images.release(unicodeImage.handle);
  const gameFiles = createGameFilesystem(native.fs, path.join(root, 'save/game-files'));
  gameFiles.writeBytes('js/plugins/test.js', Buffer.from('player replacement'));
  assert.equal(native.fs.readText('js/plugins/test.js'), 'player replacement');
  assert.equal(fs.readFileSync(path.join(roots[0], 'js/plugins/test.js'), 'utf8'), 'globalThis.modLoaded = true;');
  const descriptor = gameFiles.openFile('descriptor.txt', 'r+');
  descriptor.write('changed!', 0, 'utf8'); descriptor.close();
  assert.equal(native.fs.readText('descriptor.txt'), 'changed!');
  assert.equal(fs.readFileSync(path.join(gameRoot, 'descriptor.txt'), 'utf8'), 'original');
  assert.throws(() => descriptor.stat(), { code: 'EBADF' });
  write('protected.txt', 'untouched');
  fs.symlinkSync(path.join(root, 'protected.txt'), path.join(root, 'save/game-files/files/escape.txt'));
  assert.throws(() => gameFiles.openFile('escape.txt', 'w'), { code: 'EACCES' });
  assert.equal(fs.readFileSync(path.join(root, 'protected.txt'), 'utf8'), 'untouched');
  assert.throws(() => prepareGameFiles({ ...options, gamePreparation: '../outside.cjs' }, native));
} finally { native.runtime.quit(); }

}
main().catch(error => { console.error(error); process.exitCode = 1; });
