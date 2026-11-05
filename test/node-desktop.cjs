'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const native = require(path.resolve(process.argv[2]));
const { createStorage, createGameFilesystem } = require('../runner/storage.cjs');
const { temporaryDirectory } = require('./helpers/temp.cjs');
const root = temporaryDirectory('native-desktop-');
const game = path.join(root, 'game');
fs.mkdirSync(game);
fs.writeFileSync(path.join(game, 'package.json'), '{"name":"desktop-test"}');
native.initialize({ gameRoot: game, width: 32, height: 24, windowTitle: 'Desktop contracts' });
native.runtime.setFullscreen(false);
native.storage = createStorage(path.join(root, 'save'));
createGameFilesystem(native.fs, path.join(root, 'overlay'));
native.runtime.now = () => 0;
const queue = [];
const context = vm.createContext({ console, Buffer, process, __pmjsBuiltinRequire: require, NativeHost: native,
  __pmjsGameInfo: { width: 32, height: 24 },
  PMJS: { config: {}, web: {}, compat: { hit() {} }, tasks: { enqueue(fn) { queue.push(fn); }, onStop() {} } } });
for (const name of ['runtime', 'filesystem', 'modules']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/pmjs-web', name + '.js'), 'utf8'), context);
}
const win = context.nw.Window.get();
win.setAlwaysOnTop(true); win.setAlwaysOnTop(false);
win.setMinimumSize(48, 48); win.setMaximumSize(240, 240); win.resizeTo(80, 80);
native.pollEvents(); context.__pmjsUpdateWindowState(native.runtime.windowState());
assert.equal(win.width, 80); assert.equal(context.outerHeight, 80);
assert.equal(context.innerWidth, 80); assert.equal(context.innerHeight, 80);
assert.equal(context.__pmjsGameInfo.width, 32); assert.equal(context.__pmjsGameInfo.height, 24);
context.nw.Screen.Init(); assert.ok(context.nw.Screen.screens.length > 0);
const clipboard = context.nw.Clipboard.get();
clipboard.set('PMJS é'); assert.equal(clipboard.get(), 'PMJS é'); clipboard.clear(); assert.equal(clipboard.get(), '');
native.beginFrame();
native.render.quad(0, 0, 32, 12, 1, 0, 0, 1);
native.render.quad(0, 12, 32, 12, 0, 0, 1, 1);
native.renderFrame();
const before = native.canvas.memory().liveCount;
const results = [];
win.capturePage(value => results.push(value), { format: 'png', datatype: 'buffer' });
win.capturePage(value => results.push(value), { format: 'jpeg', datatype: 'raw' });
win.capturePage(value => results.push(value), { format: 'png', datatype: 'datauri' });
assert.equal(results.length, 0);
context.__pmjsAfterPresent(); assert.equal(results.length, 0);
while (queue.length) queue.shift()();
assert.equal(results.length, 3);
assert.equal(native.canvas.memory().liveCount, before);
assert.deepEqual([...results[0].subarray(0, 8)], [137,80,78,71,13,10,26,10]);
assert.ok(results[2].startsWith('data:image/png;base64,'));
for (const bytes of [results[0], Buffer.from(results[1], 'base64'), Buffer.from(results[2].split(',')[1], 'base64')]) {
  const image = native.images.loadBytes(bytes, true);
  const decoded = native.canvas.create(image.width, image.height);
  try {
    assert.equal(image.width, 80); assert.equal(image.height, 80);
    native.canvas.drawImage(decoded.handle, image.handle, 0, 0, 80, 80, 0, 0, 80, 80, 1, false);
    const top = native.canvas.pixel(decoded.handle, 40, 20), bottom = native.canvas.pixel(decoded.handle, 40, 60);
    assert.ok((top >>> 24) > 230 && ((top >>> 8) & 255) < 25, 'capture top remains red');
    assert.ok(((bottom >>> 8) & 255) > 230 && (bottom >>> 24) < 25, 'capture bottom remains blue');
    const letterbox = native.canvas.pixel(decoded.handle, 40, 2);
    assert.ok((letterbox >>> 24) < 20 && ((letterbox >>> 16) & 255) < 20 && ((letterbox >>> 8) & 255) < 20,
      'capture includes black presentation letterboxing');
  } finally { native.canvas.release(decoded.handle); native.images.release(image.handle); }
}
assert.equal(native.canvas.memory().liveCount, before);
native.runtime.quit();
