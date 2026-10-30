'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const modules = ['plugin-policy', 'portrait-choice-indent', 'animated-picture-loading',
  'independent-item-search', 'persistent-storage', 'mpp-gpu-fragments'];
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

for (const newline of ['\n', '\r\n']) {
  test(`animated pictures ignore replaced bitmap callbacks with ${newline === '\n' ? 'LF' : 'CRLF'} source`, () => {
    const file = 'js/plugins/Olivia_AnimatedPictures.js';
    const source = `
    function load() {
  if (this._isAnimatedPicture) {
    this.bitmap.addLoadListener(this.updateAnimatedPictureFrame.bind(this));
  } else {
    this.bitmap.addLoadListener(this.resetFrame.bind(this));
  }
    }
  `.replace(/\n/g, newline);
    const host = setup({ [file]: source });
    host.load(file);
    assert.deepEqual(host.warnings, []);
    const patched = host.source(file);
    assert.equal(patched.replace(/\r\n/g, '').includes('\n'), newline === '\n');
    assert.equal(setup({ [file]: patched }).source(file), patched);
    const callbacks = [];
    const picture = { bitmap: { addLoadListener(callback) { callbacks.push(callback); } },
      _isAnimatedPicture: true, frames: 0,
      updateAnimatedPictureFrame() { this.frames++; } };
    host.context.load.call(picture);
    picture.bitmap = { addLoadListener(callback) { callbacks.push(callback); } };
    host.context.load.call(picture);
    callbacks[0]();
    assert.equal(picture.frames, 0);
    callbacks[1]();
    assert.equal(picture.frames, 1);
  });
}

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

const itemRemoval = `
  var searches = 0, removed = [], inventory = [], equipment = [];
  var $gameParty = {
    getMatchingBaseItem(item, includeEquip) {
      searches++;
      return inventory.concat(includeEquip ? equipment : [])
        .find(copy => copy.base === item.id) || null;
    }
  };
  var party = {
    removeIndependentItem(copy, includeEquip) {
      removed.push(copy.id);
      inventory = inventory.filter(entry => entry !== copy);
      if (includeEquip) equipment = equipment.filter(entry => entry !== copy);
    },
    discard(item, amount, includeEquip) {
      for (var i = 0; i < amount; i++) {
          var target = $gameParty.getMatchingBaseItem(item, includeEquip);
          if (target !== null) this.removeIndependentItem(target, includeEquip);
      }
      return [];
    }
  };
`;

test('exhausted item removals preserve inventory, equipment and removal order', () => {
  const file = 'js/plugins/YEP_ItemCore.js';
  for (const includeEquip of [false, true]) {
    for (const amount of [0, 1, 2, 99]) {
      const host = setup({ [file]: itemRemoval });
      const control = vm.createContext({});
      vm.runInContext(itemRemoval, control);
      host.load(file);
      const run = `inventory = [{id:101,base:12},{id:102,base:13}];
        equipment = [{id:103,base:12},{id:104,base:13}];
        var result = party.discard({id:12}, ${amount}, ${includeEquip});
        JSON.stringify({inventory,equipment,removed,result});`;
      assert.equal(vm.runInContext(run, host.context), vm.runInContext(run, control));
      assert.deepEqual(host.warnings, []);
      if (amount === 99) assert.equal(host.context.searches, includeEquip ? 3 : 2);
      assert.equal(control.searches, amount);
    }
  }
});

test('empty item searches stop once and preserve exceptions from real removals', () => {
  const file = 'js/plugins/YEP_ItemCore.js';
  const host = setup({ [file]: itemRemoval });
  host.load(file);
  vm.runInContext('party.discard({id:12},99,true)', host.context);
  assert.equal(host.context.searches, 1);
  vm.runInContext(`inventory = [{id:101,base:12}];
    party.removeIndependentItem = function() { throw Error('unequip failure'); };`, host.context);
  assert.throws(() => vm.runInContext('party.discard({id:12},99,true)', host.context), /unequip failure/);
});

test('item removal patch accepts line endings, stays idempotent and refuses unknown sites', () => {
  const file = 'js/plugins/YEP_ItemCore.js';
  for (const source of [itemRemoval, itemRemoval.replace(/\n/g, '\r\n')]) {
    const files = { [file]: source }, host = setup(files);
    const patched = host.source(file);
    assert.notEqual(patched, source);
    assert.equal(files[file], source);
    files[file] = patched;
    assert.equal(host.source(file), patched);
    assert.deepEqual(host.warnings, []);
  }
  for (const source of [itemRemoval.replace('target !== null', 'target != null'), itemRemoval + itemRemoval]) {
    const host = setup({ [file]: source });
    assert.equal(host.source(file), source);
    assert.match(host.warnings[0], /unrecognized stop exhausted independent-item searches/);
  }
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

test('early optimization rewrites require a matching file contract while compatibility fixes remain independent', () => {
  const item = 'js/plugins/YEP_ItemCore.js';
  const portrait = 'js/plugins/master2015hp_InStarTimeSnippet.js';
  const host = setup({ [item]: itemRemoval, [portrait]: snippet }, { reviewed: false });
  assert.equal(host.source(item), itemRemoval);
  assert.match(host.warnings[0], /unrecognized stop exhausted independent-item searches source/);
  assert.notEqual(host.source(portrait), snippet);
});

test('early optimization rewrites fail closed when source qualification support is absent', () => {
  const file = 'js/plugins/YEP_ItemCore.js';
  const host = setup({ [file]: itemRemoval });
  delete host.context.PMJS.isatSourceMatches;
  assert.equal(host.source(file), itemRemoval);
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

test('demo selection registers only its picture fix and preserves callback ownership', () => {
  const root = path.join(__dirname, '../../../patches/isat');
  const entries = require('../../../patches/isat/demo/entry.json').modules;
  assert.deepEqual(entries, ['../source-patches.js', 'animated-picture-loading.js']);
  const file = 'js/plugins/Olivia_AnimatedPictures.js';
  const authored = "if(this[_0x530c('0x27')]){this[_0x530c('0x26')][_0x530c('0x17')](this[_0x530c('0x2b')][_0x530c('0x18')](this));}else{this['bitmap'][_0x530c('0x17')](this[_0x530c('0x35')][_0x530c('0x18')](this));}";
  const original = `function load() { ${authored} }`;
  let input = original;
  const registrations = [];
  const context = vm.createContext({ console: { log() {}, warn() {} },
    NativeHost: { fs: { readText(request) { assert.equal(request, file); return input; } } },
    PMJS: { phases: { on() {} } },
    _0x530c(key) { return { '0x27': '_isAnimatedPicture', '0x26': 'bitmap',
      '0x17': 'addLoadListener', '0x2b': 'updateAnimatedPictureFrame',
      '0x18': 'bind', '0x35': 'resetFrame' }[key]; }
  });
  for (const entry of entries) vm.runInContext(fs.readFileSync(path.resolve(root, 'demo', entry), 'utf8'), context);
  assert.deepEqual(Object.keys(context.PMJS).sort(), ['isatSourcePatches', 'phases']);
  const transformed = context.NativeHost.fs.readText(file);
  assert.notEqual(transformed, original);
  input = transformed;
  assert.equal(context.NativeHost.fs.readText(file), transformed);
  vm.runInContext(transformed, context);
  const first = { addLoadListener(callback) { registrations.push(callback); } };
  const second = { addLoadListener(callback) { registrations.push(callback); } };
  let frames = 0;
  const sprite = { bitmap: first, _isAnimatedPicture: true,
    updateAnimatedPictureFrame() { frames++; }, resetFrame() { throw Error('unexpected reset'); } };
  context.load.call(sprite); sprite.bitmap = second; context.load.call(sprite);
  registrations[0](); assert.equal(frames, 0);
  registrations[1](); assert.equal(frames, 1);
  const full = setup({ [file]: original });
  assert.equal(full.source(file), original, 'full-game inventory does not select the demo transform');
});
