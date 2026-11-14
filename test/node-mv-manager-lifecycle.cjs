'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const native = require(path.resolve(process.argv[2]));
const { temporaryDirectory } = require('./helpers/temp.cjs');
const { fixture } = require('./helpers/mv-session-fixture.cjs');
const { createScriptRuntime } = require('../runner/mv-script-runtime.cjs');

test('scene manager dispatches lifecycle hooks, snapshots backgrounds and exits an empty stack', t => {
  const root = temporaryDirectory('manager-lifecycle-');
  const fs = require('node:fs');
  fs.mkdirSync(path.join(root, 'img/system'), { recursive: true });
  fs.writeFileSync(path.join(root, 'img/system/Window.png'), require('./helpers/png.cjs').png(192, 192, new Uint8Array(192 * 192 * 4).fill(255)));
  fs.copyFileSync(path.join(process.argv[3], 'testfont.ttf'), path.join(root, 'font.ttf'));
  native.initialize({ gameRoot: root, width: 32, height: 32, windowTitle: 'Manager lifecycle' });
  t.after(() => native.runtime.quit());
  const engine = native.mvEngine, session = engine.create(fixture([]));
  t.after(() => engine.dispose(session));
  engine.attach(session, { width: 32, height: 32, fontFile: 'font.ttf' });
  const runtime = createScriptRuntime(engine, session, { native }); runtime.installScenes();
  const { scope } = runtime, trace = [];
  const volume = Object.getOwnPropertyDescriptor(scope.AudioManager, 'bgmVolume');
  let assignments = 0;
  Object.defineProperty(scope.AudioManager, 'bgmVolume', { ...volume, set(value) { ++assignments; volume.set.call(this, value); } });
  scope.ConfigManager.bgmVolume = 125.5; scope.ConfigManager.alwaysDash = true;
  assert.equal(assignments, 1); assert.equal(scope.AudioManager.bgmVolume, 125.5);
  Object.defineProperty(scope.AudioManager, 'bgmVolume', volume); scope.ConfigManager.bgmVolume = 100;
  scope.record = method => trace.push(method);
  runtime.runScript(`
    var ready = false;
    function CustomScene() { this.initialize.apply(this, arguments); }
    CustomScene.prototype = Object.create(Scene_Base.prototype);
    CustomScene.prototype.constructor = CustomScene;
    CustomScene.prototype.create = function() { Scene_Base.prototype.create.call(this); record('create'); };
    CustomScene.prototype.isReady = function() { return ready; };
    CustomScene.prototype.start = function() { Scene_Base.prototype.start.call(this); record('start'); };
    CustomScene.prototype.update = function() { record('update'); };
    for (var hook of ['updateManagers', 'updateInputData', 'onSceneCreate', 'onSceneLoading', 'onSceneStart']) {
      (function(name, original) { SceneManager[name] = function() { record(name); return original.call(this); }; })(hook, SceneManager[hook]);
    }
    SceneManager._screenWidth = 40; SceneManager._screenHeight = 24;
    SceneManager._boxWidth = 38; SceneManager._boxHeight = 22;
    SceneManager.run(CustomScene);
  `);
  assert.equal(scope.Graphics.width, 40); assert.equal(scope.Graphics.height, 24);
  assert.equal(scope.Graphics.boxWidth, 38); assert.equal(scope.Graphics.boxHeight, 22);
  runtime.step({});
  assert.deepEqual(trace, ['updateManagers', 'updateInputData', 'create', 'onSceneCreate', 'onSceneLoading']);
  trace.length = 0; scope.ready = true; runtime.step({});
  assert.deepEqual(trace, ['updateManagers', 'updateInputData', 'start', 'onSceneStart', 'update']);
  const request = scope.SceneManager.requestUpdate;
  scope.SceneManager.requestUpdate = function() {};
  trace.length = 0; runtime.step({}); assert.ok(trace.includes('update'));
  trace.length = 0; runtime.step({}); assert.deepEqual(trace, []);
  scope.SceneManager.requestUpdate = request; scope.SceneManager.requestUpdate();
  scope.SceneManager.snapForBackground();
  assert.equal(scope.SceneManager.backgroundBitmap().width, 40);
  trace.length = 0; scope.SceneManager.stop(); runtime.step({}); assert.deepEqual(trace, []);
  scope.SceneManager.resume(); scope.SceneManager.pop();
  let running = true;
  for (let frame = 0; frame < 5 && running; ++frame) running = runtime.step({});
  assert.equal(scope.SceneManager._exiting, true); assert.equal(running, false);
});
