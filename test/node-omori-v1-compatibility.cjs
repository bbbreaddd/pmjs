'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { temporaryDirectory } = require('./helpers/temp.cjs');
const { png } = require('./helpers/png.cjs');
const { bedroom } = require('./helpers/omori-bedroom.cjs');
const { prepareGameFiles, GameFileLayer } = require('../runner/game-preparation.cjs');
const { prepare } = require('../patches/omori/v1-compatibility.cjs');
const { createGameFiles } = require('../patches/omori/game-files.cjs');
const native = require(path.resolve(process.argv[2]));
const root = temporaryDirectory('omori-bedroom-'), gameRoot = path.join(root, 'game');
const key = 'a'.repeat(32), iv = Buffer.alloc(16, 17), assetKey = Buffer.alloc(16, 23);
const header = Buffer.from('5250474d560000000003010000000000', 'hex');
function aes(bytes) {
  const cipher = crypto.createCipheriv('aes-256-ctr', key, iv);
  return Buffer.concat([iv, cipher.update(bytes), cipher.final()]);
}
function decode(bytes) {
  const cipher = crypto.createDecipheriv('aes-256-ctr', key, bytes.subarray(0, 16));
  return Buffer.concat([cipher.update(bytes.subarray(16)), cipher.final()]);
}
function encryptedImage(bytes) {
  const body = Buffer.from(bytes); for (let i = 0; i < 16; i++) body[i] ^= assetKey[i];
  return Buffer.concat([header, body]);
}
function write(name, bytes) {
  const file = path.join(gameRoot, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes);
}
const room = bedroom(), pixels = new Uint8Array(512 * 512 * 4), expected = new Uint8Array(96 * 256 * 4);
for (let row = 0; row < 4; row++) for (let col = 0; col < 2; col++) {
  const sourceX = col ? 352 + row * 32 : 256 + row * 32, sourceY = col ? 288 : 224;
  const color = [row * 60, col * 200, 71, 255];
  for (let y = 0; y < 64; y++) for (let x = 0; x < 32; x++) {
    pixels.set(color, ((sourceY + y) * 512 + sourceX + x) * 4);
    expected.set(color, ((row * 64 + y) * 96 + col * 32 + x) * 4);
  }
}
const atlas = png(512, 512, pixels);
write('data/Map466.KEL', aes(Buffer.from(JSON.stringify(room.map))));
write('maps/map466.AUBREY', aes(Buffer.from(JSON.stringify(room.tiled))));
write('data/System.KEL', aes(Buffer.from(JSON.stringify({ encryptionKey: assetKey.toString('hex') }))));
write('img/tilesets/DW_NeighborsRoom.rpgmvp', encryptedImage(atlas));
write('js/main.js', 'let key = "' + key + '";');
write('index.html', '<script src="modloader/early_loader.js"></script>');
write('modloader/early_loader.js', '');
async function main() {
  native.initialize({ gameRoot, width: 32, height: 32, windowTitle: 'OMORI bedroom compatibility' });
  try {
    const roots = prepareGameFiles({ gamePreparation: 'patches/omori/oneloader.cjs',
      assetPreparation: { cacheRoot: path.join(root, 'cache') } }, native);
    assert.equal(roots.length, 1);
    assert.equal(native.runtime.omoriBackports.sleepingCharacters, true);
    const restored = JSON.parse(native.fs.readText('data/Map466.json'));
    assert.deepEqual(JSON.parse(native.runtime.omoriFiles.read('data/Map466.KEL')), restored);
    assert.equal(fs.existsSync(path.join(roots[0], 'data/Map466.KEL')), false);
    assert.equal(restored.events[82].pages.length, 3);
    const image = native.images.load('img/characters/$DW_SleepingChars.png', true), canvas = native.canvas.create(96, 256);
    try {
      native.canvas.drawImage(canvas.handle, image.handle, 0, 0, 96, 256, 0, 0, 96, 256, 1, false);
      assert.deepEqual(new Uint8Array(native.canvas.readPixels(canvas.handle, 0, 0, 96, 256)), expected);
    } finally { native.canvas.release(canvas.handle); native.images.release(image.handle); }
    const replacement = png(1, 1, Uint8Array.from([255, 0, 0, 255]));
    await native.runtime.oneLoader.publish([{ path: 'IMG/characters/$dw_sleepingchars.png', bytes: replacement }]);
    assert.deepEqual(Buffer.from(native.fs.readBytes('img/characters/$DW_SleepingChars.png')), replacement);
    assert.deepEqual(JSON.parse(native.fs.readText('data/Map466.json')), restored);
    await native.runtime.oneLoader.publish([]);
    assert.notDeepEqual(Buffer.from(native.fs.readBytes('img/characters/$DW_SleepingChars.png')), replacement);
    assert.equal(JSON.parse(decode(fs.readFileSync(path.join(gameRoot, 'data/Map466.KEL')))).events[78], null);
    const plain = { 'data/Map466.json': Buffer.from(JSON.stringify(room.map)), 'maps/map466.json': Buffer.from(JSON.stringify(room.tiled)),
      'img/tilesets/DW_NeighborsRoom.png': atlas };
    const plainNative = { ...native, runtime: {}, fs: { exists: name => Object.hasOwn(plain, name) } };
    const result = prepare({ native: plainNative, files: createGameFiles({ native: plainNative,
      createLayer: name => new GameFileLayer(path.join(root, 'plain-cache'), name), read: name => plain[name] }) });
    assert.equal(fs.existsSync(path.join(result.root, 'data/Map466.KEL')), false);
    assert.equal(fs.existsSync(path.join(result.root, 'img/characters/$DW_SleepingChars.rpgmvp')), false);
  } finally { native.runtime.quit(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
