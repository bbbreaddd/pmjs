'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { temporaryDirectory } = require('./helpers/temp.cjs');
const { png } = require('./helpers/png.cjs');
const { createBitmapClass, createImageManager } = require('../runner/native-bitmap.cjs');
const { createScriptRuntime } = require('../runner/mv-script-runtime.cjs');
const { fixture, command } = require('./helpers/mv-session-fixture.cjs');
const native = require(path.resolve(process.argv[2]));

test('native image cache preserves identity, reservations, requests and retained bitmap ownership', async t => {
  const root = temporaryDirectory('mv-image-manager-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'img/pictures'), { recursive: true });
  const pixels = new Uint8Array(8 * 8 * 4);
  for (let i = 0; i < pixels.length; i += 4) pixels.set([255, 0, 0, 255], i);
  for (const name of ['Sheet', 'Other']) fs.writeFileSync(path.join(root, 'img/pictures', name + '.png'), png(8, 8, pixels));
  fs.copyFileSync(path.join(process.argv[3], 'testfont.ttf'), path.join(root, 'font.ttf'));
  fs.mkdirSync(path.join(root, 'img/system'), { recursive: true });
  fs.writeFileSync(path.join(root, 'img/system/Window.png'), png(192, 192, new Uint8Array(192 * 192 * 4).fill(255)));
  native.initialize({ gameRoot: root, width: 32, height: 32, windowTitle: 'Native image cache' });
  t.after(() => native.runtime.quit());
  const Bitmap = createBitmapClass(native), manager = createImageManager(native, Bitmap);
  async function ready(bitmap) {
    for (let i = 0; i < 100 && !bitmap.isReady(); i++) { manager.update(); await new Promise(resolve => setTimeout(resolve, 10)); }
    assert.equal(bitmap.isReady(), true);
  }
  const sheet = manager.reservePicture('Sheet', 0, 'event');
  await ready(sheet);
  assert.equal(manager.loadPicture('Sheet'), sheet);
  assert.equal(sheet.getPixel(0, 0), '#ff0000');
  sheet.extension = { retained: true };
  manager.setCacheLimit(1);
  const other = manager.reservePicture('Other', 0, 'other');
  await ready(other);
  assert.equal(manager.loadPicture('Sheet'), sheet);
  await new Promise(resolve => setTimeout(resolve, 10));
  manager.loadPicture('Other');
  manager.releaseReservation('event'); manager.update();
  const replacement = manager.loadPicture('Sheet');
  assert.notEqual(replacement, sheet);
  await ready(replacement);
  assert.equal(sheet.extension.retained, true);
  assert.equal(sheet.getPixel(0, 0), '#ff0000');
  manager.clear();
  const destination = new Bitmap(8, 8); destination.blt(sheet, 0, 0, 8, 8, 0, 0);
  assert.equal(destination.getPixel(0, 0), '#ff0000');
  manager.setCacheLimit(1000);
  const requested = manager.requestPicture('Sheet');
  assert.equal(manager.isReady(), true);
  assert.equal(manager.loadPicture('Sheet'), requested);
  let notified = 0; requested.addLoadListener(() => notified++);
  await ready(requested); assert.equal(notified, 1);
  requested.initialize(3, 2);
  assert.equal(manager.loadPicture('Sheet'), requested);
  assert.deepEqual([requested.width, requested.height], [3, 2]);
  assert.equal(manager.isBigCharacter('!$Actor'), true);
  assert.equal(manager.isObjectCharacter('$!Actor'), true);
  assert.equal(manager.loadEmptyBitmap().width, 1);
  manager.clear();
  const engine = native.mvEngine, session = engine.create(fixture([
    command(231, [1, 'Sheet', 0, 0, 0, 0, 100, 100, 255, 0]), command(230, [20]), command(235, [1]), command(230, [20])
  ]));
  t.after(() => engine.dispose(session));
  const { scope } = createScriptRuntime(engine, session, { native });
  engine.newGame(session); engine.attach(session, { fontFile: 'font.ttf' }); engine.step(session, {});
  const owned = scope.ImageManager.loadPicture('Sheet');
  for (let i = 0; i < 100 && !owned.isReady(); i++) { scope.ImageManager.update(); await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.equal(owned.isReady(), true);
  const sprite = scope.SceneManager._scene._spriteset._pictureContainer.children[1];
  assert.equal(sprite.bitmap, owned);
  assert.equal(sprite._frame.width, 8);
  owned.fillAll('#00ff00');
  const draw = () => {
    native.beginFrame(); engine.present(session); native.renderFrame();
    return Array.from(native.canvas.captureSceneRawPremultiplied().subarray(0, 4));
  };
  assert.deepEqual(draw(), [0, 255, 0, 255]);
  scope.ImageManager.clear();
  assert.notEqual(scope.ImageManager.loadPicture('Sheet'), owned);
  assert.deepEqual(draw(), [0, 255, 0, 255]);
  for (let i = 0; i < 21; i++) engine.step(session, {});
  assert.equal(sprite.bitmap, null);
  assert.equal(owned.getPixel(0, 0), '#00ff00');
});
