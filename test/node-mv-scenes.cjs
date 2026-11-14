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
  fs.mkdirSync(path.join(root, 'img/tilesets'), { recursive: true });
  fs.writeFileSync(path.join(root, 'img/tilesets/B.png'), png(96, 48, new Uint8Array(96 * 48 * 4).fill(255)));
  fs.mkdirSync(path.join(root, 'img/sv_actors'), { recursive: true });
  const actorPixels = new Uint8Array(216 * 144 * 4);
  for (let i = 0; i < actorPixels.length; i += 4) { actorPixels[i] = 255; actorPixels[i + 3] = 255; }
  fs.writeFileSync(path.join(root, 'img/sv_actors/Actor.png'), png(216, 144, actorPixels));
  fs.writeFileSync(path.join(root, 'img/system/Shadow2.png'), png(48, 24, new Uint8Array(48 * 24 * 4)));
  native.initialize({ gameRoot: root, width: 32, height: 32, windowTitle: 'Native scenes' });
  t.after(() => native.runtime.quit());
  const engine = native.mvEngine, data = fixture([]);
  data.animations = [null, { id: 1, frames: [[]], timings: [] }];
  const session = engine.create(data);
  t.after(() => engine.dispose(session));
  engine.attach(session, { width: 32, height: 32, fontFile: 'font.ttf' });
  const runtime = createScriptRuntime(engine, session, { native }); runtime.installScenes();
  const { scope } = runtime;
  await t.test('described native classes preserve type boundaries and typed movement arguments', () => {
    const actor = new scope.Sprite_Actor(), base = new scope.Sprite_Battler();
    assert.ok(actor instanceof scope.Sprite_Battler);
    assert.equal(scope.Sprite_Actor.prototype.setActorHome.length, 1);
    assert.equal(scope.Sprite_Battler.prototype.startMove.length, 3);
    base.setHome(10, 20);
    assert.equal(base._homeX, 10); assert.equal(base._homeY, 20);
    assert.throws(() => base.setHome(99), /argument count/);
    assert.equal(base._homeX, 10, 'bad arguments must not partially change native state');
    base.startMove(12, 6, 3); base.updateMove();
    assert.equal(base._offsetX, 4); assert.equal(base._offsetY, 2);
    assert.equal(base._movementDuration, 2); assert.equal(base.isMoving(), true);
    actor.setActorHome(2); assert.equal(actor._homeX, 664); assert.equal(actor._homeY, 376);
    const baseHandle = engine.classBindings.create(session, 'Sprite_Battler');
    assert.throws(() => engine.classBindings.invoke(baseHandle, 'setActorHome', [0]), /method is not bound/);
    assert.throws(() => engine.classBindings.create(session, 'Unknown'), /class is not bound/);
  });

  await t.test('animation rate aliases control the native timeline', () => {
    const sprite = new scope.Sprite_Base();
    const setupRate = scope.Sprite_Animation.prototype.setupRate;
    let calls = 0;
    scope.Sprite_Animation.prototype.setupRate = function() { ++calls; setupRate.call(this); this._rate = 2; };
    try {
      sprite.startAnimation(data.animations[1], false, 0);
      assert.equal(calls, 1);
      sprite.update(); sprite.update(); assert.equal(sprite.isAnimationPlaying(), true);
      sprite.update(); assert.equal(sprite.isAnimationPlaying(), false);
    } finally { scope.Sprite_Animation.prototype.setupRate = setupRate; }
    sprite.startAnimation(data.animations[1], false, 0);
    for (let i = 0; i < 4; ++i) sprite.update();
    assert.equal(sprite.isAnimationPlaying(), true);
    sprite.update(); assert.equal(sprite.isAnimationPlaying(), false);
  });

  await t.test('battle window positioning dispatches overrides and clamps native coordinates', () => {
    assert.equal(scope.BattleManager.isInputting(), false);
    const scene = new scope.Scene_Battle();
    const status = scene._statusWindow = new scope.Window_Base(0, 0, 16, 20);
    scene._partyCommandWindow = new scope.Window_Base(0, 0, 50, 20);
    const originalInput = scope.BattleManager.isInputting;
    const originalPosition = scope.Scene_Battle.prototype.updateWindowPositions;
    let inputting = false, disabled = false, calls = 0;
    scope.BattleManager.isInputting = () => inputting;
    scope.Scene_Battle.prototype.updateWindowPositions = function() {
      ++calls;
      if (!disabled) originalPosition.call(this);
    };
    try {
      scene.updateWindowPositions(); assert.equal(status.x, 16);
      scene.updateWindowPositions(); assert.equal(status.x, 25);
      inputting = true;
      scene.updateWindowPositions(); assert.equal(status.x, 41);
      scene.updateWindowPositions(); assert.equal(status.x, 50);
      inputting = false;
      scene.updateWindowPositions(); assert.equal(status.x, 34);
      scene.updateWindowPositions(); assert.equal(status.x, 25);
      disabled = true; status.x = 7;
      scene.updateWindowPositions(); assert.equal(status.x, 7);
      assert.equal(calls, 7);
    } finally {
      scope.BattleManager.isInputting = originalInput;
      scope.Scene_Battle.prototype.updateWindowPositions = originalPosition;
    }
  });

  await t.test('item subwindows retain native state and dispatch plugin aliases', () => {
    runtime.runScript(`
      var itemScene = new Scene_Item(), skillScene = new Scene_Skill();
      var selectedIndex = 0, refreshCount = 0, activateCount = 0;
      itemScene._itemWindow = {
        index() { return selectedIndex; },
        refresh() { ++refreshCount; }, activate() { ++activateCount; }
      };
      var subWindow = new Window_Base(3, 0, 12, 20);
      subWindow.hide(); subWindow.deactivate();
      var originalSubWindow = Scene_ItemBase.prototype.showSubWindow;
      var customPosition = false, subCalls = [];
      Scene_ItemBase.prototype.showSubWindow = function(window) {
        var x = window.x;
        originalSubWindow.apply(this, arguments);
        subCalls.push([window.x, window.visible, window.active]);
        if (customPosition) window.x = x;
      };
      itemScene.showSubWindow(subWindow);
    `);
    assert.ok(scope.itemScene instanceof scope.Scene_MenuBase);
    assert.ok(scope.skillScene instanceof scope.Scene_ItemBase);
    assert.equal(scope.subWindow.x, 20);
    assert.equal(scope.subWindow.visible, true); assert.equal(scope.subWindow.active, true);
    runtime.runScript('selectedIndex = 1; itemScene.showSubWindow(subWindow);');
    assert.equal(scope.subWindow.x, 0);
    runtime.runScript('subWindow.x = 7; customPosition = true; itemScene.showSubWindow(subWindow);');
    assert.equal(scope.subWindow.x, 7);
    assert.equal(scope.subCalls.length, 3);
    assert.equal(scope.subCalls[2][0], 0, 'plugin must call original positioning before restoring its position');
    runtime.runScript('itemScene._actorWindow = subWindow; itemScene.onActorCancel();');
    assert.equal(scope.subWindow.visible, false); assert.equal(scope.subWindow.active, false);
    assert.equal(scope.refreshCount, 1); assert.equal(scope.activateCount, 1);
    runtime.runScript('Scene_ItemBase.prototype.showSubWindow = originalSubWindow;');
  });

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
  const layer = new scope.WindowLayer(), window = new scope.Window_Base(0, 0, 16, 16);
  layer.move(1, 2, 20, 21); assert.equal(layer.width, 20); assert.equal(layer.height, 21);
  layer.addChild(window); second.addChild(layer); second.removeChild(layer);
  assert.equal(layer.children.length, 0); assert.equal(window.parent, null);
  window.contents.fillAll('#0000ff'); assert.equal(window.contents.getPixel(0, 0), '#0000ff');
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
  await t.test('TouchInput shares native frame state and honors mouse-handler overrides', () => {
    const engine = native.mvEngine, session = engine.create(fixture([]));
    try {
      engine.attach(session, { width: 32, height: 32, fontFile: 'font.ttf' });
      const runtime = createScriptRuntime(engine, session, { native }); runtime.installScenes();
      engine.newGame(session);
      const touch = runtime.scope.TouchInput, geometry = native.render.presentation();
      const event = { button: 0, pageX: geometry.viewportX + geometry.viewportWidth / 2, pageY: geometry.viewportY + geometry.viewportHeight / 2 };
      touch.keyRepeatWait = 2;
      let leftCalls = 0;
      const left = touch._onLeftButtonDown;
      touch._onLeftButtonDown = function(event) { ++leftCalls; left.call(this, event); };
      touch._onMouseDown(event);
      runtime.step();
      assert.equal(leftCalls, 1);
      assert.equal(touch.isTriggered(), true);
      assert.equal(touch.isPressed(), true);
      assert.equal(touch.isLongPressed(), false, 'input must update only once per native frame');
      assert.equal(touch.x, 16); assert.equal(touch.y, 16);
      runtime.step();
      assert.equal(touch.isTriggered(), false);
      assert.equal(touch.isLongPressed(), true);
      touch._onMouseUp(event); runtime.step();
      assert.equal(touch.isReleased(), true); assert.equal(touch.isPressed(), false);
      touch._onWheel({ deltaX: 2, deltaY: 5 }); runtime.step();
      assert.equal(touch.wheelX, 2); assert.equal(touch.wheelY, 5);
      runtime.step(); assert.equal(touch.wheelY, 0);
      touch.clear();
      touch._onMouseDown = function() {};
      touch._onMouseDown(event); runtime.step();
      assert.equal(leftCalls, 1);
      assert.equal(touch.isTriggered(), false); assert.equal(touch.isPressed(), false);
    } finally { engine.dispose(session); }
  });

  await t.test('touch event callbacks and DOM references stay outside native event data', () => {
    const engine = native.mvEngine, session = engine.create(fixture([]));
    try {
      engine.attach(session, { width: 32, height: 32, fontFile: 'font.ttf' });
      const runtime = createScriptRuntime(engine, session, { native }); runtime.installScenes(); engine.newGame(session);
      const touch = runtime.scope.TouchInput, geometry = native.render.presentation();
      const point = Object.create({ pageX: geometry.viewportX + geometry.viewportWidth / 2, pageY: geometry.viewportY + geometry.viewportHeight / 2 });
      const event = Object.assign(Object.create(point), { type: 'mousemove' });
      Object.defineProperty(event, 'target', { enumerable: true, get() { throw new Error('DOM target must not be serialized'); } });
      let observed;
      const move = touch._onMouseMove;
      touch._onMouseMove = function(value) { observed = value; value.preventDefault(); move.call(this, value); };
      touch._onLeftButtonDown({ pageX: geometry.viewportX + geometry.viewportWidth / 4, pageY: geometry.viewportY + geometry.viewportHeight / 4 });
      session.__mvRuntime.touchEvent(event); runtime.step();
      assert.equal(observed, event); assert.equal(event.defaultPrevented, true);
      assert.equal(typeof event.stopPropagation, 'function');
      assert.equal(touch.x, 16); assert.equal(touch.y, 16);
      touch._onMouseUp({ button: 0 }); runtime.step();
      const list = { 0: point, length: 1 };
      touch._onTouchStart({ touches: list, changedTouches: list, preventDefault() {} }); runtime.step();
      assert.equal(touch.isTriggered(), true); assert.equal(touch.isPressed(), true);
      touch._onTouchEnd({ changedTouches: list, preventDefault() {} }); runtime.step();
      assert.equal(touch.isReleased(), true); assert.equal(touch.isPressed(), false);
    } finally { engine.dispose(session); }
  });

  await t.test('option windows change native configuration through overrideable methods', () => {
    engine.configure(session, { alwaysDash: false, bgmVolume: 100 });
    const window = new scope.Window_Options();
    window.select(window.findSymbol('alwaysDash')); window.processOk();
    assert.equal(engine.configuration(session).alwaysDash, true);
    window.select(window.findSymbol('bgmVolume')); window.processOk();
    assert.equal(engine.configuration(session).bgmVolume, 0);
    window.cursorRight(); assert.equal(engine.configuration(session).bgmVolume, 20);
    window.cursorLeft(); assert.equal(engine.configuration(session).bgmVolume, 0);
    window.cursorLeft(); assert.equal(engine.configuration(session).bgmVolume, 0);
    assert.equal(window.statusText(window.index()), '0%');
  });

  await t.test('plugin database metadata and notetag changes reach native actor initialization', () => {
    const { databaseFiles } = require('../runner/mv-engine-data.cjs');
    const { installDatabase } = require('../runner/native-database.cjs');
    const engine = native.mvEngine, data = fixture([]);
    data.actors[1].note = '<Flag><Style:blue>';
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    for (const file of databaseFiles) fs.writeFileSync(path.join(root, 'data', file.src), JSON.stringify(data[file.key] || []));
    fs.writeFileSync(path.join(root, 'data/Extra.json'), '{"layout":"custom"}');
    const session = engine.create(data);
    try {
      engine.attach(session, { width: 32, height: 32, fontFile: 'font.ttf' });
      const runtime = createScriptRuntime(engine, session, { native }); runtime.installScenes();
      installDatabase(runtime, engine, session, root);
      const manager = runtime.scope.DataManager;
      manager._databaseFiles.push({ name: '$dataExtra', src: 'Extra.json' });
      const onLoad = manager.onLoad;
      manager.onLoad = function(value) {
        onLoad.call(this, value);
        if (value === runtime.scope.$dataActors) value[1].name = 'Plugin Actor';
      };
      const isReady = manager.isDatabaseLoaded;
      manager.isDatabaseLoaded = function() {
        if (!isReady.call(this)) return false;
        runtime.scope.$dataClasses[1].params[0][1] = 77;
        return true;
      };
      runtime.database.load();
      const actor = runtime.scope.$dataActors[1];
      assert.equal(runtime.runScript('$dataActors[1].meta instanceof Object'), true);
      assert.equal(actor.meta.Flag, true); assert.equal(actor.meta.Style, 'blue');
      assert.equal(runtime.database.isReady(), true);
      assert.equal(runtime.scope.$dataActors[1], actor);
      assert.equal(engine.databaseInvoke(session, 'read', 'plugin:$dataExtra').layout, 'custom');
      engine.newGame(session);
      assert.equal(engine.save(session).actors._data[1]._name, 'Plugin Actor');
      assert.equal(engine.snapshot(session).actors[1].parameters[0], 77);
      assert.throws(() => manager.loadDataFile('$dataExtra', 'Extra.json'), /before game state initialization/);
    } finally { engine.dispose(session); }
  });

  await t.test('tile shadow overrides change native cached map geometry', async () => {
    const data = fixture([]);
    data.maps[1].data.fill(1, 0, 25); data.maps[1].data.fill(15, 100, 125);
    data.tilesets[1].tilesetNames = ['', '', '', '', '', 'B', '', '', ''];
    const shadowSession = engine.create(data);
    try {
      engine.attach(shadowSession, { width: 32, height: 32, fontFile: 'font.ttf' });
      const shadowRuntime = createScriptRuntime(engine, shadowSession, { native }); shadowRuntime.installScenes();
      engine.newGame(shadowSession);
      const capture = () => {
        native.beginFrame(); engine.present(shadowSession); native.renderFrame();
        return native.canvas.captureSceneRawPremultiplied()[(16 * 32 + 16) * 4];
      };
      let shaded = 0;
      for (let i = 0; i < 100; ++i) {
        shaded = capture(); if (shaded > 60) break;
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      assert.ok(shaded > 60 && shaded < 200, 'stock shadows must darken the white tile');
      shadowRuntime.runScript(`
        var originalShadow = ShaderTilemap.prototype._drawShadow;
        var shadowCalls = 0;
        ShaderTilemap.prototype._drawShadow = function() { ++shadowCalls; };
      `);
      shadowRuntime.step();
      assert.ok(capture() > 240, 'empty drawing override must remove native shadows');
      assert.ok(shadowRuntime.scope.shadowCalls > 0);
      shadowRuntime.runScript('ShaderTilemap.prototype._drawShadow = originalShadow;');
      shadowRuntime.step();
      assert.ok(capture() < 200, 'restoring the default must invalidate cached geometry');
    } finally { engine.dispose(shadowSession); }
  });


  await t.test('actor sprite home aliases affect native battle pixels and retain model state', () => {
    const data = fixture([]);
    data.system.optSideView = true; data.actors[1].battlerName = 'Actor';
    data.troops = [null, { members: [], pages: [] }];
    const actorSession = engine.create(data);
    let observed;
    try {
      engine.attach(actorSession, { width: 32, height: 32, fontFile: 'font.ttf' });
      const actorRuntime = createScriptRuntime(engine, actorSession, { native }); actorRuntime.installScenes();
      const Actor = actorRuntime.scope.Sprite_Actor, base = Actor.prototype.setActorHome;
      let calls = 0;
      Actor.prototype.setActorHome = function(index) {
        ++calls;
        assert.throws(() => engine.present(actorSession), /cannot present during a script callback/);
        base.call(this, index);
        assert.equal(this._homeX, 600 + 32 * index);
        this._homeX = 16; this._homeY = 24; observed = this;
      };
      engine.newGame(actorSession); engine.startBattle(actorSession, 1, true, true);
      const capture = () => {
        native.beginFrame(); engine.present(actorSession); native.renderFrame();
        return Array.from(native.canvas.captureSceneRawPremultiplied().subarray((12 * 32 + 16) * 4, (12 * 32 + 16) * 4 + 4));
      };
      assert.deepEqual(capture(), [255, 0, 0, 255]);
      assert.equal(calls, 1); assert.ok(observed instanceof actorRuntime.scope.Sprite_Battler);
      observed._homeX = -100;
      assert.deepEqual(capture(), [0, 0, 0, 255]);
      observed.startMove(116, 0, 0);
      assert.deepEqual(capture(), [255, 0, 0, 255]);
      assert.equal(calls, 1, 'rendering must preserve the same native model');
    } finally { engine.dispose(actorSession); }
    assert.equal(observed._homeX, -100);
    assert.equal(observed.isMoving(), false);
  });

});
