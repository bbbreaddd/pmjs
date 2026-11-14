'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs'), path = require('node:path');
const { temporaryDirectory } = require('./helpers/temp.cjs');
const { png } = require('./helpers/png.cjs');
const { fixture } = require('./helpers/mv-session-fixture.cjs');
const { createScriptRuntime } = require('../runner/mv-script-runtime.cjs');
const native = require(path.resolve(process.argv[2]));

test('native scenes dispatch original methods and retain transferred sprite resources', async t => {
  const root = temporaryDirectory('native-scenes');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'img/system'), { recursive: true });
  fs.writeFileSync(path.join(root, 'img/system/Window.png'), png(192, 192, new Uint8Array(192 * 192 * 4).fill(255)));
  fs.copyFileSync(path.join(process.argv[3], 'testfont.ttf'), path.join(root, 'font.ttf'));
  native.initialize({ gameRoot: root, width: 32, height: 32, windowTitle: 'Native scenes' });
  t.after(() => native.runtime.quit());
  const engine = native.mvEngine, session = engine.create(fixture([]));
  t.after(() => engine.dispose(session));
  engine.attach(session, { width: 32, height: 32, fontFile: 'font.ttf' });
  const runtime = createScriptRuntime(engine, session, { native }); runtime.installScenes();
  const { scope } = runtime;
  runtime.runScript(`
    var trace = [];
    function First() { this.initialize.apply(this, arguments); }
    First.prototype = Object.create(Scene_Base.prototype); First.prototype.constructor = First;
    var originalInitialize = Scene_Base.prototype.initialize;
    First.prototype.initialize = function() { originalInitialize.call(this); this.custom = 42; };
    First.prototype.create = function() {
      trace.push('create');
      this.sprite = new Sprite(new Bitmap(4, 4)); this.sprite.bitmap.fillAll('#ff0000');
      this.addChild(this.sprite); this.sprite.position.set(2, 3);
    };
    First.prototype.start = function() { Scene_Base.prototype.start.call(this); trace.push('start'); };
    First.prototype.update = function() { Scene_Base.prototype.update.call(this); trace.push('update'); };
    First.prototype.stop = function() { Scene_Base.prototype.stop.call(this); this.startFadeOut(2); trace.push('stop'); };
    First.prototype.terminate = function() { trace.push('terminate'); };
    function Second() { this.initialize.apply(this, arguments); }
    Second.prototype = Object.create(Scene_Base.prototype); Second.prototype.constructor = Second;
    SceneManager.run(First);
  `);
  for (let i = 0; i < 100 && !scope.SceneManager.isCurrentSceneStarted(); ++i) { runtime.step(); await new Promise(resolve => setTimeout(resolve, 5)); }
  const first = scope.SceneManager._scene;
  assert.equal(first.custom, 42); assert.equal(first instanceof scope.First, true);
  assert.deepEqual(Array.from(scope.trace), ['create', 'start', 'update']);
  const sprite = first.sprite, bitmap = sprite.bitmap;
  assert.equal(first.children[0], sprite); assert.equal(sprite.parent, first);
  const commandWindow = new scope.Window_Command();
  commandWindow.addCommand('First', 'first', true, sprite);
  commandWindow.select(0);
  assert.equal(commandWindow.maxItems(), 1);
  assert.equal(commandWindow.currentSymbol(), 'first');
  assert.equal(commandWindow.currentExt(), sprite);
  commandWindow.maxCols = () => 2; commandWindow.itemWidth = () => 7;
  assert.deepEqual(commandWindow.itemRect(1), { x: 19, y: 0, width: 7, height: 36 });
  for (let i = 0; i < 100 && !commandWindow.windowskin.isReady(); ++i) { scope.ImageManager.update(); await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.equal(commandWindow.windowskin.isReady(), true);
  const draw = (x, y) => {
    native.beginFrame(); engine.present(session); native.renderFrame();
    return Array.from(native.canvas.captureSceneRawPremultiplied().subarray((y * 32 + x) * 4, (y * 32 + x + 1) * 4));
  };
  assert.deepEqual(draw(2, 3), [255, 0, 0, 255]);
  scope.SceneManager.goto(scope.Second);
  runtime.step(); assert.equal(scope.SceneManager._scene, first);
  runtime.step(); assert.equal(scope.SceneManager._scene, first);
  runtime.step(); const second = scope.SceneManager._scene;
  assert.ok(second instanceof scope.Second);
  assert.equal(scope.trace.filter(value => value === 'terminate').length, 1);
  second.addChild(sprite); assert.equal(first.children.includes(sprite), false); assert.equal(sprite.parent, second);
  scope.ImageManager.clear(); bitmap.fillAll('#00ff00');
  assert.deepEqual(draw(2, 3), [0, 255, 0, 255]);
  assert.throws(() => sprite.addChild(second), /cyclic/);
  const sentinel = new Error('scene exception');
  second.update = () => { throw sentinel; };
  assert.throws(() => runtime.step(), error => error === sentinel);
  second.update = () => { assert.throws(() => scope.SceneManager.update(), /already running/); };
  runtime.step();
  await t.test('script pre-title redirects reserve native map transfers and advance native events', async () => {
    const engine = native.mvEngine, database = fixture([]);
    database.maps[2] = structuredClone(database.maps[1]);
    const session = engine.create(database);
    try {
      engine.attach(session, { width: 32, height: 32, fontFile: 'font.ttf' });
      const runtime = createScriptRuntime(engine, session, { native }); runtime.installScenes();
      runtime.runScript(`
        function Intro() { this.initialize.apply(this, arguments); }
        Intro.prototype = Object.create(Scene_Map.prototype);
        Intro.prototype.constructor = Intro;
        Intro.prototype.initialize = function() {
          Scene_Map.prototype.initialize.call(this);
          DataManager.setupNewGame(); $gamePlayer.reserveTransfer(2, 0, 0);
        };
        var originalGoto = SceneManager.goto;
        SceneManager.goto = function(type) {
          if (type === Scene_Title && !this.introShown) {
            this.introShown = true; this._nextScene = new Intro();
          } else originalGoto.call(this, type);
        };
      `);
      runtime.start();
      for (let index = 0; index < 20 && !(runtime.scope.SceneManager._scene instanceof runtime.scope.Intro); ++index) {
        runtime.step({}); await new Promise(resolve => setImmediate(resolve));
      }
      assert.ok(runtime.scope.SceneManager._scene instanceof runtime.scope.Intro);
      assert.equal(engine.snapshot(session).mapId, 2);
      assert.equal(runtime.scope.$gamePlayer.isTransferring(), false);
      const tick = engine.snapshot(session).ticks;
      runtime.step({});
      assert.equal(engine.snapshot(session).ticks, tick + 1);
      runtime.scope.SceneManager.goto(runtime.scope.Scene_Title);
      runtime.step({});
      assert.equal(engine.snapshot(session).scene, 0);
    } finally { engine.dispose(session); }
  });
});
