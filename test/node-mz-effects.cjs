'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { createMzContext, runModule } = require('./helpers/mz-context.cjs');
require('./effect-fixtures.cjs').writeEffectFixtures(path.resolve(process.argv[3]));
const native = require(path.resolve(process.argv[2]));
native.initialize({ gameRoot: path.resolve(process.argv[3]), width: 64, height: 64,
  windowTitle: 'MZ effect bridge contract' });

async function verify() {
  const f = createMzContext({ strictCompatibility: false });
  const { context } = f;
  context.NativeHost.effects = native.effects;
  Object.assign(context.NativeHost.scene.schema, native.scene.schema);
  const submit = context.NativeHost.scene.submit;
  context.NativeHost.scene.submit = (...args) => {
    const result = native.scene.submit(...args);
    submit(...args);
    return result;
  };
  context.NativeHost.render = native.render;
  runModule(context, 'js/pmjs-mz/effects.js');
  const projection = [1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1, -64, 0, 0, 0, 1];
  const camera = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -10, 1];
  // An independent producer exercises the engine's draw/reset sequence.
  context.Sprite_Animation.prototype._render = function(renderer) {
    renderer.batch.flush();
    renderer.gl.viewport(-2016, -2016, 4096, 4096);
    const fx = context.Graphics.effekseer;
    fx.setProjectionMatrix(projection);
    fx.setCameraMatrix(camera);
    fx.beginDraw(); fx.drawHandle(this._handle); fx.endDraw();
    renderer.gl.viewport(0, 0, renderer.view.width, renderer.view.height);
    renderer.texture.reset(); renderer.state.reset();
  };
  runModule(context, 'js/pmjs-mz/animations.js');
  context.PMJS.methods.install();
  assert.throws(() => context.EffectManager.load('particle'), /loading is unavailable/);
  const fx = context.effekseer.createContext();
  assert.equal(fx.init(), true);
  assert.throws(() => fx.init(), /already initialized/);
  context.Graphics.effekseer = fx;
  const cache = {};
  let ready = 0;
  cache.square = fx.loadEffect('effects%2FSquare.efkefc', 1, () => {
    assert.equal(cache.square.isLoaded, true, 'readiness must follow cache publication');
    ready++;
  });
  assert.equal(cache.square.isLoaded, false);
  assert.throws(() => fx.play(cache.square), /not loaded/);
  await Promise.resolve();
  assert.equal(ready, 1);
  const cancelled = fx.loadEffect('effects/Square.efkefc', 1, () => { ready++; });
  fx.releaseEffect(cancelled);
  await Promise.resolve();
  assert.equal(cancelled.isLoaded, false);
  assert.equal(ready, 1, 'explicit release must cancel pending readiness');
  let failure;
  const missing = fx.loadEffect('effects/Missing.efkefc', 1,
    () => { throw Error('missing effect became ready'); },
    (message, url) => { failure = { message, url }; });
  assert.equal(failure, undefined);
  await Promise.resolve();
  assert.match(failure.message, /cannot load/);
  assert.equal(failure.url, 'effects/Missing.efkefc');
  assert.equal(missing.isLoaded, false);
  for (const name of ['SpatialSound', 'SpatialStereo']) {
    let spatialReady = false;
    const spatial = fx.loadEffect('effects/' + name + '.efkefc', 1, () => { spatialReady = true; });
    assert.equal(spatial.isLoaded, false);
    assert.throws(() => fx.play(spatial), /not loaded/);
    await Promise.resolve();
    assert.equal(spatialReady, true);
    const soundHandle = fx.play(spatial, -3, 0, 4);
    fx.update(2);
    assert.equal(native.effects.counts().voices, 1);
    soundHandle.setPaused(true);
    fx.releaseEffect(spatial);
    fx.update(2);
    assert.equal(native.effects.counts().voices, 1);
    soundHandle.setPaused(false);
    soundHandle.stop();
    fx.update(2);
    assert.equal(native.effects.counts().voices, 0);
  }
  const foreign = context.effekseer.createContext();
  foreign.init();
  assert.throws(() => foreign.play(cache.square), /not loaded/);
  assert.throws(() => foreign.releaseEffect(cache.square), /another context/);
  context.effekseer.releaseContext(foreign);
  assert.throws(() => fx.setProjectionMatrix([1]), /invalid Effekseer matrix/);
  assert.throws(() => fx.beginDraw(), /outside scene encoding/);
  const animation = new context.Sprite_Animation();
  animation._handle = fx.play(cache.square);
  animation._handle.setRandomSeed(1);
  const controlled = animation._handle;
  assert.equal(controlled.getDynamicInput(0), 0);
  controlled.setDynamicInput(0, 6);
  controlled.setDynamicInput(3, -2.5);
  assert.equal(controlled.getDynamicInput(0), 6);
  assert.equal(controlled.getDynamicInput(3), -2.5);
  assert.throws(() => controlled.getDynamicInput(4), /invalid effect dynamic input index/);
  assert.throws(() => controlled.setDynamicInput(0.5, 0), /invalid effect input index/);
  assert.throws(() => controlled.sendTrigger(-1), /invalid effect input index/);
  assert.throws(() => controlled.setFrame(-1), /invalid effect frame/);
  assert.throws(() => controlled.setAllColor(255, 255, 255, 256), /invalid effect color/);
  fx.update();
  const stage = new context.PIXI.Container();
  const canvas = native.canvas.create(2, 2);
  native.canvas.writePixels(canvas.handle, 0, 0, 2, 2, new Uint8Array([
    0, 255, 0, 255, 0, 255, 0, 255, 0, 255, 0, 255, 0, 255, 0, 255,
  ]));
  stage.addChild(f.sprite(canvas.handle, 2, 2, 2, 2));
  stage.addChild(animation);
  stage.addChild(f.sprite(canvas.handle, 60, 60, 2, 2));
  const renderer = { view: { width: 64, height: 64 } };
  function capture() {
    native.beginFrame();
    f.render(stage, 64, 64, renderer);
    native.renderScene();
    return Array.from(native.canvas.captureSceneRawPremultiplied());
  }
  const initial = capture();
  const packet = f.submissions.at(-1);
  assert.deepEqual(Array.from({ length: packet.count }, (_, i) => packet.metadata[i * 7]), [0, 1, 9, 1]);
  assert.deepEqual(Array.from(packet.values.slice(2 * 41 + 39, 2 * 41 + 41)), [64, 64]);
  const pixel = (pixels, x, y) => pixels.slice((y * 64 + x) * 4, (y * 64 + x) * 4 + 4);
  assert.deepEqual(pixel(initial, 2, 2), [0, 255, 0, 255]);
  assert.deepEqual(pixel(initial, 60, 60), [0, 255, 0, 255], 'drawing after particles must restore GL state');
  assert.ok(initial.some((value, i) => i % 4 === 0 && value > 200));
  fx.releaseEffect(cache.square);
  assert.equal(controlled.getDynamicInput(3), -2.5, 'live handle inputs survive cache release');
  assert.deepEqual(capture(), initial, 'cache eviction must retain a drawable live animation');
  assert.throws(() => fx.play(cache.square), /not loaded/);
  animation._handle.setLocation(2, 0, 0);
  fx.update();
  assert.notDeepEqual(capture(), initial);
  // Switch the real service to strict validation for the unsupported producer check.
  context.NativeHost.runtime.env = name => name === 'PMJS_STRICT_COMPAT' ? '1' : undefined;
  runModule(context, 'js/pmjs-core/compatibility.js');
  const count = f.submissions.length;
  animation._render = function() {};
  assert.throws(() => capture(), /render.render-method/);
  assert.equal(f.submissions.length, count, 'unreviewed drawing must reject before submission');
  delete animation._render;
  animation._handle.stop();
  fx.update();
  assert.equal(animation._handle.exists, false);
  assert.ok(!capture().some((value, i) => i % 4 === 0 && value > 200));
  native.canvas.release(canvas.handle);
  context.effekseer.releaseContext(fx);
  assert.throws(() => animation._handle.setSpeed(1), /not initialized/);
  assert.throws(() => controlled.getDynamicInput(0), /not initialized/);
  assert.throws(() => controlled.sendTrigger(0), /not initialized/);
  assert.throws(() => controlled.setFrame(1), /not initialized/);
  assert.deepEqual(native.effects.counts(), { contexts: 0, effects: 0, handles: 0, voices: 0 });
  console.log('native MZ effect readiness, producer ordering and ownership passed');
}

verify().catch(error => { console.error(error); process.exitCode = 1; })
  .finally(() => native.runtime.quit());
