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
  fs.writeFileSync(path.join(root,'img/system/Retry.png'),Buffer.from('invalid image'));
  fs.copyFileSync(path.join(process.argv[3], 'testfont.ttf'), path.join(root, 'font.ttf'));
  fs.writeFileSync(path.join(root,'index.html'),'<html></html>');
  fs.mkdirSync(path.join(root, 'img/tilesets'), { recursive: true });
  fs.writeFileSync(path.join(root, 'img/tilesets/B.png'), png(96, 48, new Uint8Array(96 * 48 * 4).fill(255)));
  const tilePixels = new Uint8Array(96 * 48 * 4);
  for (let y=0;y<48;++y) for(let x=0;x<96;++x) tilePixels.set(x<48 ? [0,0,255,255] : [255,0,0,255], (y*96+x)*4);
  fs.writeFileSync(path.join(root, 'img/tilesets/Parity.png'), png(96,48,tilePixels));
  fs.mkdirSync(path.join(root, 'img/sv_actors'), { recursive: true });
  const actorPixels = new Uint8Array(216 * 144 * 4);
  for (let i = 0; i < actorPixels.length; i += 4) { actorPixels[i] = 255; actorPixels[i + 3] = 255; }
  fs.writeFileSync(path.join(root, 'img/sv_actors/Actor.png'), png(216, 144, actorPixels));
  fs.writeFileSync(path.join(root, 'img/system/Shadow1.png'), png(48, 24, new Uint8Array(48 * 24 * 4)));
  fs.writeFileSync(path.join(root, 'img/system/Shadow2.png'), png(48, 24, new Uint8Array(48 * 24 * 4)));
  fs.writeFileSync(path.join(root, 'img/system/States.png'), png(96, 96, new Uint8Array(96 * 96 * 4)));
  fs.writeFileSync(path.join(root, 'img/system/IconSet.png'), png(512, 32, new Uint8Array(512 * 32 * 4)));
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
  data.items[1].itypeId = 1;
  const session = engine.create(data);
  t.after(() => engine.dispose(session));
  engine.attach(session, { width: 32, height: 32, fontFile: 'font.ttf' });
  const runtime = createScriptRuntime(engine, session, { native }); runtime.installScenes();
  const { scope } = runtime;
  await t.test('gamepad overrides receive browser button records without mutating native snapshots', () => {
    const snapshot = native.input.snapshot, update = scope.Input._updateGamepadState;
    const pad = { index: 2, connected: true, id: 'Controller', buttonsDown: [0, 15], axes: [0.25, -0.5] };
    let received;
    native.input.snapshot = () => ({ gamepads: [pad] });
    scope.Input._updateGamepadState = value => { received = value; };
    try {
      scope.Input._pollGamepads();
      assert.equal(received.index, 2);
      assert.equal(received.buttons.length, 17);
      assert.equal(received.buttons[0].pressed, true);
      assert.equal(received.buttons[1].value, 0);
      assert.equal(received.buttons[15].pressed, true);
      assert.deepEqual(received.axes, pad.axes);
      assert.equal(pad.buttons, undefined);
    } finally { native.input.snapshot = snapshot; scope.Input._updateGamepadState = update; }
  });
  await t.test('Graphics clears a plugin upper canvas through its drawing context', () => {
    const calls = [], previous = scope.Graphics._upperCanvas;
    scope.Graphics._upperCanvas = { getContext(type) {
      assert.equal(type, '2d');
      return { clearRect(...args) { calls.push(args); } };
    } };
    try {
      scope.Graphics._clearUpperCanvas();
      assert.deepEqual(calls, [[0, 0, scope.Graphics.width, scope.Graphics.height]]);
    } finally { scope.Graphics._upperCanvas = previous; }
    assert.doesNotThrow(() => scope.Graphics._clearUpperCanvas());
  });
  await t.test('equipment scene commands change native equipment and preserve window selection', () => {
    const equipData = fixture([]), equipSession = engine.create(equipData);
    const dimensions = [scope.Graphics.boxWidth, scope.Graphics.boxHeight];
    try {
      engine.attach(equipSession, { width: 640, height: 480, fontFile: 'font.ttf' });
      const r = createScriptRuntime(engine, equipSession, { native }); r.installScenes();
      const s = r.scope;
      for (const name of ['actors', 'classes', 'weapons', 'armors', 'states', 'system', 'skills', 'items'])
        s['$data' + name[0].toUpperCase() + name.slice(1)] = equipData[name];
      s.Graphics.boxWidth = 640; s.Graphics.boxHeight = 480;
      engine.newGame(equipSession);
      const scene = new s.Scene_Equip(); scene.create();
      assert.equal(scene._slotWindow._actor, s.$gameActors.actor(1));
      scene.commandEquip(); assert.equal(scene._slotWindow.index(), 0);
      scene.onSlotOk(); assert.equal(scene._itemWindow.active, true);
      scene.onItemCancel(); assert.equal(scene._itemWindow.index(), -1);
      scene.commandClear(); assert.equal(scene.actor().equips()[0], null);
      scene.commandOptimize(); assert.equal(scene.actor().equips()[0], equipData.weapons[1]);
      assert.equal(scene._commandWindow.active, true);
    } finally {
      scope.Graphics.boxWidth = dimensions[0]; scope.Graphics.boxHeight = dimensions[1];
      engine.dispose(equipSession);
    }
  });
  await t.test('item scene helpers select native inventory and apply effects to the selected actor', () => {
    const itemData = fixture([]);
    itemData.items[1] = { id: 1, name: 'Potion', iconIndex: 0, itypeId: 1, hitType: 0, scope: 7,
      occasion: 0, successRate: 100, repeats: 2, tpGain: 0, consumable: true,
      damage: { type: 0, elementId: 0 }, effects: [{ code: 11, dataId: 0, value1: 0, value2: 3 }] };
    const itemSession = engine.create(itemData), dimensions = [scope.Graphics.boxWidth, scope.Graphics.boxHeight];
    try {
      engine.attach(itemSession, { width: 640, height: 480, fontFile: 'font.ttf' });
      const r = createScriptRuntime(engine, itemSession, { native }); r.installScenes();
      const s = r.scope;
      for (const name of ['actors', 'classes', 'weapons', 'armors', 'states', 'system', 'skills', 'items']) s['$data' + name[0].toUpperCase() + name.slice(1)] = itemData[name];
      s.Graphics.boxWidth = 640; s.Graphics.boxHeight = 480; engine.newGame(itemSession);
      const actor = s.$gameActors.actor(1); actor.setHp(1); s.$gameParty.gainItem(itemData.items[1], 2);
      const scene = new s.Scene_Item(); scene.createWindowLayer(); scene.createHelpWindow();
      scene._categoryWindow = new s.Window_ItemCategory(); scene.createItemWindow(); scene.createActorWindow();
      scene._itemWindow.setCategory('item'); scene._itemWindow.refresh(); scene._itemWindow.select(0); scene._actorWindow.select(0);
      assert.equal(scene.item(), itemData.items[1]); scene.applyItem();
      assert.equal(actor.hp, 7); assert.equal(actor.result().success, true);
      scene.onItemCancel(); assert.equal(scene._itemWindow.index(), -1); assert.equal(scene._categoryWindow.active, true);
    } finally {
      scope.Graphics.boxWidth = dimensions[0]; scope.Graphics.boxHeight = dimensions[1]; engine.dispose(itemSession);
    }
  });
  await t.test('battle log queues preserve plugin arguments and wait for movement before drawing text', () => {
    const log = new scope.Window_BattleLog(), token = { value: 7 }, calls = [];
    log.record = value => calls.push(value);
    log.push('record', token); log.update(); assert.equal(calls[0], token);
    let moving = true;
    log.setSpriteset({ isAnyoneMoving: () => moving, isEffecting: () => false });
    log.setWaitMode('movement'); log.push('addText', 'Ready');
    log.update(); assert.equal(log.numLines(), 0);
    moving = false; log.update(); assert.deepEqual(log._lines, ['Ready']);
    assert.equal(log._waitCount, log.messageSpeed());
    log.pushBaseLine(); log.addText('Next'); log.popBaseLine(); assert.deepEqual(log._lines, ['Ready']);
    log.clear(); assert.equal(log.numLines(), 0);
  });
  await t.test('actor sprite helpers share native motion counters and draw the selected frame', async () => {
    const actor = scope.$gameActors.actor(1), originalName = actor.battlerName();
    try {
      actor.setBattlerImage('Actor');
      const sprite = new scope.Sprite_Actor(actor);
      assert.equal(sprite._actor, actor); assert.equal(sprite._battler, actor);
      sprite.alpha = 0.5; assert.equal(sprite.opacity, 127.5); sprite.opacity = 300; assert.equal(sprite.alpha, 1);
      sprite.updateBitmap();
      for (let i = 0; i < 100 && !sprite._mainSprite.bitmap.isReady(); ++i) {
        native.beginFrame(); engine.present(session); native.renderFrame(); scope.ImageManager.update();
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      assert.equal(sprite._mainSprite.bitmap.isReady(), true);
      sprite.startMotion('walk');
      for (let i = 0; i < 12; ++i) sprite.updateMotionCount();
      assert.equal(sprite._pattern, 1); assert.equal(sprite._motionCount, 0);
      sprite.updateFrame(); assert.equal(sprite._mainSprite._frame.x, 24); assert.equal(sprite._mainSprite._frame.height, 24);
      actor.select(); sprite.updateSelectionEffect(); assert.deepEqual(Array.from(sprite._mainSprite.getBlendColor()), [255, 255, 255, 64]);
      actor.deselect(); sprite.updateSelectionEffect(); assert.deepEqual(Array.from(sprite._mainSprite.getBlendColor()), [0, 0, 0, 0]);
      sprite.updateShadow(); assert.equal(sprite._shadowSprite.visible, true);
      sprite.createWeaponSprite(); sprite.createStateSprite(); assert.equal(sprite.children.includes(sprite._weaponSprite), true);
    } finally { actor.setBattlerImage(originalName); actor.deselect(); }
  });
  await t.test('battleback aliases supply the bitmap in the native spriteset graph', () => {
    const Type = scope.Spriteset_Battle, originalName = Type.prototype.battleback1Name;
    const load1 = scope.ImageManager.loadBattleback1, load2 = scope.ImageManager.loadBattleback2;
    const first = new scope.Bitmap(32, 32), second = new scope.Bitmap(32, 32), requested = [];
    Type.prototype.battleback1Name = function() { return 'Custom'; };
    scope.ImageManager.loadBattleback1 = name => { requested.push(name); return first; };
    scope.ImageManager.loadBattleback2 = () => second;
    try {
      const spriteset = new Type();
      assert.equal(spriteset._back1Sprite.bitmap, first); assert.equal(spriteset._back2Sprite.bitmap, second);
      assert.ok(requested.includes('Custom')); assert.equal(spriteset.battleback1Bitmap(), first);
      assert.equal(spriteset.battlerSprites().length, scope.$gameTroop.members().length + scope.$gameParty.maxBattleMembers());
      assert.equal(spriteset._battleField.children.includes(spriteset._back1Sprite), true);
    } finally {
      Type.prototype.battleback1Name = originalName; scope.ImageManager.loadBattleback1 = load1; scope.ImageManager.loadBattleback2 = load2;
    }
  });
  await t.test('animation timing applies flashes and restores a hidden native target', () => {
    const parent = new scope.Sprite(), target = new scope.Sprite(new scope.Bitmap(20, 20)), animation = new scope.Sprite_Animation();
    parent.addChild(target); parent.addChild(animation); target.x = 7; target.y = 19;
    animation._target = target; animation._animation = { position: 0 }; animation.updatePosition();
    assert.equal(animation.x, 7); assert.equal(animation.y, -1);
    animation.processTimingData({ flashDuration: 2, flashScope: 1, flashColor: [255, 0, 0, 80] }); animation.update();
    assert.equal(animation._flashDuration, 7); assert.deepEqual(Array.from(target.getBlendColor()), [255, 0, 0, 70]);
    animation.processTimingData({ flashDuration: 1, flashScope: 3 }); assert.equal(target.visible, false);
    for (let i = 0; i < 4; ++i) animation.update(); assert.equal(target.visible, true);
    animation.processTimingData({ flashDuration: 1, flashScope: 2, flashColor: [10, 20, 30, 120] });
    assert.equal(animation._screenFlashSprite.opacity, 120);
  });
  await t.test('selectable touch helpers hit native window rows and confirm the selected target', () => {
    const window = new scope.Window_Selectable(10, 20, 200, 120), touch = scope.TouchInput;
    let confirmed = 0; window.maxItems = () => 2; window.setHandler('ok', () => ++confirmed); window.activate(); window.select(0);
    const x = 10 + window.padding + 2, y = 20 + window.padding + window.lineHeight() + 2;
    try {
      touch._onTrigger(x, y); touch.update(); assert.equal(window.isTouchedInsideFrame(), true);
      window.processTouch(); assert.equal(window.index(), 1);
      touch._onTrigger(x, y); touch.update(); window.processTouch(); assert.equal(confirmed, 1);
      assert.equal(scope.Window_BattleActor.prototype.processTouch, scope.Window_Selectable.prototype.processTouch);
      assert.equal(scope.Window_BattleEnemy.prototype.isTouchedInsideFrame, scope.Window_Selectable.prototype.isTouchedInsideFrame);
    } finally { touch.clear(); }
  });
  await t.test('message helpers share native waits and clear the final input pause', () => {
    const message = new scope.Window_Message();
    scope.$gameMessage.add('Hello');
    try {
      message.startMessage(); assert.equal(message._textState.text, 'Hello'); assert.equal(message._textState.index, 0);
      message.startPause(); assert.equal(message.pause, true); assert.equal(message._waitCount, 10);
      assert.equal(message.updateWait(), true); assert.equal(message._waitCount, 9);
      message.pause = false;
    } finally { message.terminateMessage(); }
  });
  await t.test('shop windows use native prices and window tones without stale values', () => {
    const previousItems = scope.$dataItems, previousTone = Array.from(scope.$gameSystem.windowTone());
    const item = { id: 1, name: 'Potion', iconIndex: 0, price: 25, itypeId: 1 };
    const loadSystem = scope.ImageManager.loadSystem, icons = new scope.Bitmap(32, 32);
    scope.ImageManager.loadSystem = function(name, ...args) { return name === 'IconSet' ? icons : loadSystem.call(this, name, ...args); };
    scope.$dataItems = [null, item];
    try {
      const shop = new scope.Window_ShopBuy(0, 0, 200, [[0, 1, 1, 15], [0, 1, 1, 50]]);
      assert.equal(shop.price(item), 15); shop.setMoney(14); assert.equal(shop.isEnabled(item), false);
      const party = scope.$gameParty, gold = party.gold(), count = party.numItems(item), scene = new scope.Scene_Shop();
      scene._item = item; scene._buyWindow = shop;
      try {
        party.gainGold(100 - gold); scene.doBuy(2); assert.equal(party.gold(), 70); assert.equal(party.numItems(item), count + 2);
        scene.doSell(1); assert.equal(party.gold(), 82); assert.equal(party.numItems(item), count + 1);
      } finally { party.gainGold(gold - party.gold()); party.gainItem(item, count - party.numItems(item)); }

      shop.setMoney(15); assert.equal(shop.isEnabled(item), true); shop.select(1); assert.equal(shop.item(), item);
      const defaults = new scope.Window_ShopBuy(0, 0, 200, [[0, 1, 0, 0]]);
      assert.equal(defaults.price(item), 25);
      const window = new scope.Window_Base(0, 0, 100, 100);
      scope.$gameSystem.setWindowTone([12, -8, 20]); window.updateTone(); assert.deepEqual(Array.from(window._colorTone), [12, -8, 20]);
    } finally { scope.ImageManager.loadSystem = loadSystem; scope.$dataItems = previousItems; scope.$gameSystem.setWindowTone(previousTone); }
  });
  await t.test('savefile drawing dispatches aliases with current save metadata', () => {
    const manager = scope.DataManager, methods = ['maxSavefiles', 'isThisGameFile', 'loadSavefileInfo'];
    const originals = methods.map(method => manager[method]), draw = scope.Window_SavefileList.prototype.drawFileId, seen = [];
    manager.maxSavefiles = () => 2; manager.isThisGameFile = id => id === 1;
    manager.loadSavefileInfo = id => id === 1 ? { title: 'Saved game', playtime: '0:01', characters: [] } : null;
    scope.Window_SavefileList.prototype.drawFileId = function(id, x, y) { seen.push(id); return draw.call(this, id, x, y); };
    try {
      const window = new scope.Window_SavefileList(0, 0, 640, 300);
      assert.deepEqual(seen, [1, 2]); assert.equal(window.maxItems(), 2);
      const editor = new scope.Window_NameEdit(scope.$gameActors.actor(1), 12);
      assert.equal(editor.name(), 'Actor 1'); editor._name = 'Edited'; assert.equal(editor.name(), 'Edited');
      window.setMode('save'); seen.length = 0; window.refresh(); assert.deepEqual(seen, [1, 2]);
    } finally {
      methods.forEach((method, index) => { manager[method] = originals[index]; });
      scope.Window_SavefileList.prototype.drawFileId = draw;
    }
  });
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
  await t.test('unchanged child handles are reused and native reordering invalidates them', () => {
    const bindings = runtime.installScenes(), api = native.mvDisplay;
    const parent = new scope.Container(), first = new scope.Container(), second = new scope.Container(), other = new scope.Container();
    parent.addChild(first, second);
    const handle = bindings.displayHandle(parent), previous = api.children(handle);
    const list = parent.children;
    assert.equal(list[0], first);
    assert.equal(api.children(handle, previous), previous);
    api.invoke(handle, 'add', bindings.displayHandle(second), 0);
    assert.notEqual(api.children(handle, previous), previous);
    assert.equal(list[0], second);
    assert.equal(list[1], first);
    other.addChild(second);
    assert.equal(list.length, 1);
    assert.equal(list[0], first);
    assert.equal(second.parent, other);
    list.push(second);
    assert.equal(other.children.length, 0);
    assert.equal(list[1], second);
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
    const filter = new ColorMatrixFilter(),assigned=[filter]; stage.filters = assigned;
    const capture = () => {
      native.beginFrame(); scope.Graphics.render(stage); engine.present(session); native.renderFrame();
      return Array.from(native.canvas.captureSceneRawPremultiplied().subarray(0, 4));
    };
    try {
      assert.deepEqual(capture(), [80,40,120,255]);
      assert.notEqual(stage.filters,assigned);assert.notEqual(stage._filters,assigned);assert.notEqual(stage.filters,stage.filters);
      assigned.length=0;const copy=stage.filters;copy.length=0;assert.deepEqual(capture(),[80,40,120,255]);
      const raw=stage._filters;raw.length=0;assert.deepEqual(capture(),[40,80,120,255]);
      raw.push(filter);assert.deepEqual(capture(),[80,40,120,255]);
      stage._filters=assigned;assert.equal(stage._filters,assigned);assigned.push(filter);assert.deepEqual(capture(),[80,40,120,255]);
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
    } finally {for(const child of stage.children)child.filters=null;stage.filters=null;scope.PIXI = previousPixi;engine.scriptStage(session, null);}
  });
  await t.test('native display tree events expose actual ownership and WindowLayer removal overrides', () => {
    const first = new scope.Container(), second = new scope.Container(), child = new scope.Sprite();
    const events = [];
    child.emit = function(name,parent) {
      events.push([name,parent,this.parent,parent.children.includes(this)]); return true;
    };
    first.addChild(child); second.addChild(child); second.removeChild(child);
    assert.deepEqual(events,[['added',first,first,true],['removed',first,null,false],
      ['added',second,second,true],['removed',second,null,false]]);
    const failure = {eventFailure:true};
    child.emit = function() { throw failure; };
    assert.throws(() => first.addChild(child),error => error === failure); assert.equal(child.parent,first);
    assert.throws(() => first.removeChild(child),error => error === failure); assert.equal(child.parent,null);
    delete child.emit;
    const original = scope.WindowLayer.prototype.onRemoveAsAChild;
    let calls = 0, lateCalls = 0;
    scope.WindowLayer.prototype.onRemoveAsAChild = function() { ++calls; };
    try {
      const layer = new scope.WindowLayer(), content = new scope.Sprite();
      first.addChild(layer); layer.addChild(content);
      layer.onRemoveAsAChild = function() { ++lateCalls; };
      first.removeChild(layer);
      assert.equal(calls,1); assert.equal(lateCalls,0,'the removal listener retains its registered method');
      assert.equal(layer.children[0],content); assert.equal(content.parent,layer);
      original.call(layer); assert.equal(layer.children.length,0); assert.equal(content.parent,null);
      scope.WindowLayer.prototype.onRemoveAsAChild = function() { ++calls; original.call(this); };
      const aliased = new scope.WindowLayer(), sprite = new scope.Sprite();
      aliased.addChild(sprite); first.addChild(aliased); first.removeChild(aliased);
      assert.equal(calls,2); assert.equal(aliased.children.length,0); assert.equal(sprite.parent,null);
    } finally { scope.WindowLayer.prototype.onRemoveAsAChild = original; }
  });
  await t.test('window mask overrides and window classification control native overlap clearing', () => {
    const dimensions=['width','height','boxWidth','boxHeight'].map(name=>scope.Graphics[name]);
    scope.Graphics.initialize(32,32);
    const stage=new scope.Container(),background=new scope.ScreenSprite();background.setColor(0,0,255);background.opacity=255;stage.addChild(background);
    const layer=new scope.WindowLayer();layer.move(4,6,28,26);stage.addChild(layer);
    const first=new scope.Window(),second=new scope.Window();first.move(0,0,24,24);second.move(8,8,24,24);
    first.padding=0;first.contents=new scope.Bitmap(24,24);first.contents.fillAll('red');layer.addChild(first,second);
    const mask=layer._maskWindow;
    const capture=()=> {
      native.beginFrame();scope.Graphics.render(stage);engine.present(session);native.renderFrame();
      const offset=(12*scope.Graphics.width+12)*4;
      return Array.from(native.canvas.captureSceneRawPremultiplied().subarray(offset,offset+4));
    };
    try {
      assert.equal(second._isWindow,true);assert.deepEqual(capture(),[0,0,255,255]);
      layer._maskWindow=function(window,shift) {mask.call(this,window,shift);if(window===second)this._windowRect.width=0;};
      assert.deepEqual(capture(),[255,0,0,255]);
      const failure={maskFailure:true};layer._maskWindow=function() {throw failure;};
      assert.throws(capture,error=>error===failure);
      delete layer._maskWindow;assert.deepEqual(capture(),[0,0,255,255]);
      second._isWindow=false;assert.deepEqual(capture(),[255,0,0,255]);second._isWindow=true;
      layer._maskWindow=function(window,shift) {mask.call(this,window,shift);if(window===first)this.removeChild(window);};
      assert.deepEqual(capture(),[255,0,0,255]);assert.equal(first.parent,null);
    } finally {
      delete layer._maskWindow;engine.scriptStage(session,null);scope.Graphics.initialize(dimensions[0],dimensions[1]);
      scope.Graphics.boxWidth=dimensions[2];scope.Graphics.boxHeight=dimensions[3];
    }
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
      window._refreshAllParts();
      assert.deepEqual(capture(), [255,0,0,255]); assert.ok(calls > 0);
      const count = calls; capture(); assert.equal(calls, count, 'unchanged native windows reuse plugin-generated parts');
      window.width = 40; assert.deepEqual(capture(), [255,0,0,255]); assert.ok(calls > count);
      window._windowFrameSprite.bitmap.fillAll('#00ff00'); assert.deepEqual(capture(), [0,255,0,255]);
      window._animationCount = 17; assert.equal(window._animationCount, 17);
      window._colorTone[0] = 20; assert.equal(window._colorTone[0], 20);
    } finally { scope.Window.prototype._refreshFrame = original; engine.scriptStage(session, null); }
  });
  await t.test('window refresh callbacks follow reference assignment and constructor order', () => {
    const vm = require('node:vm');
    const source = fs.readFileSync(path.join(__dirname, '../third_party/rpg-maker-mv/rpg_core.js'), 'utf8');
    function ReferenceContainer() { this.children = []; }
    ReferenceContainer.prototype.addChild = function(child) { this.children.push(child); };
    function ReferenceSprite() { this.anchor = { x: 0, y: 0 }; }
    const reference = vm.createContext({ PIXI: { Container: ReferenceContainer },
      Sprite: ReferenceSprite, Bitmap: function() {}, Point: scope.Point, Rectangle: scope.Rectangle });
    vm.runInContext(source.slice(source.indexOf('function Window()'), source.indexOf('function WindowLayer()')), reference);
    function sequence(Type) {
      const names = ['_createAllParts','_refreshAllParts','_refreshCursor','_refreshBack'];
      const saved = new Map(names.map(name => [name, Type.prototype[name]]));
      const events = [];
      Type.prototype._createAllParts = function() {
        events.push('create'); saved.get('_createAllParts').call(this);
      };
      for (const name of names.slice(1)) Type.prototype[name] = function() { events.push(name); };
      try {
        const window = new Type();
        window.width = 32; window.width = 32; window.height = 32;
        window.padding = 4; window.margin = 2;
        window.move(3,4,32,32); window.move(3,4,40,32);
        window.setCursorRect(1.8,2.8,8.8,9.8); window.setCursorRect(1,2,8,9);
        window._cursorRect.x = 3;
        const previousTone = window._colorTone;
        window.setTone(1,2,3); window.setTone(1,2,3);
        events.push(previousTone !== window._colorTone, previousTone[0]);
        const cursor = window._cursorRect;
        window.setCursorRect(4,2,8,9); events.push(cursor === window._cursorRect,cursor.x);
        const replacement = new scope.Rectangle(5,6,7,8);
        window._cursorRect = replacement; events.push(window._cursorRect === replacement);
        return events;
      } finally { for (const [name, method] of saved) Type.prototype[name] = method; }
    }
    assert.deepEqual(sequence(scope.Window), sequence(reference.Window));
  });
  await t.test('window refresh suppression preserves existing native frame pixels', () => {
    const stage = new scope.Container(), window = new scope.Window();
    const skin = new scope.Bitmap(192,192); skin.fillAll('white');
    window.windowskin = skin; window.move(0,0,24,24); window.backOpacity = 0; stage.addChild(window);
    const original = scope.Window.prototype._refreshAllParts;
    let calls = 0;
    scope.Window.prototype._refreshAllParts = function() { ++calls; };
    const capture = () => {
      native.beginFrame(); scope.Graphics.render(stage); engine.present(session); native.renderFrame();
      const pixels = native.canvas.captureSceneRawPremultiplied();
      return Array.from(pixels.subarray(28*4,28*4+4));
    };
    try {
      window._width = 32; assert.equal(calls,0);
      assert.deepEqual(capture(),[0,0,0,255]);
      window.width = 32; assert.equal(calls,1);
      assert.deepEqual(capture(),[0,0,0,255]); assert.equal(calls,1);
      original.call(window);
      assert.equal(window._windowFrameSprite.bitmap.width,32);
      assert.equal(window._windowFrameSprite.bitmap.getPixel(28,2),'#ffffff');
      assert.deepEqual(capture(),[255,255,255,255]);
    } finally { scope.Window.prototype._refreshAllParts = original; engine.scriptStage(session,null); }
  });
  await t.test('sprite bitmap-load aliases and mutable color arrays reach native rendering', () => {
    const bitmap = new scope.Bitmap(32, 32); bitmap.fillAll('white');
    assert.ok(bitmap.rect instanceof scope.Rectangle); assert.equal(bitmap.rect.width,32);
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
  await t.test('native filter groups consume mutable alpha and authored shader passes', () => {
    const { installFilterCompiler } = require('../runner/native-filter-compiler.cjs');
    const previous = { PIXI: scope.PIXI, PMJS: scope.PMJS, NativeHost: scope.NativeHost };
    function AlphaFilter() { this.alpha = 0.5; }
    scope.PIXI = { filters: { AlphaFilter } };
    scope.PMJS = { config:{},rpgmaker: {}, compat: { hit() {} } };
    runtime.runScript(fs.readFileSync(path.join(__dirname,'../js/pmjs-core/optimizations.js'),'utf8'));
    scope.NativeHost = native;
    installFilterCompiler(runtime);
    const bitmap = new scope.Bitmap(4,4); bitmap.fillAll('red');
    const sprite = new scope.Sprite(bitmap), parent = new scope.Container(); parent.addChild(sprite);
    const capture = () => {
      native.beginFrame(); scope.Graphics.render(parent); engine.present(session); native.renderFrame();
      return Array.from(native.canvas.captureSceneRawPremultiplied().subarray(0,4));
    };
    try {
      const alpha = new AlphaFilter(); sprite.filters = [alpha];
      assert.ok(Math.abs(capture()[0]-128)<=1);
      alpha.alpha = 0.25; assert.ok(Math.abs(capture()[0]-64)<=1);
      parent.x = 3; sprite.x = 2;
      const bounds = sprite.getBounds(); assert.equal(bounds.x,5); assert.equal(bounds.width,4);
      parent.x = sprite.x = 0;
      const shader = { resolution:1,padding:0,uniforms:{},
        fragmentSrc:'precision mediump float; varying vec2 vTextureCoord; uniform sampler2D uSampler; void main(){vec4 c=texture2D(uSampler,vTextureCoord);gl_FragColor=vec4(0.0,c.r,0.0,c.a);}',
        apply(manager,input,output,clear) {manager.applyFilter(this,input,output,clear);} };
      sprite.filters = [shader]; assert.deepEqual(capture(),[0,255,0,255]);
      sprite.filters = null; assert.deepEqual(capture(),[255,0,0,255]);
    } finally {
      sprite.filters = null; engine.scriptStage(session,null);
      Object.assign(scope,previous);
    }
  });
  await t.test('Sprite render aliases dispatch into native drawing and honor suppressed rendering', () => {
    const bitmap=new scope.Bitmap(4,4);bitmap.fillAll('red');const sprite=new scope.Sprite(bitmap);
    const original=scope.Sprite.prototype._renderWebGL;let calls=0,canvasCalls=0;
    const capture=()=>{native.beginFrame();scope.Graphics.render(sprite);engine.present(session);native.renderFrame();return Array.from(native.canvas.captureSceneRawPremultiplied().subarray(0,4));};
    try {
      assert.deepEqual(capture(),[255,0,0,255]);
      scope.Sprite.prototype._renderWebGL=function(renderer) {++calls;this.bitmap.fillAll('green');original.call(this,renderer);};
      assert.deepEqual(capture(),[0,128,0,255]);assert.equal(calls,1);
      sprite._renderWebGL=function() {};assert.deepEqual(capture(),[0,0,0,255]);
      delete sprite._renderWebGL;assert.deepEqual(capture(),[0,128,0,255]);assert.equal(calls,2);
      scope.Sprite.prototype._renderWebGL=original;bitmap.fillAll('red');
      sprite._renderCanvas=function() {++canvasCalls;};assert.deepEqual(capture(),[255,0,0,255]);assert.equal(canvasCalls,0);
      sprite._renderWebGL=function() {throw new Error('sprite render override failed');};assert.throws(capture,/sprite render override failed/);
      delete sprite._renderWebGL;assert.deepEqual(capture(),[255,0,0,255]);
    } finally {scope.Sprite.prototype._renderWebGL=original;delete sprite._renderWebGL;delete sprite._renderCanvas;engine.scriptStage(session,null);}
  });
  await t.test('tiling render aliases and blend preparation control native drawing', () => {
    const bitmap = new scope.Bitmap(2,2); bitmap.fillAll('red');
    const sprite = new scope.TilingSprite(bitmap); sprite.move(0,0,8,8);
    const render = sprite._renderWebGL_PIXI;
    let aliases = 0, preparations = 0;
    const capture = () => {
      native.beginFrame(); scope.Graphics.render(sprite); engine.present(session); native.renderFrame();
      return Array.from(native.canvas.captureSceneRawPremultiplied().subarray(0,4));
    };
    try {
      assert.equal(sprite.pluginName,'picture'); assert.deepEqual(capture(),[255,0,0,255]);
      sprite._renderWebGL_PIXI = function(renderer) { ++aliases; bitmap.fillAll('blue'); render.call(this,renderer); };
      sprite._speedUpCustomBlendModes = function() { ++preparations; };
      assert.deepEqual(capture(),[0,0,255,255]); assert.equal(aliases,1); assert.equal(preparations,1);
      sprite._renderWebGL_PIXI = function() {};
      assert.deepEqual(capture(),[0,0,0,255]);
      delete sprite._renderWebGL_PIXI; delete sprite._speedUpCustomBlendModes;
      bitmap.fillAll('red'); assert.deepEqual(capture(),[255,0,0,255]);
    } finally { delete sprite._renderWebGL_PIXI; delete sprite._speedUpCustomBlendModes; engine.scriptStage(session,null); }
  });
  await t.test('sprite object renderers and vertex overrides control native pixels', () => {
    const bitmap=new scope.Bitmap(4,4);bitmap.fillAll('red');const sprite=new scope.Sprite(bitmap);
    const renderer=scope.Graphics._renderer,batch=renderer.plugins.sprite,render=batch.render,calculate=sprite.calculateVertices;
    const capture=()=> {native.beginFrame();scope.Graphics.render(sprite);engine.present(session);native.renderFrame();return native.canvas.captureSceneRawPremultiplied();};
    const pixel=(pixels,x,y=0)=>Array.from(pixels.subarray((y*scope.Graphics.width+x)*4,(y*scope.Graphics.width+x)*4+4));
    try {
      assert.equal(renderer.type,1);assert.equal(renderer.width,scope.Graphics.width);
      batch.render=function(object) {object.bitmap.fillAll('blue');render.call(this,object);};
      assert.deepEqual(pixel(capture(),0),[0,0,255,255]);
      batch.render=function() {};assert.deepEqual(pixel(capture(),0),[0,0,0,255]);
      batch.render=render;bitmap.fillAll('red');
      Object.defineProperty(sprite,'_renderWebGL',{configurable:true,writable:true,value:function(renderer) {
        this.calculateVertices();renderer.setObjectRenderer(renderer.plugins[this.pluginName]);renderer.plugins[this.pluginName].render(this);
      }});
      assert.deepEqual(pixel(capture(),0),[255,0,0,255]);delete sprite._renderWebGL;
      sprite.calculateVertices=function() {calculate.call(this);for(let i=0;i<8;i+=2)this.vertexData[i]+=6;};
      let pixels=capture();assert.deepEqual(pixel(pixels,0),[0,0,0,255]);assert.deepEqual(pixel(pixels,6),[255,0,0,255]);
      assert.ok(sprite.vertexData instanceof runtime.runScript('Float32Array'));
      sprite.calculateVertices=function() {calculate.call(this);this.vertexData[0]+=2;};
      pixels=capture();assert.deepEqual(pixel(pixels,0),[0,0,0,255]);assert.deepEqual(pixel(pixels,0,3),[255,0,0,255]);
      delete sprite.calculateVertices;
      const original=scope.Sprite.prototype._renderWebGL;
      sprite._renderWebGL=function(renderer) {this.x+=5;original.call(this,renderer);};
      assert.deepEqual(pixel(capture(),0),[255,0,0,255]);assert.equal(sprite.x,5);
      assert.deepEqual(pixel(capture(),5),[255,0,0,255]);assert.equal(sprite.x,10);
      sprite.x=0;sprite._renderWebGL=function(renderer) {original.call(this,renderer);};
      const parent=new scope.Container();parent.x=8;parent.addChild(sprite);
      const snapshot=scope.Bitmap.snap(sprite);assert.equal(snapshot.getPixel(0,0),'#ff0000');assert.equal(snapshot.getAlphaPixel(8,0),0);
      parent.removeChild(sprite);delete sprite._renderWebGL;
      let custom=0;const plugin={render(object) {++custom;render.call(batch,object);}};
      renderer.plugins.custom=plugin;sprite.pluginName='custom';assert.equal(renderer.plugins.custom,plugin);
      assert.deepEqual(pixel(capture(),0),[255,0,0,255]);assert.equal(custom,1);
      sprite.pluginName='missing';assert.throws(capture,/Unsupported sprite object renderer: missing/);
    } finally {batch.render=render;delete renderer.plugins.custom;delete sprite._renderWebGL;delete sprite.calculateVertices;sprite.pluginName='sprite';engine.scriptStage(session,null);}
  });
  await t.test('Sprite texture frames and saved tint hooks control native pixels', () => {
    const { installSpriteTextures } = require('../runner/native-sprite-textures.cjs');
    const textureSession=engine.create(fixture([]));
    try {
      engine.attach(textureSession,{width:32,height:32,fontFile:'font.ttf'});
      const textureRuntime=createScriptRuntime(engine,textureSession,{native}), display=textureRuntime.installScenes(), guest=textureRuntime.scope;
      function BaseTexture(source) {this.source=source;this._updateID=0;this.width=source?.width||0;this.height=source?.height||0;}
      BaseTexture.prototype.update=function() {++this._updateID;this.width=this.source?.width||this.width;this.height=this.source?.height||this.height;};
      BaseTexture.prototype.emit=function() {};
      function Texture(baseTexture) {this.baseTexture=baseTexture;this.frame=new guest.Rectangle();this._updateID=0;}
      guest.PIXI={BaseTexture,Texture,SCALE_MODES:{NEAREST:0,LINEAR:1}};guest.Bitmap.bindPixi(guest.PIXI);
      installSpriteTextures(textureRuntime,display);
      const bitmap=new guest.Bitmap(4,4);bitmap.fillAll('red');bitmap.fillRect(2,0,2,4,'blue');
      const sprite=new guest.Sprite(bitmap);
      const capture=()=>{native.beginFrame();guest.Graphics.render(sprite);engine.present(textureSession);native.renderFrame();return Array.from(native.canvas.captureSceneRawPremultiplied().subarray(0,4));};
      assert.deepEqual(capture(),[255,0,0,255]);
      assert.ok(sprite.texture instanceof Texture);assert.equal(sprite._realFrame.width,4);
      sprite.texture.frame=new guest.Rectangle(2,0,2,4);assert.deepEqual(capture(),[0,0,255,255]);
      const replacement=new guest.Bitmap(4,4);replacement.fillAll('green');
      sprite.texture.baseTexture=replacement.baseTexture;assert.deepEqual(capture(),[0,128,0,255]);
      sprite.texture.baseTexture=bitmap.baseTexture;sprite.texture.frame=new guest.Rectangle(0,0,4,4);
      sprite.texture.orig=new guest.Rectangle(0,0,4,4);sprite.texture.rotate=2;
      assert.deepEqual(capture(),[0,0,255,255]);
      sprite.texture.rotate=0;sprite.texture.frame=new guest.Rectangle(2,0,2,4);sprite.texture.trim=new guest.Rectangle(1,1,2,4);
      assert.deepEqual(capture(),[0,0,0,255]);sprite.x=sprite.y=-1;assert.deepEqual(capture(),[0,0,255,255]);sprite.x=sprite.y=0;
      sprite.texture.trim=null;sprite.texture.orig=null;sprite.texture.frame=new guest.Rectangle(0,0,2,2);sprite.texture.baseTexture.resolution=2;
      assert.deepEqual(capture(),[255,0,0,255]);
      const scaled=native.canvas.captureSceneRawPremultiplied();assert.deepEqual(Array.from(scaled.subarray(4,8)),[0,0,255,255]);assert.deepEqual(Array.from(scaled.subarray(8,12)),[0,0,0,255]);
      sprite.texture.baseTexture.resolution=1;
      let tintCalls=0;
      sprite._createTinter=function() {this._tintTexture=replacement.baseTexture;};
      sprite._executeTint=function() {++tintCalls;replacement.fillAll('#ff00ff');};
      sprite.setColorTone([20,0,0,0]);assert.ok(tintCalls>0);assert.deepEqual(capture(),[255,0,255,255]);
      sprite._colorTone[0]=40;assert.ok(tintCalls>1);assert.deepEqual(capture(),[255,0,255,255]);
      assert.equal(sprite.bitmap,bitmap);
    } finally {engine.dispose(textureSession);}
  });
  await t.test('map tilesets compare authored identity across native calls and reload replacements', () => {
    const data = fixture([]);
    data.maps[1].events = [null];
    data.tilesets[1] = { flags: [0], tilesetNames: [] };
    const mapSession = engine.create(data);
    try {
      engine.databaseInvoke(mapSession, 'publish', { tilesets: data.tilesets });
      engine.attach(mapSession, { width: 32, height: 32, fontFile: 'font.ttf' });
      const r = createScriptRuntime(engine, mapSession, { native }); r.installScenes();
      r.scope.$dataMap = data.maps[1]; r.scope.$dataTilesets = data.tilesets;
      engine.newGame(mapSession); engine.playerTransfer(mapSession, 'perform');
      const set = new r.scope.Spriteset_Map();
      const original = set.loadTileset; let loads = 0;
      set.loadTileset = function() { ++loads; return original.call(this); };
      for (let i = 0; i < 5; ++i) set.updateTileset();
      assert.equal(loads, 0);
      assert.equal(set._tileset, data.tilesets[1]);
      data.tilesets[1] = { flags: [1], tilesetNames: [] };
      set.updateTileset(); assert.equal(loads, 1);
      assert.equal(set._tileset, data.tilesets[1]);
      set.updateTileset(); assert.equal(loads, 1);
      data.tilesets[1].flags[0] = 2;
      set.updateTileset(); assert.equal(loads, 1, 'in-place edits preserve stock object identity');
      set.loadTileset(); assert.equal(loads, 2, 'authored explicit reloads still execute');
    } finally { engine.dispose(mapSession); }
  });
  await t.test('engine tilemap mutations control native map data, origin, dimensions and bitmap ownership', async () => {
    const mapData=fixture([]);mapData.system.startX=0;mapData.system.startY=0;mapData.maps[1].width=2;mapData.maps[1].height=1;
    mapData.maps[1].data=[0,1,...Array(10).fill(0)];mapData.maps[1].events=[null];
    mapData.tilesets[1]={flags:[0,0],tilesetNames:['','','','','','Parity','','','']};
    const mapSession=engine.create(mapData);
    try {
      engine.attach(mapSession,{width:32,height:32,fontFile:'font.ttf'});
      const r=createScriptRuntime(engine,mapSession,{native});r.installScenes();
      r.scope.$dataMap=r.runScript('('+JSON.stringify(mapData.maps[1])+')');
      r.scope.$dataTilesets=r.runScript('('+JSON.stringify(mapData.tilesets)+')');
      engine.newGame(mapSession);engine.playerTransfer(mapSession,'perform');
      const scene=new r.scope.Scene_Map();scene.createSpriteset();
      const tilemap=scene._spriteset._tilemap;
      assert.equal(tilemap.parent,scene._spriteset._baseSprite);
      assert.ok(tilemap instanceof r.scope.ShaderTilemap);
      assert.equal(tilemap.bitmaps[5],r.scope.ImageManager.loadTileset('Parity'));
      for(let i=0;i<100&&!tilemap.bitmaps[5].isReady();++i) {r.scope.ImageManager.update();await new Promise(resolve=>setTimeout(resolve,10));}
      assert.equal(tilemap.bitmaps[5].isReady(),true);
      const capture=()=> {native.beginFrame();r.scope.Graphics.render(scene);engine.present(mapSession);native.renderFrame();return Array.from(native.canvas.captureSceneRawPremultiplied().subarray(0,4));};
      tilemap.origin.x=0;tilemap.origin.y=0;assert.deepEqual(capture(),[0,0,0,255]);
      tilemap.origin.x=48;assert.deepEqual(capture(),[255,0,0,255]);
      tilemap.setData(1,1,r.runScript('[1,0,0,0,0,0]'));tilemap.origin.x=0;tilemap.refresh();
      assert.deepEqual(capture(),[255,0,0,255]);
      tilemap.tileWidth=24;assert.deepEqual(capture(),[0,0,255,255]);
      const green=new r.scope.Bitmap(96,48);green.fillAll('#00ff00');tilemap.bitmaps[5]=green;tilemap.refreshTileset();
      assert.deepEqual(capture(),[0,255,0,255]);
      tilemap.origin.x=24;assert.deepEqual(capture(),[0,0,0,255]);
      tilemap.horizontalWrap=true;tilemap.refresh();assert.deepEqual(capture(),[0,255,0,255]);
      green.fillAll('#ff00ff');tilemap.refreshTileset();assert.deepEqual(capture(),[255,0,255,255]);
      const player=scene._spriteset._characterSprites.find(sprite=>sprite._character===r.scope.$gamePlayer);
      player.bitmap=new r.scope.Bitmap(4,4);player.bitmap.fillAll('#00ff00');player.setFrame(0,0,4,4);player.anchor.set(0,0);player.position.set(0,0);
      scene._spriteset._baseSprite.x=5;capture();const baseline=Buffer.from(native.canvas.captureSceneRawPremultiplied());
      assert.deepEqual(Array.from(baseline.subarray(5*4,6*4)),[0,255,0,255]);
      const render=player._renderWebGL;player._renderWebGL=function(renderer) {render.call(this,renderer);};
      capture();const aliased=Buffer.from(native.canvas.captureSceneRawPremultiplied());
      assert.deepEqual(Array.from(aliased.subarray(5*4,6*4)),[0,255,0,255],'an alias must preserve native map transforms');
      assert.deepEqual(aliased,baseline);
      scene._spriteset._baseSprite.x=0;
      const red=new r.scope.Sprite(new r.scope.Bitmap(4,4)),greenSprite=new r.scope.Sprite(green);
      red.bitmap.fillAll('#ff0000');greenSprite.setFrame(0,0,4,4);green.fillAll('#00ff00');
      red.z=99;greenSprite.z=99;red.spriteId=10;greenSprite.spriteId=-2;
      tilemap.addChild(red,greenSprite);assert.deepEqual(capture(),[255,0,0,255]);
      red.spriteId=-3;assert.deepEqual(capture(),[0,255,0,255]);
      tilemap._compareChildOrder=(a,b)=>a.z-b.z||b.spriteId-a.spriteId;
      assert.deepEqual(capture(),[255,0,0,255]);
      tilemap._sortChildren=function() {this.children.reverse();};
      assert.deepEqual(capture(),[0,255,0,255]);
      delete tilemap._sortChildren;delete tilemap._compareChildOrder;
      assert.deepEqual(capture(),[0,255,0,255]);
    } finally {engine.dispose(mapSession);}
  });
  await t.test('constructed tilemaps render native bitmaps and dispatch drawing and classification overrides', async () => {
    const sheet = scope.ImageManager.loadTileset('Parity');
    for (let attempt=0;attempt<100 && !sheet.isReady();++attempt) { scope.ImageManager.update(); await new Promise(resolve => setTimeout(resolve,5)); }
    assert.equal(sheet.isReady(), true);
    for (const Type of [scope.Tilemap, scope.ShaderTilemap]) {
      const tilemap = new Type();
      tilemap.bitmaps[5] = sheet; tilemap.flags[1] = 0;
      tilemap.setData(1, 1, runtime.runScript('[1,0,0,0,0,0]')); tilemap.update();
      const capture = () => {
        native.beginFrame(); scope.Graphics.render(tilemap); engine.present(session); native.renderFrame();
        return Array.from(native.canvas.captureSceneRawPremultiplied().subarray(0, 4));
      };
      try {
        assert.deepEqual(capture(), [255,0,0,255], Type.name);
        const blocker = new scope.Sprite(new scope.Bitmap(32, 32)); blocker.bitmap.fillAll('white'); blocker.z = 3;
        tilemap.addChild(blocker); assert.deepEqual(capture(), [255,255,255,255]);
        tilemap._isHigherTile = id => id === 1; tilemap.refresh(); for(let frame=0;frame<30;++frame)tilemap.update(); assert.deepEqual(capture(), [255,0,0,255]);
        tilemap.removeChild(blocker);
        const draw = tilemap._drawTile;
        tilemap._drawTile = function(layer, id, x, y) {
          draw.call(this, layer, id, x, y);
          if (id === 1) { if (layer.addRect) layer.addRect(5,0,0,x,y,48,48); else layer.bltImage(sheet,0,0,48,48,x,y); }
        };
        tilemap.refresh(); for(let frame=0;frame<30;++frame)tilemap.update(); assert.deepEqual(capture(), [0,0,255,255]);
        tilemap._readMapData = () => 0; for(let frame=0;frame<30;++frame)tilemap.update(); assert.deepEqual(capture(), [0,0,0,255]);
      } finally { engine.scriptStage(session, null); }
    }
  });
  await t.test('weather particles consume guest randomness and dispatch mutable particle hooks', () => {
    const vm = require('node:vm');
    const source = fs.readFileSync(path.join(__dirname, '../third_party/rpg-maker-mv/rpg_core.js'), 'utf8');
    const reference = vm.createContext({ PIXI: { Container: function() { this.children = []; } },
      Graphics: scope.Graphics, Point: scope.Point, Bitmap: scope.Bitmap, ScreenSprite: scope.ScreenSprite, Sprite: scope.Sprite });
    reference.PIXI.Container.prototype.addChild = function(child) { this.children.push(child); };
    reference.PIXI.Container.prototype.removeChild = function(child) { this.children.splice(this.children.indexOf(child), 1); };
    vm.runInContext(source.slice(source.indexOf('function Weather()'), source.indexOf('function ToneFilter()')), reference);
    vm.runInContext('Math.randomInt = n => Math.floor(n * 0.25)', reference);
    const original = runtime.runScript('Math.randomInt');
    runtime.runScript('Math.randomInt = n => Math.floor(n * 0.25)');
    try {
      const actual = new scope.Weather(), expected = new reference.Weather();
      actual.power = expected.power = 0.2; actual.origin.set(7, 11); expected.origin.set(7, 11);
      for (const type of ['rain', 'storm', 'snow', 'none']) {
        actual.type = expected.type = type;
        for (let frame = 0; frame < 4; ++frame) {
          actual.update(); expected.update();
          assert.equal(actual._sprites.length, expected._sprites.length);
          actual._sprites.forEach((sprite, i) => {
            for (const field of ['ax', 'ay', 'x', 'y', 'rotation', 'opacity']) assert.equal(sprite[field], expected._sprites[i][field]);
          });
        }
      }
      assert.equal(actual._sprites[0].bitmap, actual._snowBitmap);
      actual.type = 'rain'; let updates = 0;
      const update = actual._updateRainSprite;
      actual._updateRainSprite = function(sprite) { ++updates; update.call(this, sprite); sprite.ax = 21; };
      actual.update(); assert.equal(updates, 2); assert.equal(actual._sprites[0].x, 14);
      actual._rainBitmap.fillAll('red'); assert.equal(actual._sprites[0].bitmap.getPixel(0, 0), '#ff0000');
      actual.power = 0; actual.update(); assert.equal(actual._sprites.length, 0);
    } finally { runtime.scope.__savedRandomInt = original; runtime.runScript('Math.randomInt = __savedRandomInt'); delete runtime.scope.__savedRandomInt; }
  });
  await t.test('Input gamepad mutations and array replacement match the reference', () => {
    const vm = require('node:vm');
    const source = fs.readFileSync(path.join(__dirname, '../third_party/rpg-maker-mv/rpg_core.js'), 'utf8');
    const reference = vm.createContext({});
    vm.runInContext(source.slice(source.indexOf('function Input()'),source.indexOf('function TouchInput()')),reference);
    const pad = { index: 0, connected: true, buttons: [{ pressed: true }], axes: [0,0] };
    function sequence(input) {
      input.clear(); const states = input._gamepadStates, result = [];
      input._updateGamepadState(pad); result.push(input.isPressed('ok'));
      const buttons = states[0]; input._currentState.ok = false;
      input._updateGamepadState(pad); result.push(input.isPressed('ok'),states[0]===buttons);
      buttons[0] = false; input._updateGamepadState(pad); result.push(input.isPressed('ok'));
      states[0][0] = false; input._updateGamepadState(pad); result.push(input.isPressed('ok'));
      const replacement = [[false]]; input._gamepadStates = replacement;
      input._currentState.ok = false; input._updateGamepadState(pad);
      result.push(input.isPressed('ok'),input._gamepadStates===replacement);
      input.clear(); states[0][0] = false;
      result.push(input._gamepadStates===states,states.length);
      return result;
    }
    try { assert.deepEqual(sequence(scope.Input),sequence(reference.Input)); }
    finally { scope.Input.clear(); }
  });
  await t.test('native bitmap failures use replaceable guest ResourceHandler callbacks and retries', () => {
    const resources=scope.ResourceHandler, factory=resources.createLoader, intervals=resources._defaultRetryInterval, timeout=scope.setTimeout;
    const timers=[],created=[];
    scope.setTimeout=(callback,delay)=>{timers.push({callback,delay});return timers.length;};
    resources._defaultRetryInterval=runtime.runScript('[2]');
    resources.createLoader=function(url,...args) {created.push(url);return factory.call(this,url,...args);};
    try {
      const bitmap=scope.Bitmap.load('img/system/Retry.png');let loaded=0;bitmap.addLoadListener(()=>++loaded);
      assert.equal(bitmap.getAlphaPixel(0,0),0);
      scope.ImageManager.update();assert.deepEqual(created,['img/system/Retry.png']);assert.equal(timers[0].delay,2);
      assert.equal(bitmap.isError(),false);timers.shift().callback();
      assert.equal(bitmap.isError(),true);assert.equal(resources.exists(),true);assert.equal(resources._reloaders.length,1);
      fs.writeFileSync(path.join(root,'img/system/Retry.png'),png(1,1,[0,255,0,255]));
      scope.Input._onKeyDown({keyCode:13,preventDefault(){}});
      scope.ImageManager.update();assert.equal(bitmap.isReady(),true);assert.equal(bitmap.getPixel(0,0),'#00ff00');
      assert.equal(loaded,1);assert.equal(resources.exists(),false);assert.equal(resources._reloaders.length,0);
    } finally {
      resources.createLoader=factory;resources._defaultRetryInterval=intervals;resources._reloaders.length=0;
      scope.setTimeout=timeout;scope.SceneManager.resume();scope.Input.clear();
    }
  });
  await t.test('native retry callbacks do not retain collected script sessions', {skip:!global.gc}, async () => {
    function transient() {
      const temporarySession=engine.create(fixture([]));engine.attach(temporarySession,{width:32,height:32,fontFile:'font.ttf'});
      const temporaryRuntime=createScriptRuntime(engine,temporarySession,{native});temporaryRuntime.installScenes();
      temporaryRuntime.scope.setTimeout=()=>0;
      temporaryRuntime.scope.ImageManager.loadSystem('Window');temporaryRuntime.scope.ImageManager.update();
      return {session:new WeakRef(temporarySession),runtime:new WeakRef(temporaryRuntime)};
    }
    const references=transient();
    for(let attempt=0;attempt<20;++attempt) {
      await new Promise(resolve=>setImmediate(resolve));global.gc();await new Promise(resolve=>setImmediate(resolve));
      if(!references.session.deref()&&!references.runtime.deref())break;
    }
    assert.equal(references.session.deref(),undefined);assert.equal(references.runtime.deref(),undefined);
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
      const scene=new scope.Scene_Base();scene.createWindowLayer();
      assert.equal(scene._windowLayer.x,(stock.width-stock.boxWidth)/2);assert.equal(scene._windowLayer.y,(stock.height-stock.boxHeight)/2);
      const marker=new scope.Window();marker.padding=0;marker.move(0,0,8,8);marker.opacity=0;
      marker.contents=new scope.Bitmap(8,8);marker.contents.fillAll('#00ff00');scene.addWindow(marker);
      native.beginFrame();graphics.render(scene);engine.present(session);native.renderFrame();
      const pixels=native.canvas.captureSceneRawPremultiplied(),offset=(((stock.height-stock.boxHeight)/2+4)*stock.width+(stock.width-stock.boxWidth)/2+4)*4;
      assert.deepEqual(Array.from(pixels.subarray(offset,offset+4)),[0,255,0,255]);
      assert.deepEqual(Array.from(pixels.subarray(0,4)),[0,0,0,255]);engine.scriptStage(session,null);
      stock.initialize(); graphics.initialize();
      for (const name of ['width', 'height', 'boxWidth', 'boxHeight']) assert.equal(graphics[name], stock[name]);
    } finally {engine.scriptStage(session,null);graphics.initialize(32, 32);}
  });
  await t.test('Graphics resize overrides and scale control native surfaces and coordinate conversion', () => {
    const vm=require('node:vm'),graphics=scope.Graphics,update=graphics._updateAllElements,realScale=graphics._updateRealScale;
    const source=fs.readFileSync(path.join(__dirname,'../third_party/rpg-maker-mv/rpg_core.js'),'utf8');
    const size=native.runtime.windowState(),reference=vm.createContext({document:{},window:{innerWidth:size.width,innerHeight:size.height}});
    vm.runInContext(source.slice(source.indexOf('function Graphics()'),source.indexOf('function Input()')),reference);
    const pixelRatio=native.render.presentation().drawableWidth/size.width;
    let calls=0;
    try {
      graphics.initialize(32,32);graphics._updateAllElements=function() {++calls;};
      graphics.width=40;graphics.width=40;graphics.scale=1.5;
      assert.equal(calls,2);assert.equal(graphics._width,40);assert.equal(graphics._scale,1.5);
      assert.equal(native.render.presentation().sourceWidth,32,'an override may defer the logical surface resize');
      graphics._stretchEnabled=false;update.call(graphics);
      assert.equal(native.render.presentation().sourceWidth,40);assert.equal(native.render.presentation().viewportWidth,Math.round(60*pixelRatio));
      assert.equal(graphics._realScale,1.5);assert.equal(graphics.boxWidth,32);
      assert.equal(graphics.pageToCanvasX((size.width-40*1.5)/2+9),6);
      graphics._updateRealScale=function() {this._realScale=2;};update.call(graphics);
      assert.equal(native.render.presentation().viewportWidth,Math.round(80*pixelRatio));assert.equal(graphics._realScale,2);
      const stage=new scope.Container();native.beginFrame();graphics.render(stage);engine.present(session);native.renderFrame();
      assert.equal(graphics._realScale,2,'ordinary service updates preserve the overridden scale');
      assert.equal(native.render.presentation().viewportWidth,Math.round(80*pixelRatio));engine.scriptStage(session,null);
      graphics._updateRealScale=realScale;graphics._updateAllElements=update;
      const stock=reference.Graphics;
      for(const stretch of [false,true]) {
        stock._width=40;stock._height=32;stock._scale=1.5;stock._stretchEnabled=stretch;stock._updateRealScale();
        graphics._stretchEnabled=stretch;graphics._updateAllElements();assert.equal(graphics._realScale,stock._realScale);
      }
    } finally {graphics._updateAllElements=update;graphics._updateRealScale=realScale;graphics.initialize(32,32);}
  });
  await t.test('Graphics dimensions also update native map scrolling limits', () => {
    const data=fixture([]);Object.assign(data.maps[1],{width:10,height:10,scrollType:0,data:Array(10*10*6).fill(0)});
    const mapSession=engine.create(data);
    try {
      engine.attach(mapSession,{width:32,height:32,fontFile:'font.ttf'});
      const r=createScriptRuntime(engine,mapSession,{native});r.installScenes();engine.newGame(mapSession);engine.playerTransfer(mapSession,'perform');
      r.scope.Graphics.width=96;r.scope.Graphics.height=144;
      r.scope.$gameMap.setDisplayPos(999,999);
      assert.equal(r.scope.$gameMap.displayX(),8);assert.equal(r.scope.$gameMap.displayY(),7);
    } finally {engine.dispose(mapSession);scope.Graphics.initialize(32,32);}
  });
  await t.test('Input dictionaries retain assigned objects and detach cleared state', () => {
    const input = scope.Input, mapper = input.keyMapper;
    assert.equal(runtime.runScript('Input instanceof Function && TouchInput instanceof Function'),true);
    assert.throws(() => new input(),/static class/); assert.throws(() => new scope.TouchInput(),/static class/);
    input.clear();
    try {
      const current = runtime.runScript('({right: "synthetic"})');
      const previous = runtime.runScript('({})');
      const customMapper = runtime.runScript('({65: "custom"})');
      input._currentState = current; input._previousState = previous; input.keyMapper = customMapper;
      assert.equal(input._currentState,current); assert.equal(input._previousState,previous);
      assert.equal(input.keyMapper,customMapper); assert.equal(input.isPressed('right'),true);
      input._onKeyDown({keyCode:65}); input.update();
      assert.equal(input._currentState,current); assert.equal(input._previousState,previous);
      assert.equal(input.isPressed('custom'),true); assert.equal(input.isTriggered('custom'),true);
      assert.equal(previous.right,'synthetic');
      current.right = 'changed'; input.update(); assert.equal(previous.right,'changed');
      input._onKeyUp({keyCode:65}); input.update(); assert.equal(input.isPressed('custom'),false);
      input.clear(); assert.notEqual(input._currentState,current); assert.notEqual(input._previousState,previous);
      current.ok = true; previous.ok = false;
      assert.equal(input.isPressed('ok'),false);
      assert.equal(Object.getPrototypeOf(input._currentState),runtime.runScript('Object.prototype'));
      assert.equal(input.keyMapper,customMapper,'clear preserves the assigned mapper');
    } finally { input.keyMapper = mapper; input.clear(); }
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
  await t.test('ScreenSprite legacy anchor access resets native scaling and sets opacity', () => {
    const sprite = new scope.ScreenSprite(), warning = scope.ScreenSprite.warnYep;
    let warnings = 0; scope.ScreenSprite.warnYep = function() { ++warnings; };
    try {
      sprite.scale.set(2,3); const anchor = sprite.anchor;
      assert.equal(anchor.x,0); assert.equal(anchor.y,0); assert.equal(sprite.scale.x,1); assert.equal(sprite.scale.y,1);
      assert.notEqual(sprite.anchor,anchor); assert.equal(warnings,2);
      sprite.setWhite(); sprite.anchor = 128; assert.equal(sprite.opacity,128);
      native.beginFrame(); scope.Graphics.render(sprite); engine.present(session); native.renderFrame();
      assert.deepEqual(Array.from(native.canvas.captureSceneRawPremultiplied().subarray(0,4)),[128,128,128,255]);
    } finally { scope.ScreenSprite.warnYep = warning; engine.scriptStage(session,null); }
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
  await t.test('plugin input dictionaries and latest-button queries use reference state identity', () => {
    const input = scope.Input;
    input.clear(); const state = input._currentState; assert.equal(input._latestButton, null);
    state.ok = true; assert.equal(input.isPressed('ok'), true);
    input._latestButton = 'ok'; assert.equal(input._latestButton, 'ok'); assert.equal(input.isTriggered('ok'), true);
    assert.equal(state[input._latestButton], true);
    const replacement = { cancel: true }; input._currentState = replacement;
    assert.equal(input._currentState, replacement);
    assert.equal(input.isPressed('ok'), false); assert.equal(input.isPressed('cancel'), true);
    delete replacement.cancel; assert.equal(input.isPressed('cancel'), false);
    input.clear(); assert.equal(state.ok, true); assert.notEqual(input._currentState,replacement);
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
  await t.test('window backgrounds use native dimmer pixels and track openness', () => {
    const window = new scope.Window_Base(0, 0, 80, 80);
    window.setBackgroundType(1);
    const dimmer = window._dimmerSprite;
    assert.equal(window.opacity, 0); assert.equal(dimmer.parent, window);
    assert.equal(dimmer.bitmap.getAlphaPixel(40, 40), 153);
    window.openness = 128; window.update(); assert.equal(dimmer.opacity, 128);
    window.setBackgroundType(2); assert.equal(dimmer.visible, false);
    window.setBackgroundType(0); assert.equal(window.opacity, 255);
    window.setBackgroundType(1); assert.equal(window._dimmerSprite, dimmer);
  });
  await t.test('selectable scrolling, selection and help use the live native window', () => {
    const window = new scope.Window_Selectable(0, 0, 240, 144);
    window.maxItems = () => 20;
    window.drawItem = () => {};
    let refreshes = 0;
    const refresh = window.refresh;
    window.refresh = function() { ++refreshes; refresh.call(this); };
    assert.equal(window.maxTopRow(), 17);
    window.setTopRow(99); assert.equal(window.topRow(), 17);
    window.setTopRow(17); assert.equal(refreshes, 1);
    window.setBottomRow(4); assert.equal(window.topRow(), 2);
    window.resetScroll(); assert.equal(window.topRow(), 0);
    window.setCursorAll(true); assert.equal(window.cursorAll(), true);
    const help = new scope.Window_Help();
    window.setHelpWindow(help);
    window.setHelpWindowItem({ description: 'Plugin item description' });
    assert.equal(help._text, 'Plugin item description');
    window.setHelpWindowItem(null); assert.equal(help._text, '');
  });
  await t.test('item windows return the original database entry selected in the native model', () => {
    const previous = scope.$dataItems; scope.$dataItems = data.items;
    try {
      scope.$gameParty.gainItem(data.items[1], 1);
      const window = new scope.Window_ItemList(0, 0, 100, 100);
      window.select(0);
      assert.equal(window.item(), data.items[1]); assert.equal(window.includes(data.items[1]), true);
      const view = window._data, makeItemList = window.makeItemList;
      window.makeItemList = function() { makeItemList.call(this); this._data.push(data.items[1]); };
      window.refresh(); assert.equal(window.maxItems(), 2); assert.equal(window._data, view);
      window.select(1); assert.equal(window.item(), data.items[1]);
      window._data.splice(0, 1); assert.equal(window.maxItems(), 1);
      assert.throws(() => { window._data = [{}]; }, /registered database/); assert.equal(window.maxItems(), 1);
      window.makeItemList = makeItemList; window.refresh();
      assert.equal(window.needsNumber(), true);
      window.select(-1); assert.equal(window.item(), null);
      scope.$gameParty.loseItem(data.items[1], 1);
    } finally { if (previous === undefined) delete scope.$dataItems; else scope.$dataItems = previous; }
  });
  await t.test('scroll text fallback draws and advances a native window from message state', () => {
    const previousSystem = scope.$dataSystem; scope.$dataSystem = data.system;
    const message = scope.$gameMessage;
    try {
      message.clear(); message.setScroll(2, false); message.add('Scrolling text');
      const window = new scope.Window_ScrollText();
      assert.equal(window.visible, false); window.update();
      assert.equal(window.visible, true); assert.equal(window._text, 'Scrolling text');
      assert.equal(window.contents.height, 36); assert.equal(window.origin.y, -window.height);
      window.isFastForward = () => false; window.update(); assert.equal(window.origin.y, -window.height + 1);
      window.isFastForward = () => true; window.update(); assert.equal(window.origin.y, -window.height + 4);
      window.terminateMessage(); assert.equal(message.hasText(), false); assert.equal(window.visible, false);
    } finally { message.clear(); if (previousSystem === undefined) delete scope.$dataSystem; else scope.$dataSystem = previousSystem; }
  });
  await t.test('choice and event-item handlers finish native messages and write native variables', () => {
    const message = scope.$gameMessage, previousSystem = scope.$dataSystem, previousItems = scope.$dataItems;
    const variableData = scope.$gameVariables._data, length = variableData.length, hadValue = 87 in variableData, previousValue = variableData[87];
    const hadGetter = Object.hasOwn(message, 'itemChoiceVariableId'), itemVariable = message.itemChoiceVariableId;
    scope.$dataSystem = data.system; scope.$dataItems = data.items;
    let terminated = 0, selected = -1;
    const owner = { y: 0, height: 24, terminateMessage() { ++terminated; message.clear(); } };
    try {
      message.clear(); const choice = new scope.Window_ChoiceList(owner);
      assert.equal(choice.active, false); assert.equal(choice.openness, 0);
      message.setChoices(['First', 'Second'], 1, -2); message.setChoiceCallback(index => { selected = index; });
      choice.start(); assert.equal(choice.maxItems(), 2); assert.equal(choice.index(), 1);
      choice.callOkHandler(); assert.equal(selected, 1); assert.equal(terminated, 1);
      const item = new scope.Window_EventItem(owner);
      item._data = [data.items[1]]; item.select(0); message.itemChoiceVariableId = () => 87;
      item.onOk(); assert.equal(engine.snapshot(session).variables[87], 1); assert.equal(terminated, 2);
      item.onCancel(); assert.equal(engine.snapshot(session).variables[87], 0); assert.equal(terminated, 3);
    } finally {
      message.clear();
      if (hadGetter) message.itemChoiceVariableId = itemVariable; else delete message.itemChoiceVariableId;
      if (hadValue) variableData[87] = previousValue; else delete variableData[87]; variableData.length = length;
      if (previousSystem === undefined) delete scope.$dataSystem; else scope.$dataSystem = previousSystem;
      if (previousItems === undefined) delete scope.$dataItems; else scope.$dataItems = previousItems;
    }
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
      const originalName = window.commandName(0);
      window._list[0].enabled = false; assert.equal(window.isCommandEnabled(0), false);
      window._list = window._list.map(command => ({ ...command, name: command.name + '!' }));
      assert.equal(window.commandName(0), originalName + '!');
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
  const catchException = scope.SceneManager.catchException;
  scope.SceneManager.catchException = error => { throw error; };
  second.update = () => { throw sentinel; };
  assert.throws(() => runtime.step(), error => error === sentinel);
  second.update = () => { assert.throws(() => scope.SceneManager.update(), /already running/); };
  runtime.step();
  scope.SceneManager.catchException = catchException;
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
      scope.SceneManager.catchException = error => { throw error; };
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
        var originalMapReady = Scene_Map.prototype.isReady;
        Scene_Map.prototype.isReady = function() { return mapReady && originalMapReady.call(this); };
      `);
      async function reach(type, started = false) {
        for (let frame = 0; frame < 300; ++frame) {
          runtime.step({});
          if (scope.SceneManager._scene?.constructor === type && !scope.SceneManager.isSceneChanging() && (!started || scope.SceneManager.isCurrentSceneStarted())) return;
          await new Promise(resolve => setImmediate(resolve));
        }
        assert.fail('scene did not reach ' + type.name);
      }
      runtime.start(); await reach(scope.Scene_Title, true);
      scope.DataManager.setupNewGame();
      assert.equal(engine.snapshot(session).scene, 0, 'game object initialization does not change the active scene');
      for (let frame = 0; frame < 40; ++frame) { runtime.step({}); await new Promise(resolve => setImmediate(resolve)); }
      runtime.step({ ok: true });
      for (let frame = 0; frame < 100 && !scope.SceneManager.isSceneChanging(); ++frame) { runtime.step({}); await new Promise(resolve => setImmediate(resolve)); }
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
      scope.mapReady = true; await reach(scope.Scene_Map, true);
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
      await reach(scope.Scene_Battle, true);
      assert.equal(engine.snapshot(session).scene, 11);
      assert.deepEqual(scope.SceneManager._stack, [scope.PluginMap]);
      battleEnemy.setHp(0);
      for (let frame = 0; frame < 300 && scope.SceneManager._scene?.constructor !== scope.PluginMap; ++frame) {
        if (engine.snapshot(session).message.busy) engine.acknowledge(session);
        runtime.step({});
        await new Promise(resolve => setImmediate(resolve));
      }
      assert.equal(scope.SceneManager._scene?.constructor, scope.PluginMap, JSON.stringify({ battle: engine.snapshot(session).battle, busy: scope.$gameMessage.isBusy(), enemyHp: battleEnemy.hp, enemyStates: Array.from(battleEnemy._states), phase: scope.BattleManager._phase, stopped: scope.SceneManager._stopped, started: scope.SceneManager.isCurrentSceneStarted(), canStep: scope.SceneManager.canStep, changing: scope.SceneManager.isSceneChanging(), nativeDriven: scope.SceneManager.nativeDriven }));
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
      for (let index = 0; index < 100 && !(runtime.scope.SceneManager._scene instanceof runtime.scope.Intro && runtime.scope.SceneManager.isCurrentSceneStarted()); ++index) {
        runtime.step({}); await new Promise(resolve => setImmediate(resolve));
      }
      assert.ok(runtime.scope.SceneManager._scene instanceof runtime.scope.Intro);
      assert.equal(engine.snapshot(session).mapId, 2);
      assert.equal(runtime.scope.$gamePlayer.isTransferring(), false);
      const tick = engine.snapshot(session).ticks;
      runtime.step({});
      assert.equal(engine.snapshot(session).ticks, tick + 1);
      runtime.scope.SceneManager.goto(runtime.scope.Scene_Title);
      for(let frame=0;frame<180&&!(runtime.scope.SceneManager._scene instanceof runtime.scope.Scene_Title);++frame) {
        runtime.step({});await new Promise(resolve=>setImmediate(resolve));
      }
      assert.ok(runtime.scope.SceneManager._scene instanceof runtime.scope.Scene_Title);
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
      touch._onWheel({ deltaX: 2, deltaY: 5, preventDefault() {} }); runtime.step();
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
      engine.playerTransfer(session, 'perform');
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
      engine.playerTransfer(shadowSession, 'perform');
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
      shadowRuntime.runScript(`
        var originalRead = Tilemap.prototype._readMapData;
        var readCalls = 0;
        Tilemap.prototype._readMapData = function(x,y,z) { ++readCalls; return z === 0 ? 0 : originalRead.call(this,x,y,z); };
      `);
      shadowRuntime.step(); assert.equal(capture(), 0); assert.ok(shadowRuntime.scope.readCalls > 0);
      shadowRuntime.runScript('Tilemap.prototype._readMapData = originalRead;'); shadowRuntime.step();
      assert.ok(capture() > 60 && capture() < 200);
      shadowRuntime.runScript(`
        var originalDrawTile = ShaderTilemap.prototype._drawTile;
        var drawTileCalls = 0;
        ShaderTilemap.prototype._drawTile = function() { ++drawTileCalls; };
      `);
      shadowRuntime.step(); assert.equal(capture(),0); assert.ok(shadowRuntime.scope.drawTileCalls>0);
      shadowRuntime.runScript('ShaderTilemap.prototype._drawTile = originalDrawTile;');shadowRuntime.step();
      assert.ok(capture()>60&&capture()<200);
      shadowRuntime.runScript(`
        var originalPaintTiles = ShaderTilemap.prototype._paintTiles;
        var paintCalls = 0;
        ShaderTilemap.prototype._paintTiles = function() { ++paintCalls; };
      `);
      shadowRuntime.step(); const emptyPaint=capture(); assert.ok(shadowRuntime.scope.paintCalls>0,'native geometry must invoke the paint override'); assert.equal(emptyPaint,0);
      shadowRuntime.runScript('ShaderTilemap.prototype._paintTiles = originalPaintTiles;');shadowRuntime.step();
      assert.ok(capture()>60&&capture()<200);
      shadowRuntime.runScript('Tilemap.isVisibleTile = function() { return false; };');shadowRuntime.step();
      assert.equal(capture(),0);

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
        seen._effectDuration = 19; seen.updateBossCollapse(); assert.equal(seen._shake, 2);
        assert.ok(seen.opacity < 255); seen.updateInstantCollapse();
        assert.deepEqual(capture(), [0, 0, 0, 255], 'public collapse methods must affect native enemy drawing');
        seen.startEffect('whiten');

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
      engine.playerTransfer(balloonSession, 'perform');
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
      const character = new runtime.scope.Sprite_Character(runtime.scope.$gamePlayer), parent = new runtime.scope.Sprite();
      parent.addChild(character); runtime.scope.$gamePlayer.requestBalloon(2); character.setupBalloon();
      const associated = character._balloonSprite;
      assert.equal(associated, observed); assert.equal(associated.parent, parent);
      character.endBalloon(); assert.equal(character._balloonSprite, null); assert.equal(associated.parent, null);
      assert.equal(associated.isPlaying(), false); assert.equal(greenCount(), 0);

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
      engine.playerTransfer(weatherSession, 'perform');
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

  await t.test('audio response overrides can defer readiness and replace bytes before native decoding', () => {
    const audioSession=engine.create(fixture([]));
    try {
      engine.attach(audioSession,{width:32,height:32,fontFile:'font.ttf'});
      const r=createScriptRuntime(engine,audioSession,{native});r.installScenes();
      const {WebAudio}=r.scope,original=WebAudio.prototype._onXhrLoad;let response,loaded=0,responses=0;
      WebAudio.prototype._onXhrLoad=function(xhr) {response=xhr;++responses;};
      const audio=new WebAudio('audio/bgm/Tone.ogg');audio.addLoadListener(()=>++loaded);
      native.beginFrame();engine.present(audioSession);native.renderFrame();
      assert.ok(response.response instanceof r.runScript('ArrayBuffer'));assert.equal(response.response.byteLength,wave.length);
      assert.equal(response.status,200);assert.equal(audio.isReady(),false);assert.equal(loaded,0);
      native.beginFrame();engine.present(audioSession);native.renderFrame();assert.equal(responses,1,'a deferred response must not start another request');
      const shorter=Buffer.from(wave.subarray(0,44+48000*4));shorter.writeUInt32LE(shorter.length-8,4);shorter.writeUInt32LE(shorter.length-44,40);
      response.response=r.runScript('(function(bytes) {return new Uint8Array(bytes).buffer;})')(Array.from(shorter));
      original.call(audio,response);
      assert.equal(audio.isReady(),true);assert.equal(loaded,1);assert.equal(audio._buffer.length,48000);assert.equal(audio._totalTime,1);
      audio.play(true,0.25);assert.equal(audio.isPlaying(),true);audio.stop();
      WebAudio.prototype._onXhrLoad=function(xhr) {xhr.response=response.response;original.call(this,xhr);};
      const immediate=new WebAudio('audio/bgm/Tone.ogg');
      native.beginFrame();engine.present(audioSession);native.renderFrame();
      assert.equal(immediate.isReady(),true);assert.equal(immediate._totalTime,1);
    } finally {engine.dispose(audioSession);}
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
      const played = [], lifecycle=[];
      for (const method of ['_load','_onLoad','_startPlaying','_readLoopComments']) {
        const original=WebAudio.prototype[method];
        WebAudio.prototype[method]=function(...args) {
          if(method==='_readLoopComments') {assert.ok(args[0] instanceof runtime.runScript('Uint8Array'));assert.equal(args[0].buffer.byteLength,wave.length);}
          lifecycle.push([method,this]);return original.apply(this,args);
        };
      }
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
      assert.deepEqual(lifecycle.map(([method])=>method),['_load','_readLoopComments','_onLoad','_startPlaying']);
      assert.ok(lifecycle.every(([,object])=>object===audio));
      assert.equal(audio._autoPlay,true);assert.equal(audio._loop,true);
      assert.equal(audio._url,'audio/bgm/Tone.ogg');
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

  await t.test('plugin input states and query overrides drive native player movement', () => {
    const data=fixture([]);data.maps[1].events=[null];const inputSession=engine.create(data);
    try {
      engine.attach(inputSession,{width:32,height:32,fontFile:'font.ttf'});
      const r=createScriptRuntime(engine,inputSession,{native});r.installScenes();
      engine.newGame(inputSession);engine.playerTransfer(inputSession,'perform');
      engine.sceneControl(inputSession,'commit',1);
      r.scope.SceneManager.initInput();
      r.scope.Input._currentState.right=true;r.step();
      assert.equal(engine.snapshot(inputSession).player.x,2);
      r.scope.$gamePlayer.locate(2,1);r.scope.Input.clear();
      const pressed=r.scope.Input.isPressed;
      r.scope.Input.isPressed=function(name) {return name==='left'||pressed.call(this,name);};
      r.step();assert.equal(engine.snapshot(inputSession).player.x,1);
    } finally {engine.dispose(inputSession);}
  });
  await t.test('input initialization dispatches setup overrides and document events into native state', () => {
    const {installWeb}=require('../runner/native-web.cjs'),{createStorage}=require('../runner/storage.cjs');
    const inputSession=engine.create(fixture([]));
    try {
      engine.attach(inputSession,{width:32,height:32,fontFile:'font.ttf'});
      const r=createScriptRuntime(engine,inputSession,{native});
      installWeb(r,{native,gameRoot:root,storage:createStorage(path.join(root,'storage')),settings:{width:32,height:32}});
      r.installScenes();const {Input,TouchInput,document}=r.scope;
      r.runScript('Date.now=function() {return 456;};');
      r.scope.Graphics.pageToCanvasX=x=>x;r.scope.Graphics.pageToCanvasY=y=>y;
      const keyboardSetup=Input._setupEventHandlers,touchSetup=TouchInput._setupEventHandlers;let setups=0,triggers=0;
      Input._setupEventHandlers=function() {++setups;keyboardSetup.call(this);};
      TouchInput._setupEventHandlers=function() {++setups;touchSetup.call(this);};
      const trigger=TouchInput._onTrigger;TouchInput._onTrigger=function(x,y) {++triggers;trigger.call(this,x,y);};
      r.scope.SceneManager.initInput();assert.equal(setups,2);
      document.dispatchEvent({type:'keydown',keyCode:13,preventDefault(){}});Input.update();assert.equal(Input.isTriggered('ok'),true);
      assert.equal(Input.date,456);Input._date=321;assert.equal(Input.date,321);
      document.dispatchEvent({type:'keyup',keyCode:13});Input.update();assert.equal(Input.isPressed('ok'),false);
      document.dispatchEvent({type:'mousedown',button:0,pageX:2,pageY:3,preventDefault(){}});TouchInput.update();
      assert.equal(triggers,1);assert.equal(TouchInput.isTriggered(),true);assert.equal(TouchInput.x,2);assert.equal(TouchInput.y,3);
      assert.equal(TouchInput.date,456);
      document.dispatchEvent({type:'mouseup',button:0,pageX:2,pageY:3});TouchInput.update();assert.equal(TouchInput.isReleased(),true);
      TouchInput._events={triggered:true,cancelled:false,moved:false,released:false,wheelX:4,wheelY:-2};TouchInput._date=123;
      const events=TouchInput._events;
      TouchInput.update();assert.equal(TouchInput.isTriggered(),true);assert.equal(TouchInput.wheelX,4);assert.equal(TouchInput.date,123);
      assert.equal(TouchInput._events,events);assert.equal(events.triggered,false);TouchInput.clear();assert.notEqual(TouchInput._events,events);
      Input._currentState.ok=true;r.scope.dispatchEvent({type:'blur'});assert.equal(Input.isPressed('ok'),false);
    } finally {engine.dispose(inputSession);}
  });
  await t.test('Html5Audio plays decrypted Blob sources through native audio without changing host URL state', async () => {
    const {installWeb}=require('../runner/native-web.cjs'),{installCoreServices}=require('../runner/native-core-services.cjs');
    const {createStorage}=require('../runner/storage.cjs');
    const audioSession=engine.create(fixture([])),hostCreateURL=URL.createObjectURL;
    let html;
    try {
      engine.attach(audioSession,{width:32,height:32,fontFile:'font.ttf'});
      const r=createScriptRuntime(engine,audioSession,{native});
      installWeb(r,{native,gameRoot:root,storage:createStorage(path.join(root,'storage')),settings:{width:32,height:32}});
      r.installScenes();installCoreServices(r,engine);
      assert.equal(URL.createObjectURL,hostCreateURL);assert.notEqual(r.scope.URL,URL);
      const blob=new r.scope.Blob([new Uint8Array(wave)],{type:'audio/wav'});
      assert.ok(blob.slice() instanceof r.scope.Blob);
      const url=r.scope.URL.createObjectURL(blob);html=r.scope.Html5Audio;
      html.setup(url);html._unlocked=true;html.play(true,0.1);await html._audioElement._loadPromise;
      for(let frame=0;frame<3;++frame){native.beginFrame();engine.present(audioSession);native.renderFrame();}
      assert.equal(html.isReady(),true);assert.equal(html.isPlaying(),true);assert.equal(html._audioElement.src,url);
      assert.ok(html.seek()>=0.1-1/48000&&html.seek()<audioFrames/48000);html.volume=0.4;assert.equal(html._audioElement._buffer.volume,0.4);
      html.stop();assert.equal(html.isPlaying(),false);r.scope.URL.revokeObjectURL(url);
    } finally {html?.stop();engine.dispose(audioSession);}
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
