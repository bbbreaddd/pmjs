'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
function fixture(schema = true) {
  const loading = new Map(), loaded = new Map();
  const scope = { PMJS: { plugins: {
    onLoading(name, owner, callback) { loading.set(name, callback); },
    onLoaded(name, owner, callback) { loaded.set(name, callback); }
  } }, NativeHost: { runtime: { omoriBackports: schema ? { generalOptionsSchema: true } : {} } } };
  const context = vm.createContext(scope);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../../patches/omori/v1-compatibility.js'), 'utf8'), context);
  return { scope, context, loading, loaded };
}

test('text skip controls the captured message handler and survives config round trips and reset', () => {
  const f = fixture(), shared = { volume: 90 };
  f.scope.Window_Message = function() {};
  f.scope.Window_Message.prototype.updateShowFast = function() { this._showFast = true; return 'fast'; };
  f.scope.ConfigManager = {
    makeData: () => shared,
    applyData(config) { this.volume = config.volume; return 'applied'; },
    restoreDefaultConfig() { this.savedDefault = this.textSkip; return 'restored'; }
  };
  f.loading.get('TDDP_NoFastForward')();
  vm.runInContext('Window_Message.prototype.updateShowFast = function() { if ($.isTextFfDisabled()) return false; };', f.context);
  f.loaded.get('TDDP_NoFastForward')();
  f.loaded.get('Omori BASE')();
  const config = f.scope.ConfigManager, message = new f.scope.Window_Message();
  assert.equal(message.updateShowFast(), false);
  assert.equal(message._showFast, undefined);
  assert.equal(config.applyData(Object.freeze({ volume: 50, textSkip: true })), 'applied');
  assert.equal(message.updateShowFast(), 'fast');
  assert.equal(message._showFast, true);
  const saved = config.makeData();
  assert.equal(saved.textSkip, true);
  assert.equal(saved.volume, 90);
  assert.deepEqual(shared, { volume: 90 });
  config.textSkip = false; config.applyData(saved);
  assert.equal(config.textSkip, true);
  assert.equal(config.restoreDefaultConfig(), 'restored');
  assert.equal(config.textSkip, false);
  assert.equal(config.savedDefault, false);
  config.applyData({ volume: 20 });
  assert.equal(config.textSkip, false);
  assert.equal(f.scope.PMJS.omori.backports.textSkip, true);
});

test('six-row options route text, battle speed and movement to their own settings', () => {
  const f = fixture(), originalCalls = [];
  f.scope.ConfigManager = {};
  f.scope.Window_OmoMenuOptionsGeneral = function() {};
  f.scope.Window_OmoMenuOptionsGeneral.prototype.processOptionCommand = function() { originalCalls.push(this.index()); return 'base'; };
  f.loaded.get('Omori Main Menu - Scene Options')();
  const window = new f.scope.Window_OmoMenuOptionsGeneral();
  window._optionsList = Array.from({ length: 6 }, () => ({ index: 0 }));
  let index = 2; window.index = () => index;
  assert.equal(window.processOptionCommand(), 'base');
  assert.deepEqual(originalCalls, [2]);
  index = 3; window.processOptionCommand();
  assert.equal(f.scope.ConfigManager.textSkip, true);
  index = 4; window._optionsList[4].index = 2; window.processOptionCommand();
  assert.equal(f.scope.ConfigManager.battleLogSpeed, 2);
  index = 5; window.processOptionCommand();
  assert.equal(f.scope.ConfigManager.alwaysDash, true);
  assert.equal(f.scope.ConfigManager.textSkip, true);
});

test('legacy title creates one hint sprite and refreshes localized labels and icons', () => {
  const f = fixture(), draws = [], children = [];
  f.scope.Scene_OmoriTitleScreen = function() {};
  f.scope.Scene_OmoriTitleScreen.prototype.create = function() { this.created = true; return 42; };
  f.scope.Scene_OmoriTitleScreen.prototype.addChild = child => children.push(child);
  f.scope.Graphics = { boxWidth: 640, boxHeight: 480 };
  f.scope.Bitmap = function(width, height) { this.width = width; this.height = height; };
  Object.assign(f.scope.Bitmap.prototype, { clear() { draws.push('clear'); },
    drawInputIcon(key) { draws.push(key); }, drawText(label) { draws.push(label); }, measureTextWidth: () => 50 });
  f.scope.Sprite = function(bitmap) { this.bitmap = bitmap; this.width = bitmap.width; this.position = { set(x, y) { this.x = x; this.y = y; } }; };
  const labels = { confirm: 'CONFIRM', cancel: 'CANCEL' };
  f.scope.LanguageManager = { languageData: () => ({ text: { System: { plugins: { optionsMenu: { buttonHints: labels } } } } }) };
  f.loaded.get('Omori Title Screen')();
  const title = new f.scope.Scene_OmoriTitleScreen();
  assert.equal(title.create(), 42);
  assert.equal(title.created, true);
  title.createCommandHints();
  assert.equal(children.length, 1);
  labels.confirm = 'VALIDER'; title.refreshCommandHints();
  assert.deepEqual(draws.slice(-5), ['clear', 'ok', 'VALIDER', 'escape', 'CANCEL']);
  assert.equal(title._commandHints.position.x, 640 - title._commandHints.width);
  assert.equal(f.scope.PMJS.omori.backports.titleCommandHints, true);
  f.scope.SceneManager = { _scene: title };
  f.scope.Window_OmoMenuOptionsGeneral = function() {};
  f.scope.Window_OmoMenuOptionsGeneral.prototype.processOptionCommand = function() {};
  f.loaded.get('Omori Main Menu - Scene Options')();
  const before = draws.length;
  f.scope.Window_OmoMenuOptionsGeneral.prototype.processOptionCommand.call({ index: () => 2, _optionsList: [{}, {}, { index: 1 }] });
  assert.equal(draws.length, before + 5);
  f.scope.LanguageManager.languageData = () => ({ text: { System: { plugins: { optionsMenu: {} } } } });
  title.refreshCommandHints();
  assert.deepEqual(draws.slice(-5), ['clear', 'ok', 'CONFIRM', 'escape', 'CANCEL']);
});

test('battle cancellation clears the pending action only after returning to actor input', () => {
  const f = fixture(); let clears = 0;
  f.scope.BattleManager = { getActorInputOrder() {}, clearInputtingAction() { clears++; },
    selectPreviousCommand() { this.getActorInputOrder(); this._actorCommandIndex = this.leave ? 0 : 1; return 'previous'; } };
  f.loaded.get('Omori Battle System')();
  assert.equal(f.scope.BattleManager.selectPreviousCommand(), 'previous');
  assert.equal(clears, 1);
  f.scope.BattleManager.leave = true; f.scope.BattleManager.selectPreviousCommand();
  assert.equal(clears, 1);
  assert.equal(f.scope.PMJS.omori.backports.battleInputCleanup, true);
});

test('modern options, title hints and battle cleanup retain their implementations', () => {
  const f = fixture(false), ordinary = () => {};
  f.scope.ConfigManager = { makeData: ordinary };
  f.scope.Window_OmoMenuOptionsGeneral = function() {};
  f.scope.Window_OmoMenuOptionsGeneral.prototype.processOptionCommand = ordinary;
  f.scope.Scene_OmoriTitleScreen = function() {};
  f.scope.Scene_OmoriTitleScreen.prototype.refreshCommandHints = ordinary;
  const previous = function() { this.clearInputtingAction(); };
  f.scope.BattleManager = { selectPreviousCommand: previous };
  for (const name of ['Omori BASE', 'Omori Main Menu - Scene Options', 'Omori Title Screen', 'Omori Battle System']) f.loaded.get(name)();
  assert.equal(f.scope.ConfigManager.makeData, ordinary);
  assert.equal(f.scope.Window_OmoMenuOptionsGeneral.prototype.processOptionCommand, ordinary);
  assert.equal(f.scope.Scene_OmoriTitleScreen.prototype.refreshCommandHints, ordinary);
  assert.equal(f.scope.BattleManager.selectPreviousCommand, previous);
});
