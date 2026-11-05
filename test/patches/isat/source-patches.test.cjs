'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const modules = ['plugin-policy', 'portrait-choice-indent', 'persistent-storage', 'mpp-gpu-fragments'];
const adapter = fs.readFileSync(path.join(__dirname, '../../../patches/isat/source-patches.js'), 'utf8');

function setup(files, { reviewed = true } = {}) {
  const hooks = {}, warnings = [];
  const callbacks = {};
  const context = {
    console: { log() {}, warn(message) { warnings.push(message); } },
    PMJS: { isatSourceMatches() { return reviewed; },
      optimizations: { register() {}, isEnabled() { return true; }, refuse() {} },
      methods: { wrap() {} },
      phases: { on(phase, _id, callback) {
        (callbacks[phase] ||= []).push(callback);
        hooks[phase] = () => callbacks[phase].forEach(fn => fn());
      } } },
    NativeHost: { fs: { readText(file) {
      assert.equal(this, context.NativeHost.fs);
      return files[file] ?? null;
    } } }
  };
  const readText = context.NativeHost.fs.readText;
  vm.createContext(context);
  vm.runInContext(adapter, context);
  for (const module of modules) vm.runInContext(fs.readFileSync(
    path.join(__dirname, '../../../patches/isat', module + '.js'), 'utf8'), context);
  return { context, hooks, warnings, readText,
    source(file) { return context.NativeHost.fs.readText(file); },
    load(file) { vm.runInContext(context.NativeHost.fs.readText(file), context); } };
}

const snippet = `
  var updates = 0, overlays = 0, indented = false;
  var SceneManager = { _scene: null }, $gameTemp = null;
  var Input = { _updateGamepadState: function() { updates++; } };
  var alias_update = Input._updateGamepadState;
  Input._updateGamepadState = function(gamepad) {
    alias_update.apply(this, arguments);
    if (!SceneManager._scene._mytextSprite) return;
    overlays++;
  };
  var _Scene_Base_create = function() {};
  function create() { _Scene_Base_create.call(this); overlays++; }
  function choice() {
    if ($gameTemp._displayingBust || (this._messageBodyBustSprite.bitmap && this._messageBodyBustSprite.alpha > 0)) {
      indented = true;
    }
  }
`;

test('gamepad startup and overlay stay authored while pending busts keep the choice indent', () => {
  const file = 'js/plugins/master2015hp_InStarTimeSnippet.js';
  const files = { [file]: snippet };
  const host = setup(files);
  host.load(file);
  assert.throws(() => vm.runInContext('Input._updateGamepadState({});', host.context),
    /Cannot read properties of null/);
  assert.equal(host.context.updates, 1, 'the real controller update is preserved');
  assert.equal(host.context.overlays, 0);
  vm.runInContext(`
    $gameTemp = { isPlaytest: function() { return false; } };
    create();
    choice.call({ _messageBodyBustSprite: { _bustName: 'pending', bitmap: null } });
  `, host.context);
  assert.equal(host.context.overlays, 1, 'release scenes retain the authored overlay');
  assert.equal(host.context.indented, true);
  assert.equal(files[file], snippet, 'the user game source is unchanged');
  files[file] = host.source(file);
  assert.equal(host.source(file), files[file], 'already patched source stays unchanged');
  host.hooks.afterGuestPlugins();
  assert.equal(host.context.NativeHost.fs.readText, host.readText);
});

test('playtest overlays still update when a scene exists', () => {
  const host = setup({ 'js/plugins/master2015hp_InStarTimeSnippet.js': snippet });
  host.load('js/plugins/master2015hp_InStarTimeSnippet.js');
  vm.runInContext(`
    $gameTemp = { isPlaytest: function() { return true; } };
    SceneManager._scene = { _mytextSprite: {} };
    Input._updateGamepadState({}); create();
  `, host.context);
  assert.equal(host.context.updates, 1);
  assert.equal(host.context.overlays, 2);
});

test('persistent progress loads after slot extraction even when a save plugin replaces onLoadSuccess', () => {
  const file = 'js/plugins/JKL_PersistentData.js';
  const host = setup({ [file]: `
    var order = [];
    var DataManager = { extractSaveContents: function() { order.push('slot'); } };
    var PersistManager = { load: function() { order.push('persistent'); } };
    function Scene_Load() {}
    Scene_Load.prototype.onLoadSuccess = function() {};
var _Scene_Load_onLoadSuccess = Scene_Load.prototype.onLoadSuccess;
Scene_Load.prototype.onLoadSuccess = function() {
_Scene_Load_onLoadSuccess.call(this);
PersistManager.load();
}
  ` });
  host.load(file);
  vm.runInContext(`
    Scene_Load.prototype.onLoadSuccess = function() {};
    DataManager.extractSaveContents({});
  `, host.context);
  assert.deepEqual(Array.from(host.context.order), ['slot', 'persistent']);
});

test('unsupported encounter revisions roll back every transform and report the mismatch', () => {
  const file = 'js/plugins/MPP_EncounterEffect.js';
  const source = 'return !Utils.isMobileDevice();\nSprite_Fragment.FlashRate = Utils.isMobileDevice() ? 24 : 8;';
  const host = setup({ [file]: source });
  assert.equal(host.source(file), source);
  assert.match(host.warnings[0], /unrecognized Native GPU encounter presenter/);
  assert.equal(host.source('missing'), null);
});

test('the native plugin policy keeps portable achievements and disables development export and display', () => {
  const host = setup({});
  vm.runInContext(`var $plugins = [
    { name: 'ExportMessagesToText', status: true },
    { name: 'OrangeGreenworks', status: false },
    { name: 'master2015hp_InStarTimeSnippet', status: true,
      parameters: { 'draw pressed gamepad': 'true', other: 'preserved' } },
    { name: 'Other', status: true }
  ];`, host.context);
  host.hooks.beforePlugins();
  assert.deepEqual(Array.from(host.context.$plugins, plugin => plugin.status), [false, true, true, true]);
  const parameters = host.context.$plugins[2].parameters;
  assert.equal(parameters['draw pressed gamepad'], 'false');
  assert.equal(parameters.other, 'preserved');
});

test('early optimization rewrites require source qualification', () => {
  const host = setup({ 'custom.js': 'original' }, { reviewed: false });
  host.context.PMJS.isatSourcePatches.register('custom.js', 'optimization', text => text + ':changed', 'optimization');
  assert.equal(host.source('custom.js'), 'original');
  assert.match(host.warnings[0], /unrecognized optimization source/);
  delete host.context.PMJS.isatSourceMatches;
  assert.equal(host.source('custom.js'), 'original');
});

test('source fixes register independently and apply in order with atomic rollback', () => {
  const host = setup({ 'custom.js': 'original' });
  const register = host.context.PMJS.isatSourcePatches.register;
  const calls = [];
  register('custom.js', 'first', text => { calls.push(text); return text + ':first'; });
  register('custom.js', 'second', text => { calls.push(text); return text + ':second'; });
  assert.equal(host.source('custom.js'), 'original:first:second');
  assert.deepEqual(calls, ['original', 'original:first']);
  register('custom.js', 'unsupported', text => text);
  assert.equal(host.source('custom.js'), 'original');
  assert.match(host.warnings[0], /unrecognized unsupported/);
});

test('reader restoration preserves a later owner', () => {
  const host = setup({});
  const replacement = () => 'other owner';
  host.context.NativeHost.fs.readText = replacement;
  host.hooks.afterGuestPlugins();
  assert.equal(host.context.NativeHost.fs.readText, replacement);
});
