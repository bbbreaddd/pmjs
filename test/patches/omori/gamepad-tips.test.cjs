'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function createFixture(options = {}) {
  const loaded = new Map();
  const phases = new Map();
  const listeners = new Map();
  let getGamepads = () => options.gamepads || [];
  let hintRefreshes = 0;

  const scene = {
    _commandHints: { bitmap: {} },
    refreshCommandHints() { hintRefreshes += 1; }
  };

  function Bitmap() {}
  Bitmap.prototype.determineVendorRect = function() {
    const pads = scope.navigator.getGamepads();
    const pad = !scope.Input._lastGamepad ? pads[0] : pads[scope.Input._lastGamepad];
    if (!pad) return 0;
    if (pad.id.toLowerCase().includes('054c')) return 72;
    if (pad.mapping === 'standard') return 144;
    return 0;
  };

  function Scene_OmoriTitleScreen() {}
  Scene_OmoriTitleScreen.prototype.createCommandHints = function() {
    scene.refreshCommandHints();
  };

  function Window_OmoMenuOptionsGeneral() {}
  Window_OmoMenuOptionsGeneral.prototype.processOptionCommand = function() {
    if (this.index() === 2) {
      scope.ConfigManager.gamepadTips = this._optionsList[2].index !== 0;
    }
  };

  const scope = {
    PMJS: {
      plugins: { onLoaded(name, _owner, callback) { loaded.set(name, callback); } },
      phases: { on(name, _owner, callback) { phases.set(name, callback); } }
    },
    navigator: { getGamepads: () => getGamepads() },
    __pmjsInputSnapshot: options.snapshot || null,
    ConfigManager: {
      gamepadTips: false,
      applyData(config) { this.gamepadTips = (config && config.gamepadTips) || false; },
      restoreDefaultConfig() { this.gamepadTips = false; }
    },
    Bitmap,
    Input: {
      keyMapper: { 90: 'ok' },
      _updateGamepadState() {},
      _onKeyDown() {}
    },
    Scene_OmoriTitleScreen,
    Window_OmoMenuOptionsGeneral,
    SceneManager: { _scene: scene },
    addEventListener(type, listener) { listeners.set(type, listener); }
  };

  const context = vm.createContext(scope);
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, '../../../patches/omori/gamepad-tips.js'), 'utf8'),
    context
  );
  loaded.get('Omori BASE')();
  phases.get('afterGuestPlugins')();

  return {
    scope,
    scene,
    setGamepads(pads) { getGamepads = () => pads; },
    getHintRefreshes() { return hintRefreshes; },
    emit(type, event) { return listeners.get(type)(event); }
  };
}

test('defaults gamepadTips on when a connected generic controller exists before first config', () => {
  const fixture = createFixture({
    snapshot: { gamepads: [{ index: 0, connected: true, id: 'Generic Pad' }] }
  });
  const saved = Object.freeze({});
  fixture.scope.ConfigManager.applyData(saved);
  assert.equal(fixture.scope.ConfigManager.gamepadTips, true);
  assert.equal(fixture.scope.Input._lastGamepad, 0);
  assert.equal(fixture.getHintRefreshes(), 1);
  assert.equal(new fixture.scope.Bitmap().determineVendorRect(), 144);
  assert.deepEqual(fixture.scope.navigator.getGamepads(), []);
});

test('switches dynamically between gamepad and keyboard tips and refreshes title hints', () => {
  const fixture = createFixture();
  fixture.scope.ConfigManager.applyData({ gamepadTips: false });
  assert.equal(fixture.scope.ConfigManager.gamepadTips, false);

  fixture.scope.Input._updateGamepadState({
    index: 0,
    connected: true,
    buttons: [{ pressed: true }],
    axes: [0, 0]
  });
  assert.equal(fixture.scope.ConfigManager.gamepadTips, true);
  assert.equal(fixture.getHintRefreshes(), 1);

  fixture.scope.Input._onKeyDown({ keyCode: 90 });
  assert.equal(fixture.scope.ConfigManager.gamepadTips, false);
  assert.equal(fixture.getHintRefreshes(), 2);

  fixture.emit('gamepadconnected', { gamepad: { index: 1, connected: true } });
  assert.equal(fixture.scope.ConfigManager.gamepadTips, true);
  assert.equal(fixture.scope.Input._lastGamepad, 1);

  fixture.emit('gamepaddisconnected', { gamepad: { index: 1, connected: false } });
  assert.equal(fixture.scope.ConfigManager.gamepadTips, false);
});

test('resolves connected vendor icon slot when slot 0 is empty and preserves manual options override', () => {
  const fixture = createFixture({
    gamepads: [null, { index: 1, connected: true, id: 'Sony (Vendor: 054c)', mapping: 'standard' }]
  });
  assert.equal(new fixture.scope.Bitmap().determineVendorRect(), 72);

  const optionsWindow = new fixture.scope.Window_OmoMenuOptionsGeneral();
  optionsWindow.index = () => 2;
  optionsWindow._optionsList = [{}, {}, { index: 0 }];
  optionsWindow.processOptionCommand();
  assert.equal(fixture.scope.ConfigManager.gamepadTips, false);

  fixture.scope.Input._updateGamepadState({
    index: 1,
    connected: true,
    buttons: [],
    axes: [0.9, 0]
  });
  assert.equal(fixture.scope.ConfigManager.gamepadTips, false);

  fixture.scope.ConfigManager.restoreDefaultConfig();
  assert.equal(fixture.scope.ConfigManager.gamepadTips, true);
});
