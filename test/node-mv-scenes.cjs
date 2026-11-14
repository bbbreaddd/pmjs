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
  fs.writeFileSync(path.join(root, 'img/system/GameOver.png'), png(32, 32, new Uint8Array(32 * 32 * 4).fill(255)));
  fs.writeFileSync(path.join(root, 'img/system/Window.png'), png(192, 192, new Uint8Array(192 * 192 * 4).fill(255)));
  fs.copyFileSync(path.join(process.argv[3], 'testfont.ttf'), path.join(root, 'font.ttf'));
  fs.mkdirSync(path.join(root, 'img/tilesets'), { recursive: true });
  fs.writeFileSync(path.join(root, 'img/tilesets/B.png'), png(96, 48, new Uint8Array(96 * 48 * 4).fill(255)));
  fs.mkdirSync(path.join(root, 'img/sv_actors'), { recursive: true });
  const actorPixels = new Uint8Array(216 * 144 * 4);
  for (let i = 0; i < actorPixels.length; i += 4) { actorPixels[i] = 255; actorPixels[i + 3] = 255; }
  fs.writeFileSync(path.join(root, 'img/sv_actors/Actor.png'), png(216, 144, actorPixels));
  fs.writeFileSync(path.join(root, 'img/system/Shadow2.png'), png(48, 24, new Uint8Array(48 * 24 * 4)));
  for (const directory of ['enemies', 'sv_enemies']) {
    fs.mkdirSync(path.join(root, 'img', directory), { recursive: true });
    const pixels = new Uint8Array(24 * 24 * 4);
    for (let i = 0; i < pixels.length; i += 4) { pixels[i] = 255; pixels[i + 3] = 255; }
    fs.writeFileSync(path.join(root, 'img', directory, 'Enemy.png'), png(24, 24, pixels));
  }
  const balloonPixels = new Uint8Array(256 * 48 * 4);
  for (let y = 0; y < 48; ++y) for (let x = 0; x < 256; ++x) {
    const offset = (y * 256 + x) * 4;
    balloonPixels[offset + (y < 24 ? 0 : 1)] = 255; balloonPixels[offset + 3] = 255;
  }
  fs.writeFileSync(path.join(root, 'img/system/Reactions.png'), png(256, 48, balloonPixels));
  fs.writeFileSync(path.join(root, 'img/system/Balloon.png'), png(256, 48, balloonPixels));
  fs.mkdirSync(path.join(root, 'img/parallaxes'), { recursive: true });
  fs.writeFileSync(path.join(root, 'img/parallaxes/Background.png'), png(1, 1, [0, 0, 0, 255]));
  const audioFrames = 96000, wave = Buffer.alloc(44 + audioFrames * 4);
  wave.write('RIFF'); wave.writeUInt32LE(wave.length - 8, 4); wave.write('WAVEfmt ', 8);
  wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(2, 22);
  wave.writeUInt32LE(48000, 24); wave.writeUInt32LE(192000, 28);
  wave.writeUInt16LE(4, 32); wave.writeUInt16LE(16, 34);
  wave.write('data', 36); wave.writeUInt32LE(wave.length - 44, 40);
  fs.mkdirSync(path.join(root, 'audio/bgm'), { recursive: true });
  fs.writeFileSync(path.join(root, 'audio/bgm/Tone.ogg'), wave);
  native.initialize({ gameRoot: root, width: 32, height: 32, windowTitle: 'Native scenes' });
  t.after(() => native.runtime.quit());
  const engine = native.mvEngine, data = fixture([]);
  data.animations = [null, { id: 1, frames: [[]], timings: [] }];
  const session = engine.create(data);
  t.after(() => engine.dispose(session));
  engine.attach(session, { width: 32, height: 32, fontFile: 'font.ttf' });
  const runtime = createScriptRuntime(engine, session, { native }); runtime.installScenes();
  const { scope } = runtime;
  await t.test('window escape drawing uses native icon pixels and saved plugin aliases', () => {
    const previousSystem = scope.$dataSystem; scope.$dataSystem = data.system;
    const bitmap = new scope.Bitmap(512, 32); bitmap.fillRect(32, 0, 32, 32, '#00ff00');
    const load = scope.ImageManager.loadSystem, original = scope.Window_Base.prototype.drawIcon;
    let calls = 0;
    scope.ImageManager.loadSystem = function(name, ...args) { return name === 'IconSet' ? bitmap : load.call(this, name, ...args); };
    scope.Window_Base.prototype.drawIcon = function(...args) { ++calls; return original.apply(this, args); };
    try {
      const window = new scope.Window_Base(0, 0, 100, 100);
      assert.equal(window.drawTextEx('\\I[1]', 0, 0), 36);
      assert.equal(calls, 1); assert.equal(window.contents.getPixel(16, 16), '#00ff00');
      assert.equal(window.calcTextHeight({ index: 0, text: '\x1b{A\x1b}' }, false), 48);
      assert.equal(window.contents.fontSize, 28);
      scope.$gameVariables.setValue(5, 'Name');
      assert.equal(window.convertEscapeCharacters('\\V[5]'), 'Name');
    } finally { scope.ImageManager.loadSystem = load; scope.Window_Base.prototype.drawIcon = original; if (previousSystem === undefined) delete scope.$dataSystem; else scope.$dataSystem = previousSystem; }
  });
  await t.test('mutable children preserve array identity and change native ordering and snapshots', () => {
    const stage = new scope.Stage(), red = new scope.Sprite(new scope.Bitmap(32, 32)), green = new scope.Sprite(new scope.Bitmap(32, 32));
    red.bitmap.fillAll('red'); green.bitmap.fillAll('#00ff00');
    const children = stage.children;
    assert.equal(children, stage.children); assert.equal(stage.interactive, false);
    children.push(red); stage.addChild(green); assert.equal(children.length, 2);
    const capture = () => {
      native.beginFrame(); scope.Graphics.render(stage); engine.present(session); native.renderFrame();
      return Array.from(native.canvas.captureSceneRawPremultiplied().subarray(0, 4));
    };
    try {
      assert.deepEqual(capture(), [0, 255, 0, 255]);
      assert.equal(children.reverse(), children); assert.deepEqual(capture(), [255, 0, 0, 255]);
      children.sort((left, right) => left === green ? 1 : -1); assert.deepEqual(capture(), [0, 255, 0, 255]);
      const snapshot = scope.Bitmap.snap(stage);
      assert.equal(snapshot.getPixel(0, 0), '#00ff00');
      children.splice(1, 1); assert.equal(green.parent, null); assert.deepEqual(capture(), [255, 0, 0, 255]);
      children.length = 0; assert.equal(red.parent, null); assert.equal(stage.children, children);
      assert.deepEqual(capture(), [0, 0, 0, 255]);
    } finally { engine.scriptStage(session, null); }
  });
  await t.test('color matrix filters and ToneSprite fields control native compositing', () => {
    const previousPixi = scope.PIXI;
    class ColorMatrixFilter {
      constructor() { this.matrix = [0,1,0,0,0, 1,0,0,0,0, 0,0,1,0,0, 0,0,0,1,0]; this.alpha = 1; }
    }
    scope.PIXI = { filters: { ColorMatrixFilter } };
    const stage = new scope.Container(), background = new scope.ScreenSprite();
    background.setColor(40, 80, 120); background.opacity = 255; stage.addChild(background);
    const filter = new ColorMatrixFilter(); stage.filters = [filter];
    const capture = () => {
      native.beginFrame(); scope.Graphics.render(stage); engine.present(session); native.renderFrame();
      return Array.from(native.canvas.captureSceneRawPremultiplied().subarray(0, 4));
    };
    try {
      assert.deepEqual(capture(), [80,40,120,255]);
      filter.alpha = 0; assert.deepEqual(capture(), [40,80,120,255]);
      stage.filters = null; background.setBlack();
      const tone = new scope.ToneSprite(); tone.setTone(255, 0, 0, 0); stage.addChild(tone);
      assert.deepEqual(capture(), [255,0,0,255]);
      tone._red = 0; assert.deepEqual(capture(), [0,0,0,255]);
      stage.removeChild(tone);
      const layer = new scope.WindowLayer(), window = new scope.Window();
      layer.move(0, 0, 32, 32); window.move(0, 0, 32, 32);
      window.windowskin = new scope.Bitmap(192, 192); window.windowskin.fillAll('white');
      layer.addChild(window); stage.addChild(layer);
      filter.alpha = 1; filter.matrix = [0,0,0,0,1, 0,0,0,0,0, 0,0,0,0,0, 0,0,0,1,0];
      layer.filters = [filter]; assert.deepEqual(capture(), [255,0,0,255]);
    } finally { scope.PIXI = previousPixi; engine.scriptStage(session, null); }
  });
  await t.test('window refresh aliases generate bitmaps consumed by native rendering', () => {
    const stage = new scope.Container(), window = new scope.Window();
    const skin = new scope.Bitmap(192, 192); skin.fillAll('white');
    window.windowskin = skin; window.move(0, 0, 32, 32); window.backOpacity = 0; stage.addChild(window);
    const original = scope.Window.prototype._refreshFrame;
    let calls = 0;
    scope.Window.prototype._refreshFrame = function() {
      ++calls; original.call(this); this._windowFrameSprite.bitmap.fillAll('#ff0000');
    };
    const capture = () => {
      native.beginFrame(); scope.Graphics.render(stage); engine.present(session); native.renderFrame();
      return Array.from(native.canvas.captureSceneRawPremultiplied().subarray(0, 4));
    };
    try {
      assert.deepEqual(capture(), [255,0,0,255]); assert.ok(calls > 0);
      const count = calls; capture(); assert.equal(calls, count, 'unchanged native windows reuse plugin-generated parts');
      window.width = 40; assert.deepEqual(capture(), [255,0,0,255]); assert.ok(calls > count);
      window._windowFrameSprite.bitmap.fillAll('#00ff00'); assert.deepEqual(capture(), [0,255,0,255]);
      window._animationCount = 17; assert.equal(window._animationCount, 17);
      window._colorTone[0] = 20; assert.equal(window._colorTone[0], 20);
    } finally { scope.Window.prototype._refreshFrame = original; engine.scriptStage(session, null); }
  });
  await t.test('sprite bitmap-load aliases and mutable color arrays reach native rendering', () => {
    const bitmap = new scope.Bitmap(32, 32); bitmap.fillAll('white');
    class PluginSprite extends scope.Sprite {
      _onBitmapLoad(value) { super._onBitmapLoad(value); this.loadedBitmap = value; this.setFrame(0, 0, 16, 16); }
    }
    const sprite = new PluginSprite(bitmap), stage = new scope.Container(); stage.addChild(sprite);
    assert.equal(sprite.loadedBitmap, bitmap); assert.equal(sprite._bitmap, bitmap); assert.equal(sprite.width, 16);
    const tone = sprite._colorTone, blend = sprite._blendColor;
    assert.equal(tone, sprite._colorTone); assert.equal(blend, sprite._blendColor);
    tone[0] = -255; tone[2] = -255;
    const capture = () => {
      native.beginFrame(); scope.Graphics.render(stage); engine.present(session); native.renderFrame();
      return Array.from(native.canvas.captureSceneRawPremultiplied().subarray(0, 4));
    };
    try {
      assert.deepEqual(capture(), [0,255,0,255]);
      sprite._colorTone = [0,0,0,0]; blend[0] = 255; blend[3] = 255;
      assert.deepEqual(capture(), [255,0,0,255]);
      sprite.opaque = true; sprite._isPicture = true; assert.equal(sprite.opaque, true); assert.equal(sprite._isPicture, true);
    } finally { engine.scriptStage(session, null); }
  });
  await t.test('Graphics dimensions preserve independent layout sizes and resize native output', () => {
    const vm = require('node:vm');
    const source = fs.readFileSync(path.join(__dirname, '../third_party/rpg-maker-mv/rpg_core.js'), 'utf8');
    const reference = vm.createContext({ document: {} });
    vm.runInContext(source.slice(source.indexOf('function Graphics()'), source.indexOf('function Input()')), reference);
    const stock = reference.Graphics, graphics = scope.Graphics;
    for (const method of ['_testCanvasBlendModes', '_modifyExistingElements', '_updateRealScale', '_createAllElements',
      '_disableTextSelection', '_disableContextMenu', '_setupEventHandlers', '_setupCssFontLoading', '_updateAllElements']) stock[method] = () => {};
    stock._defaultStretchMode = () => false;
    try {
      stock.initialize(48, 40); graphics.initialize(48, 40);
      for (const [field, value] of [['boxWidth', 30], ['boxHeight', 28], ['width', 64], ['height', 56], ['width', 64]]) {
        stock[field] = value; graphics[field] = value;
        for (const name of ['width', 'height', 'boxWidth', 'boxHeight']) assert.equal(graphics[name], stock[name]);
        assert.equal(native.render.presentation().sourceWidth, stock.width);
        assert.equal(native.render.presentation().sourceHeight, stock.height);
      }
      const window = new scope.Window_Options();
      assert.equal(window.x, (30 - window.width) / 2);
      assert.equal(window.y, (28 - window.height) / 2);
      stock.initialize(); graphics.initialize();
      for (const name of ['width', 'height', 'boxWidth', 'boxHeight']) assert.equal(graphics[name], stock[name]);
    } finally { graphics.initialize(32, 32); }
  });
  await t.test('plugin repeat settings affect native repeated and long-pressed queries', () => {
    const vm = require('node:vm');
    const source = fs.readFileSync(path.join(__dirname, '../third_party/rpg-maker-mv/rpg_core.js'), 'utf8');
    const reference = vm.createContext({ navigator: { getGamepads: () => [] } });
    vm.runInContext(source.slice(source.indexOf('function Input()'), source.indexOf('function TouchInput()')), reference);
    const stock = reference.Input, input = scope.Input;
    stock.clear(); input.clear(); input.update();
    stock._currentState.ok = true; input._currentState.ok = true;
    try {
      for (let frame = 0; frame < 16; ++frame) {
        if (frame === 0 || frame === 7) {
          stock.keyRepeatWait = input.keyRepeatWait = frame === 0 ? 4 : 2;
          stock.keyRepeatInterval = input.keyRepeatInterval = frame === 0 ? 3 : 2;
        }
        stock.update(); input.update();
        for (const method of ['isPressed', 'isTriggered', 'isRepeated', 'isLongPressed'])
          assert.equal(input[method]('ok'), stock[method]('ok'), method + ' frame ' + frame);
      }
    } finally { input.clear(); input.keyRepeatWait = 24; input.keyRepeatInterval = 6; }
  });
  await t.test('window indicators and ScreenSprite blend assignments reach native pixels', () => {
    class PluginWindow extends scope.Window {}
    const stage = new scope.Container(), window = new PluginWindow();
    const skin = new scope.Bitmap(192, 192);
    skin.fillAll('white'); window.windowskin = skin; window.move(0, 0, 32, 32);
    window.opacity = 0; stage.addChild(window);
    const capture = (x, y) => {
      native.beginFrame(); scope.Graphics.render(stage); engine.present(session); native.renderFrame();
      const pixels = native.canvas.captureSceneRawPremultiplied();
      return Array.from(pixels.subarray((y * 32 + x) * 4, (y * 32 + x + 1) * 4));
    };
    for (const [field, x, y] of [['upArrowVisible', 16, 7], ['downArrowVisible', 16, 15], ['pause', 16, 20]]) {
      window[field] = true; window.update();
      assert.ok(capture(x, y)[0] > 0, field);
      window[field] = false; window.update(); assert.equal(capture(x, y)[0], 0, field);
    }
    stage.removeChild(window);
    const background = new scope.ScreenSprite(), foreground = new scope.ScreenSprite();
    background.setColor(80, 120, 160); foreground.setColor(64, 96, 128);
    background.opacity = foreground.opacity = 255;
    stage.addChild(background); stage.addChild(foreground);
    const expected = [[64, 96, 128], [144, 216, 255], [20, 45, 80], [124, 171, 208]];
    for (let mode = 0; mode < 4; ++mode) {
      foreground.blendMode = mode;
      const actual = capture(0, 0);
      expected[mode].forEach((value, channel) => assert.ok(Math.abs(actual[channel] - value) <= 1, 'blend ' + mode + ': ' + actual));
    }
    stage.removeChild(background); stage.removeChild(foreground);
    engine.scriptStage(session, null);
  });
  await t.test('window chrome transforms native pixels and survives detachment', async t => {
    const stage = new scope.Container();
    const background = new scope.ScreenSprite();
    background.setBlack(); background.opacity = 255; stage.addChild(background);
    let window = new scope.Window(), skin = new scope.Bitmap(192, 192);
    skin.fillAll('white'); window.windowskin = skin; window.move(0, 0, 32, 32);
    stage.addChild(window);
    const capture = (x, y) => {
      native.beginFrame(); scope.Graphics.render(stage); engine.present(session); native.renderFrame();
      const offset = (y * 32 + x) * 4;
      return Array.from(native.canvas.captureSceneRawPremultiplied().subarray(offset, offset + 4));
    };
    try {
      window.openness = 128;
      assert.equal(capture(16, 2)[0], 0, 'ordinary openness closes vertically');
      assert.equal(capture(2, 16)[0], 255, 'ordinary openness keeps the full width');
      const chrome = window._windowSpriteContainer;
      assert.equal(window._windowSpriteContainer, chrome);
      chrome.scale.set(0.5, 1); chrome.position.set(8, 0);
      window._openness = 192;
      assert.equal(capture(4, 16)[0], 0, 'the authored chrome transform closes horizontally');
      assert.deepEqual(capture(16, 2), [255, 255, 255, 255], 'raw openness must not replace authored chrome geometry');
      chrome.alpha = 0;
      assert.equal(capture(16, 16)[0], 0, 'chrome alpha affects the actual native skin');
      chrome.alpha = 1;
      stage.addChild(chrome); stage.removeChild(window);
      const formerWindow = new WeakRef(window);
      window = null; skin = null;
      assert.deepEqual(capture(16, 2), [255, 255, 255, 255], 'a reparented chrome node keeps its cached skin');
      await t.test('retained chrome renders after its native parent is collected', { skip: !global.gc }, async () => {
        for (let cycle = 0; cycle < 3; ++cycle) { await new Promise(resolve => setImmediate(resolve)); global.gc(); }
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(formerWindow.deref(), undefined);
        assert.deepEqual(capture(16, 2), [255, 255, 255, 255], 'cached skin resources belong to the retained chrome');
      });
    } finally { engine.scriptStage(session, null); }
  });
  await t.test('default weather dimmer pixels follow the bundled MV color and opacity', () => {
    const reference = fs.readFileSync(path.join(__dirname, '../third_party/rpg-maker-mv/rpg_core.js'), 'utf8');
    const vm = require('node:vm'), stock = { power: 9, addChild() {} };
    const context = vm.createContext({ Weather: { prototype: {} }, ScreenSprite: function() {
      this.setColor = (...color) => { this.color = color; };
    } });
    for (const method of ['_createDimmer', '_updateDimmer']) {
      const definition = reference.match(new RegExp('Weather\\.prototype\\.' + method + ' = function\\(\\) \\{[\\s\\S]*?\\n\\};'))[0];
      vm.runInContext(definition, context);
    }
    const weather = new scope.Weather(), stage = new scope.Container(), background = new scope.ScreenSprite();
    background.opacity = 255; stage.addChild(background); stage.addChild(weather);
    context.Weather.prototype._createDimmer.call(stock);
    try {
      for (const power of [0, 9]) {
        stock.power = weather.power = power;
        context.Weather.prototype._updateDimmer.call(stock); weather.update();
        native.beginFrame(); scope.Graphics.render(stage); engine.present(session); native.renderFrame();
        const expected = Array.from(stock._dimmerSprite.color, channel => Math.round(channel * stock._dimmerSprite.opacity / 255));
        assert.deepEqual(Array.from(native.canvas.captureSceneRawPremultiplied().subarray(0, 4)), [...expected, 255]);
      }
    } finally { engine.scriptStage(session, null); }
  });
  await t.test('Input overrides observe event, gamepad and direction boundaries with writable previous state', () => {
    const input = scope.Input, direction = input._updateDirection, poll = input._pollGamepads, query = input.isPressed;
    const trace = [];
    try {
      input.clear(); input._onKeyDown({ keyCode: 90 });
      assert.equal(input.isPressed('ok'), true);
      input._previousState.ok = false; input._pressedTime = 7; input._preferredAxis = 'x';
      input._pollGamepads = function() { trace.push('poll'); };
      input._updateDirection = function() { trace.push('direction'); return direction.call(this); };
      input.isPressed = function(name) { return name === 'right' || name === 'down'; };
      input.update();
      assert.deepEqual(trace, ['poll', 'direction']); assert.equal(input.dir8, 3); assert.equal(input.dir4, 6);
      assert.equal(input._previousState.ok, true); assert.equal(input._pressedTime, 0);
      input._onKeyUp({ keyCode: 90 }); assert.equal(input._currentState.ok, false);
      input._onLostFocus(); assert.equal(input._latestButton, null);
    } finally { input._updateDirection = direction; input._pollGamepads = poll; input.isPressed = query; input.clear(); }
  });
  await t.test('plugin input dictionaries and latest-button queries share native state', () => {
    const input = scope.Input, state = input._currentState;
    input.clear(); assert.equal(input._latestButton, null);
    state.ok = true; assert.equal(input.isPressed('ok'), true);
    input._latestButton = 'ok'; assert.equal(input._latestButton, 'ok'); assert.equal(input.isTriggered('ok'), true);
    assert.equal(state[input._latestButton], true);
    input._currentState = { cancel: true }; assert.equal(input._currentState, state);
    assert.equal(input.isPressed('ok'), false); assert.equal(input.isPressed('cancel'), true);
    delete state.cancel; assert.equal(state.cancel, undefined);
    input.clear(); assert.equal(Object.keys(state).length, 0);
  });
  await t.test('game-end scenes create native command windows and close through inherited lifecycle', () => {
    const scene = new scope.Scene_GameEnd();
    assert.equal(scene instanceof scope.Scene_MenuBase, true);
    scene.create();
    assert.equal(scene._commandWindow instanceof scope.Window_GameEnd, true);
    assert.equal(scene._backgroundSprite.opacity, 128);
    scene._commandWindow.openness = 255; scene.stop();
    assert.equal(scene._commandWindow.closing, true);
  });
  await t.test('named command windows share their native command and selection model', () => {
    const initialize=scope.Window_PartyCommand.prototype.initialize;
    scope.Window_PartyCommand.prototype.initialize=function(...args) { initialize.apply(this,args); this.pluginMarker=17; };
    try {
      const window=new scope.Window_PartyCommand();
      assert.ok(window instanceof scope.Window_Command);
      assert.equal(window.maxItems(),2);
      assert.equal(window.commandSymbol(0),'fight');
      assert.equal(window.commandSymbol(1),'escape');
      window.select(1); assert.equal(window.currentSymbol(),'escape');
      assert.equal(window.pluginMarker,17);
      window.addCommand('Custom','custom',true,42);
      window.select(2); assert.equal(window.currentExt(),42);
    } finally { scope.Window_PartyCommand.prototype.initialize=initialize; }
  });
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
  await t.test('scene rendering honors the stage selected by a Graphics.render override', () => {
    const original = scope.Graphics.render, selected = new scope.Container();
    const bitmap = new scope.Bitmap(2, 2); bitmap.fillAll('blue');
    const marker = new scope.Sprite(bitmap); selected.addChild(marker);
    let submitted;
    scope.Graphics.render = function(stage) { submitted = stage; original.call(this, selected); };
    try {
      runtime.step();
      assert.equal(submitted, first, 'SceneManager must dispatch the mutable rendering method');
      assert.deepEqual(draw(0, 0), [0, 0, 255, 255], 'the host must preserve the override-selected stage');
    } finally { scope.Graphics.render = original; scope.SceneManager.renderScene(); }
  });
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
  await t.test('native transitions commit through script lifecycle, readiness and one scene stack', async () => {
    const data = fixture([]);
    data.system.versionId = 0;
    data.commonEvents.push({ id: 2, list: [{ code: 353, indent: 0, parameters: [] }, { code: 0, indent: 0, parameters: [] }] });
    data.enemies = [null, { name: 'Enemy', params: [100, 20, 10, 10, 10, 10, 10, 10], actions: [], traits: [] }];
    data.troops = [null, { members: [{ enemyId: 1, x: 100, y: 100 }], pages: [] }];
    const session = engine.create(data);
    try {
      engine.attach(session, { width: 32, height: 32, fontFile: 'font.ttf' });
      const runtime = createScriptRuntime(engine, session, { native }); runtime.installScenes();
      const { scope } = runtime, trace = [];
      scope.$dataSystem = data.system;
      scope.observeTransition = (scene, hook) => {
        assert.equal(scope.SceneManager._scene, scene);
        trace.push([scene.constructor.name, hook, engine.snapshot(session).scene]);
        if (scene.constructor === scope.Scene_Title && hook === 'stop') {
          const tick = engine.snapshot(session).ticks;
          engine.step(session, {});
          assert.equal(engine.snapshot(session).ticks, tick, 'scene hooks run outside the native frame and pending execution stays paused');
        }
      };
      runtime.runScript(`
        var mapReady = false;
        for (var type of [Scene_Title, Scene_Map]) {
          for (var hook of ['create', 'start', 'stop', 'terminate']) {
            (function(type, hook, original) {
              type.prototype[hook] = function() {
                observeTransition(this, hook);
                original.call(this);
                if (type === Scene_Title && hook === 'stop') this.startFadeOut(3);
              };
            })(type, hook, type.prototype[hook]);
          }
        }
        Scene_Map.prototype.isReady = function() { return mapReady; };
      `);
      async function reach(type, started = false) {
        for (let frame = 0; frame < 300; ++frame) {
          runtime.step({});
          if (scope.SceneManager._scene?.constructor === type && !scope.SceneManager.isSceneChanging() && (!started || scope.SceneManager.isCurrentSceneStarted())) return;
          await new Promise(resolve => setImmediate(resolve));
        }
        assert.fail('scene did not reach ' + type.name);
      }
      runtime.start(); await reach(scope.Scene_Title);
      scope.DataManager.setupNewGame();
      assert.equal(engine.snapshot(session).scene, 0, 'game object initialization does not change the active scene');
      for (let frame = 0; frame < 40; ++frame) runtime.step({});
      runtime.step({ ok: true });
      for (let frame = 0; frame < 100 && !scope.SceneManager.isSceneChanging(); ++frame) runtime.step({});
      assert.equal(scope.SceneManager.isNextScene(scope.Scene_Map), true);
      const title = scope.SceneManager._scene, pendingTick = engine.snapshot(session).ticks;
      for (let frame = 0; frame < 3; ++frame) {
        runtime.step({});
        assert.equal(scope.SceneManager._scene, title);
        assert.equal(engine.snapshot(session).scene, 0, 'native presentation stays on title while script stop is busy');
        assert.equal(engine.snapshot(session).ticks, pendingTick);
      }
      await reach(scope.Scene_Map);
      assert.equal(engine.snapshot(session).scene, 1);
      assert.equal(scope.SceneManager.isCurrentSceneStarted(), false);
      runtime.step({}); assert.equal(engine.snapshot(session).ticks, pendingTick, 'native map waits for script readiness');
      scope.mapReady = true; runtime.step({});
      assert.equal(engine.snapshot(session).ticks, pendingTick + 1);
      assert.deepEqual(trace.filter(row => row[0] === 'Scene_Title').map(row => row[1]), ['create', 'start', 'stop', 'terminate']);
      assert.deepEqual(trace.filter(row => row[0] === 'Scene_Map'), [['Scene_Map', 'create', 1], ['Scene_Map', 'start', 1]]);
      for (let frame = 0; frame < 5; ++frame) runtime.step({});
      runtime.step({ cancel: true });
      const stoppedTick = engine.snapshot(session).ticks, stopCount = trace.filter(row => row[1] === 'stop').length;
      scope.SceneManager.stop(); runtime.step({});
      assert.equal(engine.snapshot(session).scene, 1);
      assert.equal(engine.snapshot(session).ticks, stoppedTick);
      assert.equal(trace.filter(row => row[1] === 'stop').length, stopCount);
      scope.SceneManager.resume(); await reach(scope.Scene_Menu);
      assert.equal(engine.snapshot(session).scene, 2);
      assert.deepEqual(scope.SceneManager._stack, [scope.Scene_Map]);
      runtime.step({}); runtime.step({ ok: true }); await reach(scope.Scene_Item);
      assert.equal(engine.snapshot(session).scene, 3);
      assert.deepEqual(scope.SceneManager._stack, [scope.Scene_Map, scope.Scene_Menu]);
      runtime.step({}); runtime.step({ cancel: true }); await reach(scope.Scene_Menu);
      assert.deepEqual(scope.SceneManager._stack, [scope.Scene_Map]);
      runtime.step({}); runtime.step({ cancel: true }); await reach(scope.Scene_Map);
      assert.deepEqual(scope.SceneManager._stack, []);

      runtime.runScript(`
        function PluginMenu() { this.initialize.apply(this, arguments); }
        PluginMenu.prototype = Object.create(Scene_Menu.prototype);
        PluginMenu.prototype.constructor = PluginMenu;
        var originalSceneGoto = SceneManager.goto;
        SceneManager.goto = function(type) {
          return originalSceneGoto.call(this, type === Scene_Menu ? PluginMenu : type);
        };
      `);
      runtime.step({}); runtime.step({ cancel: true }); await reach(scope.PluginMenu);
      assert.equal(scope.SceneManager.nativeDriven, true);
      assert.equal(engine.snapshot(session).scene, 2);
      runtime.step({}); runtime.step({ cancel: true }); await reach(scope.Scene_Map);
      scope.SceneManager.goto = scope.originalSceneGoto;

      scope.SceneManager.push(scope.Scene_Options); await reach(scope.Scene_Options, true);
      engine.configure(session, { alwaysDash: false });
      const optionWindow = scope.SceneManager._scene._optionsWindow;
      let scriptOk = 0;
      optionWindow.processOk = () => { ++scriptOk; };
      const isRepeated = scope.Input.isRepeated;
      scope.Input.isRepeated = name => name === 'ok';
      runtime.step({ ok: true });
      scope.Input.isRepeated = isRepeated;
      assert.equal(scriptOk, 0, 'native menus have one input owner');
      assert.equal(engine.configuration(session).alwaysDash, true);
      runtime.step({}); runtime.step({ cancel: true }); await reach(scope.Scene_Map);
      assert.deepEqual(scope.SceneManager._stack, []);

      const saved = engine.save(session);
      engine.setSaveMetadata(session, [null, { title: '', globalId: 'RPGMV' }]);
      scope.SceneManager.goto(scope.Scene_Load); await reach(scope.Scene_Load);
      engine.load(session, saved);
      assert.equal(engine.snapshot(session).scene, 10, 'loading game objects waits for the scene transition');
      runtime.step({}); runtime.step({ ok: true });
      assert.equal(engine.storageStatus(session).load, true);
      engine.load(session, saved); engine.completeStorage(session, true);
      await reach(scope.Scene_Map);
      assert.equal(engine.snapshot(session).scene, 1);
      assert.deepEqual(scope.SceneManager._stack, []);

      runtime.runScript(`
        function PluginMap() { this.initialize.apply(this, arguments); }
        PluginMap.prototype = Object.create(Scene_Map.prototype);
        PluginMap.prototype.constructor = PluginMap;
      `);
      scope.SceneManager.goto(scope.PluginMap); await reach(scope.PluginMap);
      let battleEnemy;
      const setBattler = scope.Sprite_Enemy.prototype.setBattler;
      scope.Sprite_Enemy.prototype.setBattler = function(enemy) { setBattler.call(this, enemy); battleEnemy = enemy; };
      engine.startBattle(session, 1, true, true);
      assert.equal(engine.snapshot(session).scene, 1);
      await reach(scope.Scene_Battle);
      assert.equal(engine.snapshot(session).scene, 11);
      assert.deepEqual(scope.SceneManager._stack, [scope.PluginMap]);
      battleEnemy.setHp(0);
      for (let frame = 0; frame < 300 && scope.SceneManager._scene?.constructor !== scope.PluginMap; ++frame) {
        if (engine.snapshot(session).message.busy) engine.acknowledge(session);
        runtime.step({});
      }
      assert.equal(scope.SceneManager._scene?.constructor, scope.PluginMap);
      assert.equal(engine.snapshot(session).battle.active, false);
      assert.equal(engine.snapshot(session).scene, 1);
      assert.deepEqual(scope.SceneManager._stack, []);

      scope.SceneManager.goto(scope.Scene_Load); await reach(scope.Scene_Load);
      assert.equal(engine.snapshot(session).scene, 10);
      scope.SceneManager._scene.onLoadSuccess(); await reach(scope.Scene_Map);
      assert.equal(engine.snapshot(session).scene, 1);
      assert.equal(scope.SceneManager._stack.length, 0);
      runtime.runScript(`
        function CustomScene() { this.initialize.apply(this, arguments); }
        CustomScene.prototype = Object.create(Scene_Base.prototype);
        CustomScene.prototype.constructor = CustomScene;
      `);
      scope.SceneManager.goto(scope.CustomScene); await reach(scope.CustomScene);
      scope.SceneManager.push(scope.Scene_Options); await reach(scope.Scene_Options, true);
      runtime.step({}); runtime.step({ cancel: true }); await reach(scope.CustomScene);
      assert.equal(engine.snapshot(session).scene, 1);
      assert.deepEqual(scope.SceneManager._stack, []);
      scope.SceneManager.goto(scope.Scene_Map); await reach(scope.Scene_Map);

      scope.$gameTemp.reserveCommonEvent(2);
      assert.equal(engine.snapshot(session).scene, 1);
      await reach(scope.Scene_Gameover, true);
      assert.equal(engine.snapshot(session).scene, 12);
      scope.SceneManager._scene.gotoTitle(); await reach(scope.Scene_Title);
      assert.equal(engine.snapshot(session).scene, 0);
    } finally { engine.dispose(session); }
  });
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
      const transitions = [];
      for (const name of ['_onTrigger', '_onMove', '_onRelease', '_onCancel']) {
        const base = touch[name];
        touch[name] = function(x, y) { transitions.push([name, x, y]); return base.call(this, x, y); };
      }
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
      assert.deepEqual(transitions[0], ["_onTrigger", 16, 16]);
      runtime.step();
      assert.equal(touch.isTriggered(), false);
      assert.equal(touch.isLongPressed(), true);
      touch._onMouseUp(event); runtime.step();
      assert.equal(touch.isReleased(), true); assert.equal(touch.isPressed(), false);
      assert.deepEqual(transitions.at(-1), ["_onRelease", 16, 16]);
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

  await t.test('selectable windows dispatch native navigation and mutable OK/cancel handlers', async () => {
    const engine = native.mvEngine, session = engine.create(fixture([]));
    try {
      engine.attach(session, { width: 32, height: 32, fontFile: 'font.ttf' });
      const runtime = createScriptRuntime(engine, session, { native }); runtime.installScenes(); engine.newGame(session);
      const { scope } = runtime, held = new Set(), trace = [];
      scope.Input.isRepeated = scope.Input.isTriggered = name => held.has(name);
      const window = new scope.Window_Command(0, 0);
      window.addCommand('First', 'first'); window.addCommand('Second', 'second'); window.select(0);
      const dataWindow = new scope.Window_Selectable(0, 0, 200, 160); dataWindow.maxItems = () => 3;
      function Menu() { this.initialize(); }
      Menu.prototype = Object.create(scope.Scene_Base.prototype); Menu.prototype.constructor = Menu;
      Menu.prototype.create = function() { this.createWindowLayer(); this.addWindow(window); this.addWindow(dataWindow); };
      scope.SceneManager.run(Menu);
      for (let i = 0; i < 100 && !scope.SceneManager.isCurrentSceneStarted(); ++i) { runtime.step(); await new Promise(resolve => setTimeout(resolve, 1)); }
      assert.equal(scope.SceneManager.isCurrentSceneStarted(), true);
      const down = window.cursorDown; let downCalls = 0;
      window.cursorDown = function(wrap) { ++downCalls; down.call(this, wrap); };
      held.add('down'); runtime.step(); assert.equal(window.index(), 1); assert.equal(downCalls, 1);
      window._cursorFixed = true; held.clear(); held.add('up'); runtime.step(); assert.equal(window.index(), 1);
      window._cursorFixed = false; runtime.step(); assert.equal(window.index(), 0);
      const updateInput = window.updateInputData;
      window.updateInputData = function() { held.clear(); trace.push('input'); updateInput.call(this); };
      scope.SoundManager.playOk = () => trace.push('ok-sound'); scope.SoundManager.playCancel = () => trace.push('cancel-sound');
      window.setHandler('first', () => { trace.push('first'); assert.equal(window.active, false); });
      window.setHandler('cancel', () => { trace.push('cancel'); assert.equal(window.active, false); });
      held.clear(); held.add('ok'); runtime.step(); assert.deepEqual(trace, ['ok-sound', 'input', 'first']);
      window.activate(); trace.length = 0; held.add('cancel'); runtime.step();
      assert.deepEqual(trace, ['cancel-sound', 'input', 'cancel']);
      window.deactivate(); dataWindow.select(0); dataWindow.activate(); held.add('down'); runtime.step();
      assert.equal(dataWindow.index(), 1, 'plugin-owned item lists must use their overridden maxItems');
    } finally { engine.dispose(session); }
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
      manager.loadDataFile('$dataExtra', 'Extra.json');
      assert.equal(runtime.database.isReady(), true);
      assert.equal(engine.databaseInvoke(session, 'read', 'plugin:$dataExtra'), runtime.scope.$dataExtra);
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
      actorRuntime.scope.SceneManager.update();
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

  await t.test('enemy battler aliases reposition native pixels in front and side view', () => {
    for (const sideView of [false, true]) {
      const data = fixture([]); data.system.optSideView = sideView;
      data.enemies = [null, { name: 'Enemy', battlerName: 'Enemy', params: [100, 20, 10, 10, 10, 10, 10, 10], actions: [], traits: [] }];
      data.troops = [null, { members: [{ enemyId: 1, x: sideView ? 16 : 408, y: 320 }], pages: [] }];
      const enemySession = engine.create(data);
      let retainedSprite, retainedEnemy;
      try {
        engine.attach(enemySession, { width: 32, height: 32, fontFile: 'font.ttf' });
        const enemyRuntime = createScriptRuntime(engine, enemySession, { native }); enemyRuntime.installScenes();
        const { scope } = enemyRuntime, original = scope.Sprite_Enemy.prototype.setBattler;
        let seen, calls = 0;
        scope.Sprite_Enemy.prototype.setBattler = function(enemy) {
          original.call(this, enemy); ++calls; seen = this;
          assert.equal(this._enemy, enemy); assert.equal(this._battler, enemy);
          if (!enemy.adjustedY) {
            this._homeY += Math.floor((scope.Graphics.boxHeight - 624) / 2);
            enemy._screenY = this._homeY; enemy.adjustedY = true;
          }
          if (!scope.$gameSystem.isSideView() && !enemy.adjustedX) {
            this._homeX += (scope.Graphics.boxWidth - 816) / 2;
            enemy._screenX = this._homeX; enemy.adjustedX = true;
          }
        };
        engine.newGame(enemySession); engine.startBattle(enemySession, 1, true, true);
        enemyRuntime.scope.SceneManager.update();
        const capture = () => {
          native.beginFrame(); engine.present(enemySession); native.renderFrame();
          return Array.from(native.canvas.captureSceneRawPremultiplied().subarray((12 * 32 + 16) * 4, (12 * 32 + 16) * 4 + 4));
        };
        assert.deepEqual(capture(), [255, 0, 0, 255]);
        assert.equal(calls, 1); assert.equal(seen._homeX, 16); assert.equal(seen._homeY, 24);
        const enemy = seen._enemy;
        assert.equal(enemy.screenX(), 16); assert.equal(enemy.screenY(), 24);
        assert.equal(scope.$gameSystem.isSideView(), sideView);
        seen._homeX = -100; assert.deepEqual(capture(), [0, 0, 0, 255]);
        seen.setBattler(enemy); assert.equal(seen._homeX, 16); assert.equal(seen._homeY, 24);
        assert.deepEqual(capture(), [255, 0, 0, 255]);
        seen.startEffect('whiten'); assert.equal(seen.isEffecting(), true); assert.equal(seen._effectDuration, 16);
        assert.throws(() => original.call(seen, scope.$gameActors.actor(1)), /requires an enemy battler/);
        assert.equal(seen._enemy, enemy, 'rejected native references must preserve aliases');
        const foreign = engine.create(fixture([]));
        try {
          const model = engine.classBindings.create(enemySession, 'Sprite_Enemy');
          assert.throws(() => engine.classBindings.invoke(model, 'setBattler', [engine.entity(foreign, 'actor', 1)]), /another session/);
        } finally { engine.dispose(foreign); }
        retainedSprite = seen; retainedEnemy = enemy;
        engine.startBattle(enemySession, 1, true, true);
        assert.notEqual(seen, retainedSprite); assert.notEqual(seen._enemy, retainedEnemy);
        assert.equal(retainedEnemy.screenY(), 24); assert.equal(retainedSprite._homeX, 16);
      } finally { engine.dispose(enemySession); }
      assert.equal(retainedSprite._enemy, retainedEnemy);
      assert.equal(retainedEnemy.screenY(), 24); assert.equal(retainedSprite._homeY, 24);
    }
  });

  await t.test('balloon overrides change native event rendering and retain their original object', async () => {
    const data = fixture([{ code: 213, parameters: [-1, 2, true], indent: 0 }]);
    data.maps[1].parallaxName = 'Background';
    const balloonSession = engine.create(data);
    let observed;
    try {
      engine.attach(balloonSession, { width: 32, height: 32, fontFile: 'font.ttf' });
      const runtime = createScriptRuntime(engine, balloonSession, { native }); runtime.installScenes();
      const { Sprite_Balloon: Balloon, ImageManager } = runtime.scope;
      const stock = new Balloon(); stock.setup(1); stock.update();
      assert.equal(stock.bitmap, ImageManager.loadSystem('Balloon'));
      assert.equal(stock._frame.width, 48); assert.equal(stock._duration, 75);
      const initialize = Balloon.prototype.initialize;
      Balloon.prototype.initialize = function() {
        initialize.call(this); this.marker = {}; this.y = 48; observed = this;
      };
      Balloon.prototype.loadBitmap = function() {
        this.bitmap = ImageManager.loadSystem('Reactions'); this.setFrame(0, 0, 0, 0);
      };
      Balloon.prototype.updateFrame = function() {
        this.setFrame(this.frameIndex() * 32, (this._balloonId - 1) * 24, 32, 24);
      };
      class CustomBalloon extends Balloon { customMethod() { return this.marker; } }
      const manual = new CustomBalloon(); manual.setup(2); manual.update();
      assert.ok(manual instanceof Balloon); assert.equal(manual.customMethod(), manual.marker);
      assert.equal(manual._duration, 75); assert.equal(manual._frame.width, 32);
      manual.speed = () => 4; manual.waitTime = () => 6;
      manual.setup(2); assert.equal(manual._duration, 38);
      manual.update(); assert.equal(manual._duration, 37); assert.equal(manual.frameIndex(), 0);
      observed = null;
      engine.newGame(balloonSession);
      for (let i = 0; i < 4; ++i) engine.step(balloonSession);
      assert.ok(observed instanceof Balloon);
      const retained = observed, marker = retained.marker;
      assert.equal(retained.bitmap, manual.bitmap, 'native initialization must use the shared image cache');
      assert.equal(retained._frame.height, 24); assert.equal(retained._frame.y, 24);
      const capture = () => {
        native.beginFrame(); engine.present(balloonSession); native.renderFrame();
        return native.canvas.captureSceneRawPremultiplied();
      };
      for (let i = 0; i < 100 && !retained.bitmap.isReady(); ++i) {
        capture(); ImageManager.update(); await new Promise(resolve => setTimeout(resolve, 5));
      }
      assert.equal(retained.bitmap.isReady(), true, JSON.stringify({ state: retained.bitmap._loadingState, url: retained.bitmap.url, error: retained.bitmap.isError() }));
      assert.equal(retained.bitmap.height, 48);
      const greenCount = () => {
        const rgba = capture(); let count = 0;
        for (let i = 0; i < rgba.length; i += 4) if (rgba[i] < 10 && rgba[i + 1] > 240 && rgba[i + 2] < 10) ++count;
        return count;
      };
      assert.ok(greenCount() > 0, 'event balloons must draw the script-selected image and frame');
      retained.x = 1000; assert.equal(greenCount(), 0, 'script properties must affect the actual native drawable');
      retained.x = 0; assert.ok(greenCount() > 0);
      for (let i = 0; i < 80; ++i) engine.step(balloonSession);
      assert.equal(retained.isPlaying(), false); assert.equal(retained.marker, marker);
      assert.equal(greenCount(), 0, 'finished effects must leave the native renderer');
      retained.setup(2); retained.update(); assert.equal(retained._duration, 75);
      Balloon.prototype.updateFrame = function() { throw new Error('balloon override failed'); };
      assert.throws(() => retained.update(), /balloon override failed/);
    } finally { engine.dispose(balloonSession); }
    assert.equal(observed._balloonId, 2, 'retained script references must survive session disposal');
  });

  await t.test('generated weather bindings dispatch aliases into the native weather renderer', () => {
    const data = fixture([]); data.maps[1].parallaxName = 'Background';
    const weatherSession = engine.create(data);
    let observed, retained;
    try {
      engine.attach(weatherSession, { width: 32, height: 32, fontFile: 'font.ttf' });
      const runtime = createScriptRuntime(engine, weatherSession, { native }); runtime.installScenes();
      const { Weather, Container, ScreenSprite } = runtime.scope;
      const schema = engine.classBindings.describe().find(type => type.name === 'Weather');
      assert.equal(schema.parent, 'Container');
      assert.equal(schema.methods.find(method => method.name === '_createDimmer').returnsValue, false);
      const initialize = Weather.prototype.initialize, createDimmer = Weather.prototype._createDimmer;
      Weather.prototype.initialize = function() { initialize.call(this); this.initializedByPlugin = true; };
      Weather.prototype._createDimmer = function() {
        createDimmer.call(this); this._dimmerSprite.setColor(255, 255, 255);
        this.pluginState = {}; observed = this;
        return this;
      };
      Weather.prototype._updateAllSprites = function() { this.updateCalls = (this.updateCalls || 0) + 1; return this; };
      class CustomWeather extends Weather { customMethod() { return this.pluginState; } }
      const manual = new CustomWeather();
      assert.ok(manual instanceof Container); assert.equal(manual.customMethod(), manual.pluginState);
      assert.equal(manual.initializedByPlugin, true);
      assert.ok(manual._dimmerSprite instanceof ScreenSprite);
      assert.equal(manual._dimmerSprite, manual.children[0]);
      const origin = manual.origin; origin.set(3, 4);
      manual.origin = { x: 8, y: 9 }; assert.equal(origin.x, 8); assert.equal(origin.y, 9);
      origin.x = 12; assert.equal(manual.origin.x, 12);
      manual.origin = origin; assert.equal(manual.origin.x, 12);
      manual.power = 9; manual.update(); assert.equal(manual._dimmerSprite.opacity, 54);
      const dimmer = manual._dimmerSprite;
      assert.throws(() => { manual._dimmerSprite = new Container(); }, /wrong native type/);
      assert.equal(manual._dimmerSprite, dimmer);
      engine.newGame(weatherSession);
      runtime.scope.$gameScreen.changeWeather('rain', 9, 0);
      const capture = () => {
        native.beginFrame(); engine.present(weatherSession); native.renderFrame();
        return Array.from(native.canvas.captureSceneRawPremultiplied().subarray(0, 4));
      };
      assert.deepEqual(capture(), [54, 54, 54, 255]);
      retained = observed;
      assert.notEqual(retained, manual); assert.ok(retained instanceof Weather);
      assert.equal(retained.initializedByPlugin, true); assert.equal(retained.type, 'rain');
      assert.equal(retained._dimmerSprite.opacity, 54);
      const state = retained.pluginState, calls = retained.updateCalls;
      engine.step(weatherSession); capture();
      assert.equal(observed, retained); assert.equal(retained.pluginState, state);
      assert.ok(retained.updateCalls > calls);
      retained._dimmerSprite.setBlack(); assert.deepEqual(capture(), [0, 0, 0, 255]);
      retained._dimmerSprite.setWhite(); assert.deepEqual(capture(), [54, 54, 54, 255]);
      Weather.prototype._updateDimmer = function() { throw new Error('weather override failed'); };
      engine.step(weatherSession); assert.throws(capture, /weather override failed/);
      Weather.prototype._updateDimmer = function() { this._dimmerSprite.opacity = 0; };
      engine.step(weatherSession); assert.deepEqual(capture(), [0, 0, 0, 255]);
    } finally { engine.dispose(weatherSession); }
    assert.equal(retained.initializedByPlugin, true);
    retained._dimmerSprite.setWhite(); assert.equal(retained._dimmerSprite.opacity, 0);
  });

  await t.test('audio manager properties retain shared native voices and effect-list identity', () => {
    const manager=scope.AudioManager, voice=new scope.WebAudio(''), volume=scope.ConfigManager.bgmVolume;
    voice.pluginMarker={kept:true};
    try {
      scope.ConfigManager.bgmVolume=80;
      manager._bgmBuffer=voice;
      manager.updateCurrentBgm({name:'Tone',volume:60,pitch:125,pan:-50},0);
      manager.updateBgmParameters(manager._currentBgm);
      assert.equal(manager._bgmBuffer,voice);
      assert.equal(manager._bgmBuffer.pluginMarker,voice.pluginMarker);
      assert.ok(Math.abs(voice.volume-0.48)<1e-9); assert.equal(voice.pitch,1.25); assert.equal(voice.pan,-0.5);
      manager._currentBgm.pos=0.25;
      assert.equal(engine.audioManager(session,'bgm','current').pos,0.25);
      const effects=manager._seBuffers;
      assert.equal(runtime.runScript('AudioManager._seBuffers instanceof Array'),true);
      effects.push(voice);
      assert.equal(manager._seBuffers,effects); assert.equal(effects[0],voice);
      manager._seBuffers=effects.filter(buffer=>buffer===voice);
      assert.equal(effects.length,1); assert.equal(effects.clone()[0],voice);
      manager.stopAll();
      assert.equal(manager._bgmBuffer,null); assert.equal(effects.length,0);
    } finally { manager.stopAll(); scope.ConfigManager.bgmVolume=volume; }
  });

  await t.test('generated audio bindings share native playback, listeners and engine buffer creation', () => {
    const audioSession = engine.create(fixture([]));
    let retained;
    try {
      engine.attach(audioSession, { width: 32, height: 32, fontFile: 'font.ttf' });
      const runtime = createScriptRuntime(engine, audioSession, { native }); runtime.installScenes();
      const { WebAudio, AudioManager } = runtime.scope;
      assert.equal(typeof WebAudio.initialize(), 'boolean');
      assert.equal(WebAudio.canPlayOgg(), true); WebAudio.setMasterVolume(1);
      const initialize = WebAudio.prototype.initialize, play = WebAudio.prototype.play;
      const played = [];
      WebAudio.prototype.initialize = function(url) { initialize.call(this, url); this.pluginState = {}; };
      WebAudio.prototype.play = function(loop, offset) { played.push(this); return play.call(this, loop, offset); };
      class CustomAudio extends WebAudio { customMethod() { return this.pluginState; } }
      const audio = new CustomAudio('audio/bgm/Tone.ogg');
      assert.equal(audio.isReady(), false); assert.equal(audio._buffer, null);
      assert.equal(audio.customMethod(), audio.pluginState);
      const order = [];
      audio.addLoadListener(() => {
        order.push(['first', audio.isPlaying()]);
        audio.addLoadListener(() => order.push(['late', audio.isPlaying()]));
      });
      audio.play(true, 0.25);
      audio.addLoadListener(() => order.push(['second', audio.isPlaying()]));
      engine.newGame(audioSession);
      const present = () => { native.beginFrame(); engine.present(audioSession); native.renderFrame(); };
      present();
      assert.equal(audio.isReady(), true); assert.equal(audio.isError(), false);
      assert.deepEqual(order, [['first', false], ['second', true], ['late', true]]);
      assert.equal(played[0], audio); assert.equal(played[1], audio);
      assert.equal(audio._buffer.length, audioFrames); assert.equal(audio._buffer.sampleRate, 48000);
      assert.ok(audio.seek() >= 0.25 && audio.seek() < 0.5);
      audio.volume = 0.3; audio.pan = -0.25; audio.pitch = 1.1;
      assert.equal(audio.volume, 0.3); assert.equal(audio.pan, -0.25); assert.equal(audio.pitch, 1.1);
      audio.addStopListener(() => { assert.equal(audio.isPlaying(), false); order.push('stop'); });
      audio.stop(); audio.stop(); assert.equal(order.filter(value => value === 'stop').length, 1);
      let discarded = false;
      audio.addLoadListener(() => { discarded = true; }); audio.clear();
      assert.equal(audio._buffer, null);
      initialize.call(audio, 'audio/bgm/Tone.ogg');
      let loaded = 0; audio.addLoadListener(() => ++loaded); present(); present();
      assert.equal(loaded, 1); assert.equal(discarded, false);
      retained = new WebAudio('audio/bgm/Tone.ogg');
      let nativeLoads = 0; retained.addLoadListener(() => ++nativeLoads);
      const state = retained.pluginState, requests = [];
      AudioManager.createBuffer = function(kind, name) { requests.push([kind, name]); return retained; };
      AudioManager.playBgm({ name: 'Tone', volume: 60, pitch: 100, pan: 0 }); present();
      assert.deepEqual(requests, [['bgm', 'Tone']]);
      assert.equal(played.at(-1), retained); assert.equal(retained.pluginState, state);
      assert.equal(retained.isPlaying(), true); assert.equal(retained.volume, 0.6);
      assert.equal(retained._buffer.length, audioFrames);
      present(); assert.equal(nativeLoads, 1, 'synchronous engine loading must cancel the queued load');
      AudioManager.stopBgm(); present();
      assert.equal(retained.isPlaying(), false); assert.equal(retained.isReady(), true);
      retained.play(true); assert.equal(retained.isPlaying(), true); retained.stop();
      AudioManager.playSe({ name: 'Tone', volume: 60, pitch: 100, pan: 0 }); present();
      assert.equal(retained.isPlaying(), true);
      AudioManager.stopSe(); present(); assert.equal(retained.isPlaying(), false);
      assert.equal(retained.isReady(), true);
      const bad = new WebAudio('audio/bgm/Tone.ogg');
      bad.addLoadListener(() => { throw new Error('audio listener failed'); });
      assert.throws(present, /audio listener failed/);
      assert.equal(bad.isReady(), true);
      bad.addStopListener(() => { throw new Error('audio stop failed'); });
      assert.throws(() => bad.stop(), /audio stop failed/);
      present();
      AudioManager.playBgm({ name: 'Tone', volume: 60, pitch: 100, pan: 0 }); present();
      WebAudio.prototype.stop = function() { throw new Error('destructor must not invoke script'); };
    } finally { engine.dispose(audioSession); }
    assert.equal(retained.isPlaying(), false); assert.equal(retained.isReady(), true);
    assert.equal(retained._buffer.length, audioFrames);
  });

  await t.test('native audio presentation restores its position without script bindings', () => {
    const data = fixture([]);
    data.maps[1].autoplayBgm = true;
    data.maps[1].bgm = { name: 'Tone', volume: 80, pitch: 100, pan: 0 };
    const audioSession = engine.create(data);
    try {
      engine.attach(audioSession, { width: 32, height: 32, fontFile: 'font.ttf' });
      engine.newGame(audioSession);
      const present = () => { native.beginFrame(); engine.present(audioSession); native.renderFrame(); };
      present();
      const saved = engine.save(audioSession);
      saved.system._bgmOnSave.pos = 0.35;
      engine.load(audioSession, saved); present();
      const restored = engine.save(audioSession).system._bgmOnSave;
      assert.equal(restored.name, 'Tone'); assert.ok(restored.pos >= 0.35);
    } finally { engine.dispose(audioSession); }
  });

});
