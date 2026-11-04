'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const game = process.env.PMJS_ISAT_REFERENCE_GAME ? path.resolve(process.env.PMJS_ISAT_REFERENCE_GAME) : null;
const provisioned = { skip: !game && 'requires PMJS_ISAT_REFERENCE_GAME with purchased ISAT data' };
const polls = [
  { id: 'nap', map: 2, event: 13, page: 1, start: 10 },
  { id: 'title', map: 6, event: 1, page: 0, start: 5 },
  { id: 'fast-skip-18', common: 18, start: 22, shift: true },
  { id: 'fast-skip-25-first', common: 25, start: 36, shift: true },
  { id: 'fast-skip-25-second', common: 25, start: 108, shift: true },
  { id: 'teleport-menu', common: 108, start: 39 },
  { id: 'teleport-selector', common: 108, start: 450 },
  { id: 'first-game-over', common: 115, start: 26 },
  { id: 'fast-skip-title', common: 216, start: 22, shift: true }
];

function data(file) {
  return JSON.parse(fs.readFileSync(path.join(game, 'data', file), 'utf8'));
}

function authoredList(spec) {
  return spec.common ? data('CommonEvents.json')[spec.common].list :
    data(`Map${String(spec.map).padStart(3, '0')}.json`).events[spec.event].pages[spec.page].list;
}

function fixture(spec, { enabled = true, savedCopy = false } = {}) {
  const warnings = [];
  const phases = [];
  const context = vm.createContext({
    __pmjsBuiltinRequire: require,
    console: { warn: value => warnings.push(value), log() {} },
    PMJS: { isatSourceQualification: { verified: true },
      phases: { on(phase, id, callback) { phases.push({ phase, callback }); } } }
  });
  require('../../helpers/runtime-context.cjs').runModule(context, 'js/pmjs-core/methods.js');
  vm.runInContext(`
    var effects = [], waits = [], messages = [], moves = [], pressed = new Set();
    var Graphics = { frameCount: 1 };
    var Scene_Title = function() {};
    var SceneManager = { changing: false, isSceneChanging: function() { return this.changing; },
      goto: function() { this.changing = true; } };
    var Input = { reads: 0, isPressed: function(key) { this.reads++; return pressed.has(key); } };
    var Game_Switches = function() { this._data = {}; };
    Game_Switches.prototype.value = function(id) { return !!this._data[id]; };
    Game_Switches.prototype.setValue = function(id, value) { this._data[id] = value; effects.push(['switch', id, value]); };
    var Game_Variables = function() { this._data = {}; };
    Game_Variables.prototype.value = function(id) { return this._data[id] || 0; };
    Game_Variables.prototype.setValue = function(id, value) { this._data[id] = value; effects.push(['variable', id, value]); };
    var Game_SelfSwitches = function() { this._data = {}; };
    Game_SelfSwitches.prototype.value = function(key) { return !!this._data[key]; };
    Game_SelfSwitches.prototype.setValue = function(key, value) { this._data[key] = value; effects.push(['self', key, value]); };
    var Game_Temp = function() {};
    Game_Temp.prototype.setSelfSwVarEvent = function(map, event) { this._selfSwVarEvent = [map, event]; };
    Game_Temp.prototype.clearSelfSwVarEvent = function() { this._selfSwVarEvent = undefined; };
    var $gameSwitches = new Game_Switches(), $gameVariables = new Game_Variables();
    var $gameSelfSwitches = new Game_SelfSwitches(), $gameTemp = new Game_Temp();
    var DataManager = { isSelfSwitch: function() { return false; }, isSelfVariable: function() { return false; } };
    var $gameMap = { _mapId: 2, mapId: function() { return this._mapId; }, refreshIfNeeded: function() {} };
    var $gameParty = { inBattle: function() { return false; } };
    var $gamePlayer = { forceMoveRoute: function(route) { moves.push(route); }, isMoveRouteForcing: function() { return false; } };
    var $gameMessage = { busy: false, isBusy: function() { return this.busy; },
      setFaceImage: function() {}, setBackground: function() {}, setPositionType: function() {},
      add: function(text) { messages.push(text); this.busy = true; } };
    var $gameScreen = { showPicture: function() {}, movePicture: function() {}, erasePicture: function() {},
      startShake: function() {} };
    var AudioManager = { playSe: function() {}, playBgm: function() {}, stopBgm: function() {} };
    var ImageManager = { requestFace: function() {}, requestCharacter: function() {}, requestPicture: function() {} };
    var Yanfly = { Core: {}, SSV: {}, Util: { displayError: function(error) { throw error; } } };
    var RG19 = { OpenPS5Activity: function() {} };
  `, context);
  const source = fs.readFileSync(path.join(game, 'js/rpg_objects.js'), 'utf8');
  const start = source.indexOf('function Game_Interpreter()');
  assert(start >= 0, 'purchased engine must contain Game_Interpreter');
  vm.runInContext(source.slice(start), context, { filename: 'reference/rpg_objects.js' });
  const manifest = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(game, 'js/plugins.js'), 'utf8'), manifest);
  const pluginsInOrder = Array.from(manifest.$plugins).filter(plugin => plugin.status &&
    ['YEP_CoreEngine', 'YEP_SelfSwVar'].includes(plugin.name)).map(plugin => plugin.name);
  assert.deepEqual(pluginsInOrder, ['YEP_CoreEngine', 'YEP_SelfSwVar']);
  for (const plugin of pluginsInOrder) {
    const namespace = plugin === 'YEP_CoreEngine' ? 'Core' : 'SSV';
    const plugins = fs.readFileSync(path.join(game, 'js/plugins', plugin + '.js'), 'utf8');
    const marker = `Yanfly.${namespace}.Game_Interpreter_command111`;
    const first = plugins.indexOf(marker);
    const last = plugins.indexOf('// Control ', first);
    assert(first >= 0 && last > first, 'effective conditional plugin source must be available');
    vm.runInContext(plugins.slice(first, last), context, { filename: `reference/${namespace}-conditional.js` });
  }
  vm.runInContext(`
    var guestWait = Game_Interpreter.prototype.wait;
    Game_Interpreter.prototype.wait = function(duration) { waits.push(duration); return guestWait.call(this, duration); };
  `, context);
  const activitySource = fs.readFileSync(path.join(game, 'js/plugins/RG19.js'), 'utf8');
  const activity = activitySource.match(/RG19\.OpenPS5Activity = (function\(\) \{[^\n]*?\});/);
  assert.ok(activity, 'reviewed activity method must be available');
  context.RG19.OpenPS5Activity = vm.runInContext('(' + activity[1] + ')', context);
  if (enabled) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../../../patches/isat/input-polling.js'), 'utf8'), context);
    const installers = phases.filter(entry => entry.phase === 'afterPlugins');
    assert.equal(installers.length, 1);
    assert.equal(installers[0].callback(), true);
    assert.deepEqual(warnings, []);
  }
  const list = authoredList(spec);
  context.commands = savedCopy ? JSON.parse(JSON.stringify(list)) : list;
  context.commonEvents = data('CommonEvents.json');
  context.mapId = spec.map || 86;
  context.eventId = spec.event || 16;
  context.startIndex = spec.start;
  vm.runInContext(`
    $dataCommonEvents = commonEvents;
    $gameMap._mapId = mapId;
    var interpreter = new Game_Interpreter();
    interpreter._mapId = mapId; interpreter._eventId = eventId;
    interpreter._list = commands; interpreter._index = startIndex;
    $gameVariables._data[122] = 1;
    $gameVariables._data[347] = 4;
    $gameVariables._data[2] = 5;
  `, context);
  if (spec.shift) vm.runInContext('pressed.add("shift"); $gameSwitches._data[225] = true;', context);
  function run(source) { return vm.runInContext(source, context, { timeout: 2000 }); }
  return { context, list, run,
    update() { run('Graphics.frameCount++; interpreter.update();'); },
    state() { return run('JSON.stringify({switches:$gameSwitches._data,variables:$gameVariables._data,self:$gameSelfSwitches._data,effects:effects,moves:moves,messages:messages})'); } };
}

test('real JsonEx restores polling, waits and branches for direct and child interpreters', provisioned, () => {
  const core = fs.readFileSync(path.join(game, 'js/rpg_core.js'), 'utf8');
  const start = core.indexOf('function JsonEx()');
  const end = core.indexOf('function Decrypter()', start);
  assert(start >= 0 && end > start, 'original JsonEx implementation must be available');
  for (const spec of polls) for (const nested of [false, true]) {
    const f = fixture(spec);
    vm.runInContext(core.slice(start, end), f.context);
    f.run('var window = globalThis; interpreter._list = JSON.parse(JSON.stringify(interpreter._list));');
    f.update();
    const before = f.state();
    f.run(`
      interpreter._waitCount = 2;
      var savedPosition = interpreter._index, savedBranch = JSON.stringify(interpreter._branch);
      var originalList = interpreter._list;
      var holder = new Game_Interpreter();
      holder._list = [{code:0,indent:0,parameters:[]}];
      holder._childInterpreter = interpreter;
    `);
    f.context.nested = nested;
    f.run(`
      var restored = JsonEx.parse(JsonEx.stringify(nested ? holder : interpreter));
      interpreter = nested ? restored._childInterpreter : restored;
    `);
    assert.equal(f.run('interpreter instanceof Game_Interpreter'), true, spec.id);
    assert.equal(f.run('interpreter._list === originalList'), false, spec.id);
    assert.equal(f.run('interpreter._index === savedPosition'), true, spec.id);
    assert.equal(f.run('JSON.stringify(interpreter._branch) === savedBranch'), true, spec.id);
    assert.equal(f.run('interpreter._waitCount'), 2, spec.id);
    for (let tick = 0; tick < 3; tick++) {
      f.run('Graphics.frameCount++; restored.update();');
    }
    assert(f.run('interpreter._freezeChecker') < 150, spec.id + ' must retain bounded polling');
    assert.equal(f.run('interpreter._waitCount'), 0, spec.id);
    assert.equal(f.state(), before, spec.id + ' must preserve idle game state');
  }
});

for (const spec of polls) {
  for (const savedCopy of [false, true]) {
    test(`authored ${spec.id} ${savedCopy ? 'saved copy' : 'database list'} bounds idle polling without changing state`, provisioned, () => {
      const f = fixture(spec, { savedCopy });
      const before = f.state();
      const authored = JSON.stringify(f.list);
      for (let update = 0; update < 3; update++) {
        f.update();
        assert(f.run('interpreter._freezeChecker') < 150, 'idle work must finish far below the stock 100k guard');
        assert.equal(f.run('interpreter._waitCount'), 0, 'cooperative yield must not insert authored wait frames');
      }
      assert.equal(f.state(), before);
      assert.equal(JSON.stringify(f.list), authored);
      assert.equal(f.run('interpreter._list === commands'), true);
    });
  }
}

test('the same authored Nap loop reaches the stock iteration guard without the repair', provisioned, () => {
  const f = fixture(polls[0], { enabled: false });
  f.update();
  assert(f.run('interpreter._freezeChecker') >= 100000);
});

test('an identical map list under a different event owner retains stock scheduling', provisioned, () => {
  const f = fixture(polls[0]);
  f.run('interpreter._mapId = 3;');
  f.update();
  assert(f.run('interpreter._freezeChecker') >= 100000);
});

test('an extracted input loop outside the reviewed command list retains stock scheduling', provisioned, () => {
  const f = fixture(polls.find(spec => spec.id === 'fast-skip-18'));
  f.run('interpreter._list = commands.slice(21, 30); interpreter._index = 0;');
  f.update();
  assert(f.run('interpreter._freezeChecker') >= 100000);
});

test('mutating an admitted loop revokes its scheduling shortcut on the next update', provisioned, () => {
  const f = fixture(polls.find(spec => spec.id === 'fast-skip-18'), { savedCopy: true });
  f.update();
  f.run('commands[22].parameters.push("changed-contract");');
  f.update();
  assert(f.run('interpreter._freezeChecker') >= 100000);
  assert.equal(f.run('commands[22].parameters[2]'), 'changed-contract');
});

test('qualification replacement restores stock polling scheduling', provisioned, () => {
  const f = fixture(polls[0]);
  f.update();
  f.run('PMJS.isatSourceQualification = { verified: true };');
  f.update();
  assert(f.run('interpreter._freezeChecker') >= 100000);
});

test('Nap parallel timer advances normally and authored dialogue interrupts idle polling', provisioned, () => {
  const f = fixture(polls[0]);
  f.context.timerCommands = data('Map002.json').events[12].pages[0].list;
  f.run('var timer = new Game_Interpreter(); timer._list = timerCommands; timer._eventId = 12; timer._mapId = 2;');
  for (let update = 0; update < 240; update++) {
    f.run('Graphics.frameCount++; timer.update(); interpreter.update();');
    assert(f.run('interpreter._freezeChecker') < 150);
    assert.equal(f.run('messages.length'), 0);
  }
  f.run('Graphics.frameCount++; timer.update(); interpreter.update();');
  assert.equal(f.run('$gameSwitches.value(174)'), true);
  assert.equal(f.run('interpreter._waitMode'), 'message');
  assert.equal(f.run('messages.length'), 1);
  assert.equal(f.run('messages[0]'), f.list[57].parameters[0]);
});

test('fresh directional input leaves Nap and preserves the authored wake-up changes', provisioned, () => {
  const f = fixture(polls[0]);
  f.update();
  f.run('pressed.add("down"); $gameSwitches._data[144] = true; $gameSwitches._data[163] = true;');
  for (let tick = 0; tick < 4 && f.run('interpreter.isRunning()'); tick++) f.update();
  assert.equal(f.run('interpreter.isRunning()'), false);
  assert.equal(f.run('$gameSwitches.value(144)'), false);
  assert.equal(f.run('$gameSwitches.value(163)'), false);
  assert.equal(f.run('moves.length'), 1);
});

for (const spec of polls.filter(spec => spec.shift)) {
  test(`releasing Shift exits authored ${spec.id} and executes pending cleanup`, provisioned, () => {
    const f = fixture(spec, { savedCopy: true });
    f.update();
    f.run('pressed.clear();');
    for (let tick = 0; tick < 30 && f.run('interpreter.isRunning()'); tick++) f.update();
    assert.equal(f.run('interpreter.isRunning()'), false);
    assert.equal(f.run('$gameSwitches.value(225)'), false);
    assert.deepEqual(Array.from(f.context.waits), [10]);
  });
}

test('title fresh confirmation reaches its authored loop exit', provisioned, () => {
  const f = fixture(polls.find(spec => spec.id === 'title'));
  f.update();
  f.run('pressed.add("ok");');
  f.update();
  assert(f.run('interpreter._index') > 23);
});

for (const id of ['teleport-menu', 'first-game-over']) {
  test(`authored ${id} navigation retains both picture and explicit waits`, provisioned, () => {
    const f = fixture(polls.find(spec => spec.id === id));
    f.update();
    f.run('pressed.add("right");');
    f.update();
    assert.deepEqual(Array.from(f.context.waits), [5]);
    assert.equal(f.run('interpreter._waitCount'), 4);
    assert.equal(f.run('$gameVariables.value(122)'), 2);
    f.run('pressed.clear();');
    for (let tick = 0; tick < 5; tick++) f.update();
    assert.deepEqual(Array.from(f.context.waits), [5, 10]);
    assert.equal(f.run('interpreter._waitCount'), 9);
  });
}

test('teleport selector fresh downward input keeps the authored boundary-feedback wait', provisioned, () => {
  const f = fixture(polls.find(spec => spec.id === 'teleport-selector'));
  f.update();
  f.run('pressed.add("down");');
  f.update();
  assert.deepEqual(Array.from(f.context.waits), [25]);
  assert.equal(f.run('interpreter._waitCount'), 24);
  assert.equal(f.run('$gameVariables.value(122)'), 1);
});

test('the finite Meadow reset preserves its ordered effect trace through the actual child-event chain', provisioned, () => {
  const states = [];
  for (const enabled of [false, true]) {
    const f = fixture({ common: 1, start: 203 }, { enabled });
    for (const name of ['Items', 'Weapons', 'Armors']) f.context['$data' + name] = data(name + '.json');
    f.run(`
      $gameSwitches._data[107] = true;
      var ConfigManager = { getLanguage: function() { return 'English'; } };
      var master2015hp = { isatSnp: { getKeyName: function() { return 'Confirm'; } } };
      $gameScreen.startTint = function() { effects.push(['tone']); };
      $gameScreen.clearPictures = function() { effects.push(['clearPictures']); };
      $gamePlayer.setTransparent = function(value) { effects.push(['transparent', value]); };
      var actors = {};
      var $gameActors = { actor: function(id) {
        if (!actors[id]) actors[id] = { level: 1, currentExp: function() { return 0; },
          changeExp: function(exp) { effects.push(['exp', id, exp]); },
          recoverAll: function() { effects.push(['recover', id]); },
          hasSkill: function() { return false; },
          hasWeapon: function() { return false; }, hasArmor: function() { return false; },
          changeEquipById: function(slot, item) { effects.push(['equip', id, slot, item]); },
          learnSkill: function(skill) { effects.push(['learn', id, skill]); },
          forgetSkill: function(skill) { effects.push(['forget', id, skill]); } };
        return actors[id];
      } };
      $gameParty.members = function() { return [1,2,3,4,5].map(function(id) { return $gameActors.actor(id); }); };
      $gameParty.hasItem = function() { return false; };
      $gameParty.gainItem = function(item, amount) { effects.push(['item', item.id, amount]); };
      Game_Interpreter.prototype.bulk_self_switch = function(key, value) { effects.push(['bulkSelfSwitch', key, value]); };
      // Asset admission is outside this command-scheduling replay.
      Game_Interpreter.requestImages = function() {};
    `);
    f.update();
    assert.equal(f.run('interpreter.isRunning()'), false, 'finite reset must finish within the same update');
    assert.equal(f.run('interpreter._childInterpreter'), null);
    assert.equal(f.run('Input.reads'), 0);
    assert(f.run('effects.some(function(effect) { return effect[0] === "item"; })'));
    assert(f.run('effects.some(function(effect) { return effect[0] === "exp"; })'));
    assert.equal(f.run('effects.filter(function(effect) { return effect[0] === "bulkSelfSwitch"; }).length'), 2);
    states.push(f.state());
  }
  assert.equal(states[1], states[0]);
});
