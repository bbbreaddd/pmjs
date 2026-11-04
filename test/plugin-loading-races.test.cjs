'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

function adapter(module, globals) {
  const loaded = new Map(), phases = new Map();
  const context = vm.createContext({ ...globals, PMJS: {
    plugins: { onLoaded(name, owner, callback) { loaded.set(name, callback); } },
    phases: { on(name, owner, callback) { phases.set(name, callback); } }
  } });
  const source = module === 'yanfly/save-core'
    ? require('./helpers/save-core-fixture.cjs').prepareSaveCoreAdapter(context)
    : fs.readFileSync(require.resolve('../js/pmjs-plugins/' + module + '.js'), 'utf8');
  vm.runInContext(source, context);
  return { context, install() {
    for (const callback of loaded.values()) callback();
    for (const callback of phases.values()) callback();
  } };
}

function bitmap(ready = false) {
  return { width: ready ? 120 : 0, height: ready ? 80 : 0, listeners: [],
    addLoadListener(callback) {
      if (this.width) callback();
      else this.listeners.push(callback);
    },
    complete() {
      this.width = 120; this.height = 80;
      this.listeners.splice(0).forEach(callback => callback());
    }
  };
}

test('map readiness waits for every requested copy template before event initialization', () => {
  const templates = [];
  templates[1] = null; templates[8] = null;
  let map = null, checks = 0, error = null;
  const DataManager = { isMapLoaded() {
    checks++;
    if (error) throw error;
    return !!map;
  } };
  const h = adapter('yanfly/event-copier', { DataManager, Yanfly: { PreloadedMaps: templates } });
  h.install();
  assert.equal(DataManager.isMapLoaded(), false);
  map = { events: [{ copyMap: 1, copyEvent: 2 }] };
  assert.equal(DataManager.isMapLoaded(), false);
  templates[8] = { events: [] };
  assert.equal(DataManager.isMapLoaded(), false);
  templates[1] = { events: [null, null, { trigger: 3, pages: [{ commands: ['barrier'] }] }] };
  assert.equal(DataManager.isMapLoaded(), true);
  const events = map.events.map(event => templates[event.copyMap].events[event.copyEvent]);
  assert.equal(events[0].trigger, 3);
  assert.deepEqual(events[0].pages[0].commands, ['barrier']);
  templates[9] = null;
  assert.equal(DataManager.isMapLoaded(), false);
  error = new Error('failed template request');
  assert.throws(() => DataManager.isMapLoaded(), value => value === error);
  assert.equal(checks, 6);
});

function bustFixture() {
  const images = { old: bitmap(true), A: bitmap(), B: bitmap(), warm: bitmap(true), '': bitmap() };
  const events = [];
  class Sprite_VisualNovelBust {
    constructor() { this.bitmap = images.old; this._type = 'picture'; this._bustName = 'old'; }
    loadBitmap(type, name) {
      if (this._type !== type || this._bustName !== name) {
        this._type = type; this._bustName = name;
        if (name) events.push('expression:' + name);
        this._toBeLoadedBitmap = images[name];
        if (name) this._toBeLoadedBitmap.addLoadListener(this.afterLoadBitmap.bind(this));
      }
      events.push(name ? 'fade-in' : 'fade-out');
      return 'loaded';
    }
    afterLoadBitmap() { this.bitmap = this._toBeLoadedBitmap; this.updateFrame(); }
    updateFrame() { events.push('frame:' + this._bustName); }
  }
  const h = adapter('irina/visual-novel-busts', { Sprite_VisualNovelBust });
  h.install();
  return { images, events, sprite: new Sprite_VisualNovelBust() };
}

test('an obsolete bust completion cannot expose an unready replacement', () => {
  const { sprite, images, events } = bustFixture();
  assert.equal(sprite.loadBitmap('picture', 'A'), 'loaded');
  sprite.loadBitmap('face', 'B');
  images.A.complete();
  assert.equal(sprite.bitmap, images.old);
  assert.equal(events.filter(value => value.startsWith('frame:')).length, 0);
  images.B.complete();
  assert.equal(sprite.bitmap, images.B);
  assert.equal(events.at(-1), 'frame:B');
});

test('same bust requests keep the active listener; clearing invalidates it', () => {
  const { sprite, images, events } = bustFixture();
  sprite.loadBitmap('picture', 'A');
  sprite.loadBitmap('picture', 'A');
  assert.equal(images.A.listeners.length, 1);
  images.A.complete();
  assert.equal(sprite.bitmap, images.A);
  sprite.loadBitmap('picture', 'B');
  sprite.loadBitmap('picture', '');
  images.B.complete();
  assert.equal(sprite.bitmap, images.A);
  assert.equal(events.at(-1), 'fade-out');
});

test('returning to a pending bust does not revive its previous request', () => {
  const { sprite, images, events } = bustFixture();
  sprite.loadBitmap('picture', 'A');
  sprite.loadBitmap('picture', 'B');
  sprite.loadBitmap('picture', 'A');
  images.A.complete();
  images.B.complete();
  assert.equal(sprite.bitmap, images.A);
  assert.deepEqual(events.filter(value => value.startsWith('frame:')), ['frame:A']);
});

test('warm busts retain hook, expression and fade ordering without an own hook', () => {
  const { sprite, images, events } = bustFixture();
  const hook = sprite.afterLoadBitmap;
  sprite.loadBitmap('face', 'warm');
  assert.equal(sprite.bitmap, images.warm);
  assert.deepEqual(events, ['expression:warm', 'frame:warm', 'fade-in']);
  assert.equal(sprite.afterLoadBitmap, hook);
  assert.equal(Object.hasOwn(sprite, 'afterLoadBitmap'), false);
});

test('a bust hook override and its descriptor survive a thrown load', () => {
  const { sprite, images } = bustFixture();
  const failure = new Error('guest hook failed');
  const hook = () => { throw failure; };
  Object.defineProperty(sprite, 'afterLoadBitmap', { value: hook, writable: true, configurable: true });
  const descriptor = Object.getOwnPropertyDescriptor(sprite, 'afterLoadBitmap');
  assert.throws(() => sprite.loadBitmap('face', 'warm'), value => value === failure);
  assert.deepEqual(Object.getOwnPropertyDescriptor(sprite, 'afterLoadBitmap'), descriptor);
  assert.equal(images.warm.listeners.length, 0);
});

test('a warm bust hook can request a replacement before its outer load returns', () => {
  const { sprite, images } = bustFixture();
  const afterLoad = sprite.afterLoadBitmap;
  sprite.afterLoadBitmap = function() {
    afterLoad.call(this);
    if (this._bustName === 'warm') this.loadBitmap('picture', 'B');
  };
  sprite.loadBitmap('picture', 'warm');
  assert.equal(sprite.bitmap, images.warm);
  images.B.complete();
  assert.equal(sprite.bitmap, images.B);
});

test('a warm bust hook can replace itself without the adapter restoring the old hook', () => {
  const { sprite, images } = bustFixture();
  const replacement = function() { this.bitmap = this._toBeLoadedBitmap; };
  sprite.afterLoadBitmap = function() {
    this.bitmap = this._toBeLoadedBitmap;
    this.afterLoadBitmap = replacement;
  };
  sprite.loadBitmap('picture', 'warm');
  assert.equal(sprite.afterLoadBitmap, replacement);
  sprite.loadBitmap('picture', 'B');
  images.B.complete();
  assert.equal(sprite.bitmap, images.B);
  assert.equal(sprite.afterLoadBitmap, replacement);
});

function menuFixture() {
  const images = { A: bitmap(), B: bitmap(), warm: bitmap(true) }, paints = [], timers = [];
  const contents = () => ({ clear() { paints.push('clear'); } });
  class Window_CommonEventMenuPicture {
    constructor() { this._picture = ''; this.contents = contents(); }
    setPicture(name) { this._picture = name; return this.refresh(); }
    refresh() {
      if (!this._picture) return this.contents.clear();
      this._pictureBitmap = images[this._picture];
      return this.drawPicture();
    }
    drawPicture() {
      if (!this._pictureBitmap.width) return timers.push(() => this.drawPicture());
      this.contents.clear();
      paints.push(this._pictureBitmap);
      return 'painted';
    }
  }
  class Scene_Base { terminate() { return 'terminated'; } }
  const h = adapter('yanfly/common-event-menu', { Window_CommonEventMenuPicture, Scene_Base });
  h.install();
  return { window: new Window_CommonEventMenuPicture(), scene: new Scene_Base(), images, paints, timers, contents };
}

for (const change of ['clear', 'replace', 'refresh', 'contents', 'terminate']) {
  test(`profile portrait completion after ${change} cannot repaint obsolete content`, () => {
    const h = menuFixture();
    const { window, images, paints, scene } = h;
    window.setPicture('A');
    window.drawPicture();
    assert.equal(images.A.listeners.length, 1);
    if (change === 'clear') window.setPicture('');
    if (change === 'replace') window.setPicture('B');
    if (change === 'refresh') window.refresh();
    if (change === 'contents') window.contents = h.contents();
    if (change === 'terminate') {
      scene._commonEventMenuPictureWindow = window;
      assert.equal(scene.terminate(), 'terminated');
    }
    images.A.complete();
    assert.equal(paints.filter(value => value === images.A).length, change === 'refresh' ? 1 : 0);
    if (change === 'replace') {
      images.B.complete();
      assert.equal(paints.at(-1), images.B);
    }
    assert.equal(h.timers.length, 0);
  });
}

test('warm profile portraits retain ordinary drawing and its return value', () => {
  const { window, images, paints, timers } = menuFixture();
  assert.equal(window.setPicture('warm'), 'painted');
  assert.equal(paints.at(-1), images.warm);
  assert.equal(images.warm.listeners.length, 0);
  assert.equal(timers.length, 0);
});

function saveFixture() {
  const events = [], timers = new Map();
  let next = 0, parseCalls = 0;
  class Window_SaveInfo {
    drawInvalidText(y) { events.push(['invalid', y]); return 'invalid'; }
    drawPartyGraphics(y) { events.push(['graphics', y]); return y + 1; }
    drawPartyNames(y) { events.push(['names', y]); return y + 1; }
    drawPartyLevels(y) { events.push(['levels', y]); return y + 1; }
    drawColumnData(y) { events.push(['columns', y]); return 'drawn'; }
  }
  class Scene_File {
    constructor() {
      this.id = 1; this.symbol = 'delete';
      this._confirmWindow = { deactivate() { events.push('deactivate'); }, close() { events.push('close'); } };
      this._actionWindow = { currentSymbol: () => this.symbol };
    }
    savefileId() { return this.id; }
    performActionLoad() { events.push(['load', this.savefileId()], 'sound', 'fade', 'transition'); }
    performActionSave() { events.push('before-save', ['save', this.savefileId()], 'sound', 'backup', 'refresh'); }
    performActionDelete() { events.push('sound', ['delete', this.savefileId()], 'refresh'); }
    onActionCancel() { events.push('action-cancel'); }
    onConfirmCancel() { events.push('confirm-cancel'); }
    terminate() { events.push('terminate'); }
  }
  const SceneManager = { _scene: null, changing: false, isSceneChanging() { return this.changing; } };
  const h = adapter('yanfly/save-core', { Window_SaveInfo, Scene_File, SceneManager,
    JsonEx: { parse(text) { parseCalls++; return JSON.parse(text); } },
    setTimeout(callback, delay) { assert.equal(delay, 200); timers.set(++next, callback); return next; },
    clearTimeout(id) { timers.delete(id); }
  });
  h.install();
  const scene = SceneManager._scene = new Scene_File();
  return { window: new Window_SaveInfo(), scene, SceneManager, events, timers,
    parseCalls: () => parseCalls,
    drain() { const pending = [...timers.values()]; timers.clear(); pending.forEach(callback => callback()); } };
}

test('save previews parse once and preserve the drawing pipeline on repeated draws', () => {
  const h = saveFixture();
  h.window._saveContents = '{"slot":1}';
  assert.equal(h.window.drawContents(4), 'drawn');
  assert.equal(h.window.drawContents(4), 'drawn');
  assert.equal(h.parseCalls(), 1);
  assert.deepEqual(h.events.slice(0, 4), [['graphics', 4], ['names', 5], ['levels', 6], ['columns', 7]]);
  h.window._saveContents = '{"slot":2}';
  h.window.drawContents(4);
  assert.equal(h.window._saveContents.slot, 2);
  assert.equal(h.parseCalls(), 2);
});

test('missing save contents show an invalid preview without polling; parse errors propagate', () => {
  const h = saveFixture();
  assert.equal(h.window.drawContents(9), 'invalid');
  assert.deepEqual(h.events, [['invalid', 9]]);
  assert.equal(h.timers.size, 0);
  h.window._saveContents = 'broken';
  assert.throws(() => h.window.drawContents(9), SyntaxError);
});

for (const symbol of ['load', 'save', 'delete']) {
  test(`confirmed ${symbol} retains the original action ordering and selected slot`, () => {
    const h = saveFixture();
    h.scene.symbol = symbol;
    h.scene.onConfirmOk();
    assert.deepEqual(h.events, ['deactivate', 'close']);
    h.drain();
    const expected = symbol === 'load' ? [['load', 1], 'sound', 'fade', 'transition']
      : symbol === 'save' ? ['before-save', ['save', 1], 'sound', 'backup', 'refresh']
        : ['sound', ['delete', 1], 'refresh'];
    assert.deepEqual(h.events.slice(2), expected);
  });
}

for (const change of ['slot', 'action', 'scene', 'transition', 'terminate', 'onConfirmCancel', 'onActionCancel']) {
  test(`confirmed delete cancelled by ${change} cannot mutate any save slot`, () => {
    const h = saveFixture();
    h.scene.onConfirmOk();
    const late = [...h.timers.values()][0];
    if (change === 'slot') h.scene.id = 2;
    if (change === 'action') h.scene.symbol = 'save';
    if (change === 'scene') h.SceneManager._scene = {};
    if (change === 'transition') h.SceneManager.changing = true;
    if (typeof h.scene[change] === 'function') h.scene[change]();
    h.drain();
    late();
    assert.equal(h.events.some(value => Array.isArray(value)), false);
  });
}

test('repeated confirmations replace the old request and execute only once', () => {
  const h = saveFixture();
  h.scene.onConfirmOk();
  const obsolete = [...h.timers.values()][0];
  h.scene.onConfirmOk();
  obsolete();
  h.drain();
  assert.deepEqual(h.events.filter(Array.isArray), [['delete', 1]]);
});
