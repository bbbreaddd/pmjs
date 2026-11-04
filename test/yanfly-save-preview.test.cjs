'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

function fixture(options = {}) {
  const timers = new Map(), images = new Map(), draws = [], warnings = [];
  let serial = 0;
  function schedule(callback, delay) {
    assert.equal(delay, 50); timers.set(++serial, callback); return serial;
  }
  function image(name) {
    if (!images.has(name)) images.set(name, { width: 0, failed: false,
      isError() { return this.failed; } });
    return images.get(name);
  }
  class Window_SaveInfo {
    constructor() { this.parent = {}; this.contents = {}; this.slot = 1; }
    savefileId() { return this.slot; }
    updateIndex() { return 'index'; }
    refresh() { if (this.onRefresh) this.onRefresh(); return 'refresh'; }
  }
  for (const name of ['drawCharacter', 'drawFace', 'drawSvActor']) {
    Window_SaveInfo.prototype[name] = function(...args) {
      const bitmap = image(name === 'drawSvActor' ? args[0].battlerName() : args[0]);
      if (!bitmap.width) return schedule(() => this[name](...args), 50);
      draws.push({ window: this, name, args }); return 'drawn';
    };
  }
  class Scene_File {
    onActionCancel() {}
    onConfirmCancel() {}
    terminate() { return 'terminated'; }
  }
  const scene = new Scene_File(), SceneManager = { _scene: scene, changing: false,
    isSceneChanging() { return this.changing; } };
  const context = vm.createContext({ Window_SaveInfo, Scene_File, SceneManager,
    ImageManager: { loadCharacter: image, loadFace: image, loadSvActor: image },
    console: { warn(message) { warnings.push(message); } },
    setTimeout: schedule,
    clearTimeout(id) { timers.delete(id); },
    PMJS: { plugins: { onLoaded(_plugin, _owner, install) { install(); } } }
  });
  const source = require('./helpers/save-core-fixture.cjs').prepareSaveCoreAdapter(context);
  const hits = [];
  context.PMJS.compat.hit = (...args) => hits.push(args);
  if (options.unknownContents) Window_SaveInfo.prototype.drawContents = function customContents() { return 'custom contents'; };
  if (options.unknownConfirm) Scene_File.prototype.onConfirmOk = function customConfirm() { return 'custom confirmation'; };
  const originals = { contents: Window_SaveInfo.prototype.drawContents, confirm: Scene_File.prototype.onConfirmOk };
  vm.runInContext(source, context);
  const window = scene._infoWindow = new Window_SaveInfo();
  return { context, window, scene, SceneManager, timers, images, image, draws, warnings, hits, originals,
    tick() { const pending = [...timers.values()]; timers.clear(); pending.forEach(fn => fn()); } };
}

test('each delayed party image draws once with its original receiver and arguments', () => {
  const h = fixture(), actor = { battlerName() { return 'sv'; } };
  h.window.drawCharacter('character', 2, 10, 20);
  h.window.drawFace('face', 3, 30, 40, 96, 80);
  h.window.drawSvActor(actor, 50, 60);
  assert.equal(h.timers.size, 3);
  assert.equal(h.draws.length, 0);
  for (const image of h.images.values()) image.width = 144;
  h.tick();
  assert.deepEqual(h.draws.map(d => d.args), [['character', 2, 10, 20],
    ['face', 3, 30, 40, 96, 80], [actor, 50, 60]]);
  assert.ok(h.draws.every(d => d.window === h.window));
  assert.equal(h.timers.size, 0);
});

test('ready portraits retain the immediate draw result without a timer', () => {
  const h = fixture();
  h.image('ready').width = 144;
  assert.equal(h.window.drawFace('ready', 0, 1, 2), 'drawn');
  assert.equal(h.timers.size, 0);
});

test('evicted completed images cannot escape the retry budget or cancellation', () => {
  const h = fixture();
  h.window.drawFace('portrait', 0, 1, 2);
  h.image('portrait').width = 144;
  h.images.delete('portrait');
  h.tick();
  assert.equal(h.draws.length, 0);
  assert.equal(h.timers.size, 1);
  const late = [...h.timers.values()][0];
  h.window.updateIndex();
  assert.equal(h.timers.size, 0);
  h.image('portrait').width = 144;
  late();
  assert.equal(h.draws.length, 0);
});

for (const change of ['slot', 'contents', 'detach', 'scene', 'transition', 'failure', 'terminate']) {
  test('delayed portrait cannot paint after ' + change, () => {
    const h = fixture();
    h.window.drawFace('old', 0, 1, 2);
    const late = [...h.timers.values()][0];
    if (change === 'slot') h.window.slot = 2;
    if (change === 'contents') h.window.contents = {};
    if (change === 'detach') h.window.parent = null;
    if (change === 'scene') {
      h.SceneManager._scene = {};
      h.window.savefileId = () => { throw new Error('must check scene first'); };
    }
    if (change === 'transition') h.SceneManager.changing = true;
    if (change === 'failure') h.image('old').failed = true;
    if (change === 'terminate') assert.equal(h.scene.terminate(), 'terminated');
    h.image('old').width = 144;
    h.tick(); late();
    assert.equal(h.draws.length, 0);
    assert.equal(h.timers.size, 0);
  });
}

test('slot A to B to A and same-slot refresh invalidate old callbacks', () => {
  for (const sameSlot of [false, true]) {
    const h = fixture();
    h.window.drawFace('old', 0, 1, 2);
    const stale = [...h.timers.values()][0];
    if (!sameSlot) {
      h.window.slot = 2; h.window.updateIndex();
      h.window.slot = 1; h.window.updateIndex();
    }
    h.window.onRefresh = () => h.window.drawFace('new', 0, 1, 2);
    assert.equal(h.window.refresh(), 'refresh');
    h.image('old').width = h.image('new').width = 144;
    stale(); h.tick();
    assert.deepEqual(h.draws.map(d => d.args[0]), ['new']);
  }
});

test('each failed-load budget ends after 60 retries and leaves no timers', () => {
  const h = fixture();
  h.window.drawFace('never', 0, 1, 2);
  for (let i = 0; i < 59; i++) h.tick();
  assert.equal(h.timers.size, 1);
  h.window.drawFace('later', 0, 1, 2);
  h.tick();
  assert.equal(h.warnings.length, 1);
  assert.equal(h.timers.size, 1);
  h.image('later').width = 144;
  h.tick();
  assert.deepEqual(h.draws.map(d => d.args[0]), ['later']);
  assert.equal(h.timers.size, 0);
});

test('hidden windows still receive their portrait and known failures do not retry', () => {
  const h = fixture();
  h.window.visible = false;
  h.window.drawFace('hidden', 0, 1, 2);
  h.image('hidden').width = 144;
  h.tick();
  assert.equal(h.draws.length, 1);
  h.image('failed').failed = true;
  h.window.drawFace('failed', 0, 1, 2);
  assert.equal(h.timers.size, 0);
});

function contentsFixture() {
  const h = fixture(), window = h.window, contents = [], slots = new Map();
  h.context.JsonEx = { parse: JSON.parse };
  h.context.StorageManager = { load: id => slots.get(id) ?? null };
  window.contents.clear = () => { contents.length = 0; };
  window.resetFontSettings = () => {};
  window.drawGameTitle = y => { contents.push('title'); return y + 12; };
  window.drawInvalidText = y => { contents.push(['invalid', y]); return 'invalid'; };
  window.drawPartyGraphics = function(y) {
    contents.push(['party', this._saveContents.party._actors.length]); return y + 10;
  };
  window.drawPartyNames = y => { contents.push('names'); return y + 10; };
  window.drawPartyLevels = y => { contents.push('levels'); return y + 10; };
  window.drawColumnData = y => { contents.push('columns'); return y + 10; };
  window.onRefresh = function() {
    this.contents.clear(); this.resetFontSettings();
    const y = this.drawGameTitle(0);
    this._saveContents = h.context.StorageManager.load(this.savefileId());
    this.drawContents(y);
  };
  return { ...h, contents, slots };
}

for (const raw of ['{"party":', 'null', '{}']) {
  test('damaged contents leave an unreadable preview and preserve the slot: ' + raw, () => {
    const h = contentsFixture(); h.slots.set(1, raw);
    assert.equal(h.window.refresh(), 'invalid');
    assert.deepEqual(h.contents, ['title', ['invalid', 12]]);
    assert.equal(h.window._saveContents, null);
    assert.equal(h.slots.get(1), raw);
    assert.equal(h.warnings.length, 1);
    assert.match(h.warnings[0], /save preview failed for slot 1/);
    h.window.slot = 2;
    h.slots.set(2, '{"party":{"_actors":[1]}}');
    h.window.updateIndex();
    assert.equal(h.window.refresh(), 'refresh');
    assert.deepEqual(h.contents, ['title', ['party', 1], 'names', 'levels', 'columns']);
    assert.equal(h.slots.get(1), raw);
  });
}

test('slot read failures remain contained and can be retried without switching slots', () => {
  const h = contentsFixture(), load = h.context.StorageManager.load;
  const failure = Object.assign(new Error('storage read failed'), { code: 'EIO' });
  h.context.StorageManager.load = () => { throw failure; };
  assert.equal(h.window.refresh(), 'invalid');
  assert.deepEqual(h.contents, ['title', ['invalid', 12]]);
  assert.match(h.warnings[0], /storage read failed/);
  h.context.StorageManager.load = load;
  h.slots.set(1, '{"party":{"_actors":[]}}');
  assert.equal(h.window.refresh(), 'refresh');
  assert.deepEqual(h.contents, ['title', ['party', 0], 'names', 'levels', 'columns']);
});

test('partially drawn invalid previews cancel pending portraits and discard stale callbacks', () => {
  const h = contentsFixture(); h.slots.set(1, '{"party":{"_actors":[1]}}');
  let late;
  h.window.drawPartyGraphics = function(y) {
    h.contents.push('partial party');
    this.drawFace('pending', 0, 10, 20);
    late = [...h.timers.values()][0];
    return y + 10;
  };
  h.window.drawPartyNames = () => { throw new TypeError('missing actor'); };
  assert.equal(h.window.refresh(), 'invalid');
  assert.deepEqual(h.contents, ['title', ['invalid', 12]]);
  assert.equal(h.timers.size, 0);
  h.image('pending').width = 144;
  late(); h.tick();
  assert.equal(h.draws.length, 0);
  assert.equal(h.slots.get(1), '{"party":{"_actors":[1]}}');
});

test('missing slot contents retain the existing invalid-slot presentation without a retry', () => {
  const h = contentsFixture();
  assert.equal(h.window.refresh(), 'refresh');
  assert.deepEqual(h.contents, ['title', ['invalid', 12]]);
  assert.deepEqual(h.warnings, []);
  assert.equal(h.timers.size, 0);
});

for (const unknown of ['unknownContents', 'unknownConfirm']) {
  test('SaveCore qualifies repairs independently and preserves ' + unknown, () => {
    const h = fixture({ [unknown]: true });
    if (unknown === 'unknownContents') {
      assert.equal(h.window.drawContents, h.originals.contents);
      assert.equal(h.window.drawContents(), 'custom contents');
      assert.notEqual(h.scene.onConfirmOk, h.originals.confirm);
      assert.equal(h.hits[0][1], 'unrecognized Window_SaveInfo.drawContents');
    } else {
      assert.equal(h.scene.onConfirmOk, h.originals.confirm);
      assert.equal(h.scene.onConfirmOk(), 'custom confirmation');
      assert.notEqual(h.window.drawContents, h.originals.contents);
      assert.equal(h.hits[0][1], 'unrecognized Scene_File.onConfirmOk');
    }
    assert.equal(h.hits.length, 1);
  });
}

test('later SaveCore wrappers compose around the repaired method', () => {
  const h = fixture(), calls = [];
  h.window.drawInvalidText = value => { calls.push(value); return 'invalid'; };
  const repaired = h.window.drawContents;
  h.context.Window_SaveInfo.prototype.drawContents = function(value) {
    calls.push('later plugin');
    return repaired.call(this, value);
  };
  assert.equal(h.window.drawContents(12), 'invalid');
  assert.deepEqual(calls, ['later plugin', 12]);
});
