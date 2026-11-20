'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHostContext } = require('./helpers/mz-host-context.cjs');
const { runModule } = require('./helpers/runtime-context.cjs');
const native = require(path.resolve(process.argv[2]));
native.initialize({ gameRoot: path.resolve(process.argv[3]), width: 32, height: 24, windowTitle: 'Sprite draw culling' });
try {
  const c = createHostContext(native, { graphics: false });
  for (const file of ['optimizations', 'compatibility']) runModule(c, 'js/pmjs-core/' + file + '.js');
  vm.runInContext(fs.readFileSync(process.argv[4], 'utf8'), c, { filename: 'pixi.js' });
  c.Tilemap = class Tilemap {};
  c.nativeBootPhase = () => {}; c.NativeHost.runtime.loadScript = () => {};
  const setup = fs.readFileSync(require.resolve('../js/pmjs-pixi4/setup.js'), 'utf8');
  vm.runInContext(setup.slice(0, setup.indexOf("NativeHost.runtime.loadScript('js/libs/pixi-picture.js')")), c);
  for (const file of ['render-preflight', 'scene-primitives', 'scene-filters', 'scene-packet',
    'scene-prepare', 'scene-classify', 'scene-encoders', 'scene-effects', 'renderer-managers', 'renderer-facade'])
    runModule(c, 'js/pmjs-pixi4/' + file + '.js');
  c.pmjsPixiRenderPreflight.scan();
  const renderer = c.createNativePixiRenderer({ width: 32, height: 24, transparent: true });
  c.PIXI.utils.EventEmitter.call(renderer);
  for (const method of ['on', 'once', 'off', 'emit', 'listeners', 'removeListener']) {
    renderer[method] = c.PIXI.utils.EventEmitter.prototype[method];
  }
  let enabled = true;
  let firstSpriteFlags;
  const submit = c.NativeHost.scene.submit;
  c.NativeHost.scene = { ...c.NativeHost.scene, submit(...args) {
    for (let i = 0; i < args[3]; i++) {
      if (args[1][i * 7] === 1) { firstSpriteFlags = args[1][i * 7 + 5]; break; }
    }
    return submit.apply(this, args);
  } };
  const isEnabled = c.PMJS.optimizations.isEnabled;
  c.PMJS.optimizations.isEnabled = id => id === 'scene.duplicate-sprites' ? enabled : isEnabled(id);
  const canvas = c.document.createElement('canvas'); canvas.width = 2; canvas.height = 2;
  const context = canvas.getContext('2d');
  function paint(alpha = 1) {
    context.clearRect(0, 0, 2, 2);
    context.fillStyle = 'rgba(255, 0, 0, ' + alpha + ')'; context.fillRect(0, 0, 1, 2);
  }
  paint();
  const texture = c.PIXI.Texture.fromCanvas(canvas, c.PIXI.SCALE_MODES.NEAREST);
  texture.baseTexture.scaleMode = c.PIXI.SCALE_MODES.NEAREST;
  function scene() {
    const stage = new c.PIXI.Container();
    for (let i = 0; i < 8; i++) {
      const sprite = new c.PIXI.Sprite(texture);
      sprite.scale.set(4, 4); stage.addChild(sprite);
    }
    return stage;
  }
  function frame(stage, active) {
    enabled = active;
    native.beginFrame();
    const before = native.render.stats().duplicateSpriteDrawsSkipped;
    renderer.render(stage);
    native.renderFrame();
    const skipped = native.render.stats().duplicateSpriteDrawsSkipped - before;
    const capture = native.canvas.captureScene();
    try { return { skipped, pixels: Buffer.from(native.canvas.readPixels(capture.handle, 0, 0, 32, 24)) }; }
    finally { native.canvas.release(capture.handle); }
  }
  const stage = scene(), children = stage.children.slice(), events = [];
  children.forEach(sprite => {
    sprite.on('added', () => events.push('added'));
    sprite.on('removed', () => events.push('removed'));
  });
  renderer.on('prerender', () => assert.deepEqual(stage.children, children));
  const control = frame(stage, false), candidate = frame(stage, true);
  assert.deepEqual(candidate.pixels, control.pixels);
  assert.equal(candidate.skipped, 7, 'sprite flags: ' + firstSpriteFlags);
  assert.deepEqual(stage.children, children);
  assert.ok(children.every(sprite => sprite.parent === stage));
  assert.deepEqual(events, []);
  const checkChildren = renderer.listeners('prerender').at(-1);
  renderer.off('prerender', checkChildren);
  function lateChange(active) {
    paint();
    renderer.once('prerender', () => paint(0.5));
    return frame(stage, active);
  }
  const changedControl = lateChange(false), changedCandidate = lateChange(true);
  assert.deepEqual(changedCandidate.pixels, changedControl.pixels);
  assert.equal(changedCandidate.skipped, 0);
  paint();
  stage.removeChildren();
  assert.equal(stage.children.length, 0);
  frame(stage, true);
  assert.equal(stage.children.length, 0);
  assert.ok(children.every(sprite => sprite.parent === null));
  const destroyed = scene(), retained = destroyed.children.slice();
  frame(destroyed, true);
  destroyed.destroy({ children: true });
  assert.ok(retained.every(sprite => sprite.transform === null));
  const other = scene();
  assert.equal(frame(other, true).skipped, 7);
  assert.deepEqual(events, Array(8).fill('removed'));
  console.log(JSON.stringify({ ok: true, pixi: c.PIXI.VERSION, skippedDraws: candidate.skipped }));
} finally { native.runtime.quit(); }
