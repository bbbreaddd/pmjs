'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const test = require('node:test');
const source = fs.readFileSync(require.resolve('../js/pmjs-plugins/srd/battle-status-gauges.js'), 'utf8');

function fixture({ disabled = false, unknown = false, composed = false } = {}) {
  const loaded = new Map(), phases = new Map(), refusals = [], calls = { full: 0, gauge: 0 };
  const config = JSON.parse(source.match(/var knownConfig = ([\s\S]*?);/)[1]);
  config.texts = [];
  config.gauges = JSON.parse(source.match(/var knownGauges = ([\s\S]*?);/)[1]);
  class Bitmap {
    constructor() {
      this.width = 160; this.height = 164; this.paintOpacity = 255;
      this._canvas = { __pmjsContentRevision: 0 };
      this._context = { globalAlpha: 1, globalCompositeOperation: 'source-over',
        _clipPaths: [], _transform: [1, 0, 0, 1, 0, 0] };
    }
    clear() { this._canvas.__pmjsContentRevision++; }
  }
  const actor = { hp: 100, mhp: 100, _atbSpeed: 500, icons: [], face: 'face',
    faceName() { return this.face; }, faceIndex() { return 0; }, allIcons() { return this.icons.slice(); },
    _buffs: [0, 0], _buffTurns: [0, 0], _states: [], _stateTurns: {}, _stateCounter: {} };
  class Status {
    constructor() {
      this._actor = actor; this.contents = new Bitmap(); this._redrawForLoad = 5;
      this._useFace = this._useIcon = true; this._texts = []; this._gauges = [1, 5];
      this._isMaster = true; this._statusWindow = { contents: new Bitmap() };
    }
    refresh() {
      calls.full++; this.contents.clear(); this._checkForRefresh = [];
      if (this._actor) this.drawItem();
      return 'full';
    }
    drawItem() {
      if (this._isMaster) this._statusWindow.contents.clear();
      this.drawAllImages(); this.drawAllTexts(); this.drawAllGauges(); this.drawIcons();
    }
    drawAllImages() {}
    drawAllTexts() {}
    drawAllGauges() {
      this.drawBasicGauge('', 0, 132, 160, 23, this._actor.hp, this._actor.mhp, '', '', '', true);
      this._checkForRefresh.push([this._actor.hp, 'actor.hp']);
      this.drawBasicGauge('', 0, 132, 160, 10, this._actor._atbSpeed, 5000, '', '', '', false);
      this._checkForRefresh.push([this._actor._atbSpeed, 'actor._atbSpeed']);
    }
    drawBasicGauge(...args) {
      calls.gauge++; calls.lastArgs = args;
      this.contents.fontFace = 'Gamefont'; this.contents.fontSize = 18; this.contents.textColor = '#ffffff';
      this.drawGaugeUpgrade();
      if (calls.throwGauge) throw new Error('gauge failure');
    }
    drawGaugeUpgrade() { this.contents._canvas.__pmjsContentRevision++; }
    drawIcons() { this._checkForRefresh.push([this._actor.allIcons(), 'actor.allIcons()']); }
    updateRefreshes() {
      for (const check of this._checkForRefresh) {
        const value = check[1] === 'actor.hp' ? this._actor.hp :
          check[1] === 'actor._atbSpeed' ? this._actor._atbSpeed : this._actor.allIcons();
        if (Array.isArray(value) && JSON.stringify(value) === JSON.stringify(check[0])) continue;
        if (value !== check[0]) { this.refresh(); break; }
      }
    }
    hpGaugeColor2() { return '#ffffff'; }
    contentsWidth() { return this.contents.width; }
    contentsHeight() { return this.contents.height; }
    lineHeight() { return 36; }
  }
  const images = { face: { width: 144, height: 144, ready: true, isReady() { return this.ready; } },
    icons: { width: 512, height: 512, ready: true, isReady() { return this.ready; } } };
  const originals = { refresh: Status.prototype.refresh, update: Status.prototype.updateRefreshes };
  const digest = fn => crypto.createHash('sha256').update(fn.toString().replace(/\r\n/g, '\n')).digest('hex');
  // Independent fixture pipeline; production fingerprint checks still execute.
  let patched = source.replace(/var knownMethods = ([\s\S]*?);/, (_, json) => {
    const hashes = JSON.parse(json);
    for (const name of Object.keys(hashes)) hashes[name] = digest(Status.prototype[name]);
    return 'var knownMethods = ' + JSON.stringify(hashes) + ';';
  }).replace(/var knownUpdates = .*?;/, 'var knownUpdates = ' + JSON.stringify([digest(originals.update)]) + ';');
  if (unknown) Status.prototype.drawItem = function() { throw new Error('unknown'); };
  if (composed) Status.prototype.updateRefreshes = function() { originals.update.call(this); };
  const context = { __pmjsBuiltinRequire: require, Window_BattleStatusUpgrade: Status,
    ImageManager: { loadFace() { return images.face; }, loadSystem() { return images.icons; } },
    SRD: { BattleStatusCustomizer: config }, TextManager: { hpA: 'HP' },
    BattleManager: { highestBaseAgi() { return calls.highestAgi || 40; } },
    PMJS: { plugins: {
      registerOptimization() {}, onLoaded(name, owner, callback) { loaded.set(name, callback); }
    }, phases: { on(name, owner, callback) { phases.set(name, callback); } },
    optimizations: { isEnabled() { return !disabled; },
      reportFallback(id, reason) { refusals.push(reason); },
      refuse(id, reason) { refusals.push(reason); } } } };
  vm.createContext(context);
  require('./helpers/runtime-context.cjs').runModule(context, 'js/pmjs-core/methods.js');
  vm.runInContext(patched, context);
  loaded.get('SRD_BattleStatusCustomizer')();
  phases.get('beforeBoot')();
  return { actor, images, Status, Bitmap, config, calls, refusals, originals,
    window() { const window = new Status(); window.refresh(); return window; },
    speed(window) { window._actor._atbSpeed += 100; window.updateRefreshes(); } };
}

test('ATB decreases, zero and full use one authored gauge draw and preserve styles', () => {
  const h = fixture(), w = h.window();
  const style = [w.contents.fontFace, w.contents.fontSize, w.contents.textColor];
  for (const value of [1000, 0, 5000, 4999, 1, 0]) {
    h.actor._atbSpeed = value; w.updateRefreshes();
    assert.equal(h.calls.full, 1);
    assert.equal(w._checkForRefresh[1][0], value);
    assert.deepEqual([w.contents.fontFace, w.contents.fontSize, w.contents.textColor], style);
    assert.deepEqual(Array.from(h.calls.lastArgs), ['', 0, 132, 160, 10, value, 5000, '#393939', '#818181', '#000000', false]);
  }
  assert.equal(h.calls.gauge, 8);
  assert.equal(w.refresh(), 'full');
  assert.equal(h.calls.full, 2);
});

for (const change of ['HP', 'maximum HP', 'icons', 'buff turns', 'face', 'contents', 'actor', 'canvas write',
  'master write', 'paint opacity', 'clip', 'transform', 'composite', 'alpha', 'label',
  'removed gauge', 'font', 'layout', 'late method', 'instance method', 'dependency', 'load', 'range', 'source replacement', 'source mutation', 'source pending']) {
  test(`${change} uses a complete refresh`, () => {
    const h = fixture(), w = h.window();
    switch (change) {
      case 'HP': h.actor.hp--; break;
      case 'maximum HP': h.actor.mhp++; break;
      case 'icons': h.actor.icons.push(4); break;
      case 'buff turns': h.actor._buffTurns[0]++; break;
      case 'face': h.actor.face = 'other'; break;
      case 'contents': w.contents = new h.Bitmap(); break;
      case 'actor': w._actor = { ...h.actor }; break;
      case 'canvas write': w.contents.clear(); break;
      case 'master write': w._statusWindow.contents.clear(); break;
      case 'paint opacity': w.contents.paintOpacity = 128; break;
      case 'clip': w.contents._context._clipPaths.push({}); break;
      case 'transform': w.contents._context._transform[4] = 1; break;
      case 'composite': w.contents._context.globalCompositeOperation = 'copy'; break;
      case 'alpha': w.contents._context.globalAlpha = 0.5; break;
      case 'label': h.config.gauges[5].text = '"ATB"'; break;
      case 'removed gauge': delete h.config.gauges[5]; break;
      case 'font': w.contents.fontFace = 'other'; break;
      case 'layout': w._gauges = [5, 1]; break;
      case 'late method': h.Status.prototype.drawAllImages = function() {}; break;
      case 'instance method': w.drawAllGauges = function() {}; break;
      case 'dependency': w._checkForRefresh.push([0, 'other']); break;
      case 'load': w._redrawForLoad = 4; break;
      case 'source replacement': h.images.face = { ...h.images.face }; break;
      case 'source mutation': h.images.icons._canvas = { __pmjsContentRevision: 1 }; break;
      case 'source pending': h.images.icons.ready = false; break;
      case 'range': h.actor._atbSpeed = 6000; break;
    }
    h.speed(w);
    assert.equal(h.calls.full, 2);
  });
}

test('unsupported refresh followed by restored configuration needs a new full baseline', () => {
  const h = fixture(), w = h.window();
  h.config.faceY = '10'; w.refresh();
  h.config.faceY = '0'; h.speed(w);
  assert.equal(h.calls.full, 3);
  h.speed(w);
  assert.equal(h.calls.full, 3);
});

test('bitmap replacement and return do not release retained contents', () => {
  const h = fixture(), w = h.window(), old = w.contents;
  w.contents = new h.Bitmap(); h.speed(w);
  w.contents = old; h.speed(w);
  assert.equal(h.calls.full, 3);
  h.speed(w); assert.equal(h.calls.full, 3);
  assert.equal(old.width, 160);
});

test('failed partial draw restores styles and invalidates its baseline', () => {
  const h = fixture(), w = h.window();
  h.calls.throwGauge = true;
  assert.throws(() => h.speed(w), /gauge failure/);
  assert.equal(w.contents.fontSize, 18);
  h.calls.throwGauge = false;
  h.speed(w); assert.equal(h.calls.full, 2);
  w.refresh(); assert.equal(h.calls.full, 3);
});

test('window fading and openness keep the same contents repaint contract', () => {
  const h = fixture(), w = h.window();
  w.contentsOpacity = w.openness = 128;
  h.speed(w); assert.equal(h.calls.full, 1);
});

test('disabled, unknown drawing and unknown refresh compositions keep authored methods', () => {
  for (const options of [{ disabled: true }, { unknown: true }, { composed: true }]) {
    const h = fixture(options);
    assert.equal(h.Status.prototype.refresh, h.originals.refresh);
    assert.equal(h.refusals.length, options.disabled ? 0 : 1);
  }
});


test('active status icons keep full composition on subsequent ATB changes', () => {
  const h = fixture(), w = h.window();
  h.actor.icons = [7]; w.refresh();
  h.speed(w); assert.equal(h.calls.full, 3);
  h.actor.icons = []; h.speed(w); assert.equal(h.calls.full, 4);
  h.speed(w); assert.equal(h.calls.full, 4);
});

test('explicit refresh always clears both contents and rebuilds refresh dependencies', () => {
  const h = fixture(), w = h.window();
  const revision = w.contents._canvas.__pmjsContentRevision;
  const masterRevision = w._statusWindow.contents._canvas.__pmjsContentRevision;
  let dependencies = w._checkForRefresh;
  for (let i = 0; i < 8; i++) {
    assert.equal(w.refresh(), 'full');
    assert.notEqual(w._checkForRefresh, dependencies);
    dependencies = w._checkForRefresh;
  }
  assert.equal(h.calls.full, 9);
  assert.equal(h.calls.gauge, 18);
  assert.ok(w.contents._canvas.__pmjsContentRevision > revision);
  assert.equal(w._statusWindow.contents._canvas.__pmjsContentRevision, masterRevision + 8);
});

test('explicit ATB and maximum changes retain the full authored refresh', () => {
  const h = fixture(), w = h.window();
  h.actor._atbSpeed = 1200;
  assert.equal(w.refresh(), 'full');
  assert.equal(h.calls.full, 2);
  assert.equal(w._checkForRefresh[1][0], 1200);
  h.calls.highestAgi = 80;
  assert.equal(w.refresh(), 'full');
  assert.equal(h.calls.full, 3);
});

for (const change of ['HP', 'maximum HP', 'icons', 'states', 'state counter', 'contents',
  'canvas write', 'master write', 'windowskin write', 'helper', 'source mutation']) {
  test(`explicit ${change} refresh updates the complete panel in the same call`, () => {
    const h = fixture(), w = h.window();
    if (change === 'windowskin write') {
      w.windowskin = { width: 192, height: 192, _canvas: { __pmjsContentRevision: 0 } };
      w.refresh();
    }
    const before = h.calls.full;
    switch (change) {
      case 'HP': h.actor.hp--; break;
      case 'maximum HP': h.actor.mhp++; break;
      case 'icons': h.actor.icons.push(4); break;
      case 'states': h.actor._states.push(35); break;
      case 'state counter': h.actor._stateCounter[35] = 2; break;
      case 'contents': w.contents = new h.Bitmap(); break;
      case 'canvas write': w.contents._canvas.__pmjsContentRevision++; break;
      case 'master write': w._statusWindow.contents._canvas.__pmjsContentRevision++; break;
      case 'windowskin write': w.windowskin._canvas.__pmjsContentRevision++; break;
      case 'helper': w.normalColor = function() { return '#ff0000'; }; break;
      case 'source mutation': h.images.face._canvas = { __pmjsContentRevision: 1 }; break;
    }
    assert.equal(w.refresh(), 'full');
    assert.equal(h.calls.full, before + 1);
  });
}

test('explicit first refresh and malformed dependencies keep the full draw path', () => {
  const initial = fixture(), first = new initial.Status();
  assert.equal(first._checkForRefresh, undefined);
  assert.equal(first.refresh(), 'full');
  assert.equal(initial.calls.full, 1);
  for (const checks of [undefined, null, [], [null, null, null],
    [[100, 'actor.hp'], [100, 'actor.hp'], [500, 'actor._atbSpeed']],
    [[100, 'actor.hp'], [[], 'actor.allIcons()'], [500, 'unknown']]]) {
    const h = fixture(), w = h.window();
    w._checkForRefresh = checks;
    assert.equal(w.refresh(), 'full');
    assert.equal(h.calls.full, 2);
    assert.equal(w._checkForRefresh.length, 3);
  }
});
