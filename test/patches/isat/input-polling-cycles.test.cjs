'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const methods = require('./test-fixtures/input-polling-methods.cjs');

function fixture(configure) {
  const state = { input: false, variable: 0, switch: false, actions: 0, checks: 0 };
  const hooks = [], hashes = new Map(), warnings = [];
  const context = vm.createContext({ state, Input: {},
    console: { warn(message) { warnings.push(message); } },
    PMJS: { isatSourceQualification: { verified: true }, methods: {},
      phases: { on(phase, id, hook) { hooks.push({ phase, hook }); } } },
    __pmjsBuiltinRequire() { return { createHash() { return {
      update(source) { this.source = source; return this; },
      digest() { return hashes.get(this.source) || 'unreviewed'; }
    }; } }; }
  });
  vm.runInContext(`
    Input.isPressed = function() { if (state.error) throw state.error; state.checks++; return state.input; };
    Input._isEscapeCompatible = function() { return false; };
    function Game_Switches() {}
    Game_Switches.prototype.value = function() { return state.switch; };
    function Game_Variables() {}
    Game_Variables.prototype.value = function() { return state.variable; };
    var $gameSwitches = new Game_Switches(), $gameVariables = new Game_Variables();
    function Game_SelfSwitches() {}
    Game_SelfSwitches.prototype.value = function() { return false; };
    function Game_Temp() {}
    Game_Temp.prototype.setSelfSwVarEvent = function() {};
    Game_Temp.prototype.clearSelfSwVarEvent = function() {};
    var DataManager = { isSelfSwitch() {}, isSelfVariable() {} };
    var RG19 = { OpenPS5Activity: function() {} };
    var Yanfly = { SSV: { Game_Interpreter_command111: function pluginCondition() {} },
      Core: { Game_Interpreter_command111: function stockCondition() {} } };
    function Game_Interpreter(list) {
      this._list = list; this._index = 0; this._branch = {};
      this._waitCount = 0; this.commands = 0;
    }
    Game_Interpreter.prototype.terminate = function() { this._list = null; };
    Game_Interpreter.prototype.update = function() {
      var count = 0;
      while (this._list) {
        if (this._childInterpreter) {
          this._childInterpreter.update();
          if (this._childInterpreter._list) break;
          this._childInterpreter = null;
        }
        if (this._waitCount > 0) { this._waitCount--; break; }
        if (!this.executeCommand()) break;
        this.commands++;
        if (++count >= 100) break;
      }
      return 'authored-return';
    };
    Game_Interpreter.prototype.command355 = function() { state.actions++; return true; };
    Game_Interpreter.prototype.command122 = function() { state.variable++; return true; };
    Game_Interpreter.prototype.command230 = function() { this._waitCount = this._params[0]; return true; };
  `, context);
  const reviewed = new Set([context.Input.isPressed, context.Input._isEscapeCompatible,
    context.Game_Switches.prototype.value, context.Game_Variables.prototype.value]);
  for (const [name, method] of Object.entries(methods)) {
    const implementation = vm.runInContext('(' + method.toString() + ')', context);
    context.Game_Interpreter.prototype[name] = implementation;
    reviewed.add(implementation);
  }
  // These synthetic implementations exercise control flow, not shipped source hashes.
  context.PMJS.methods.matchesSource = method => reviewed.has(method);
  [context.Game_Interpreter.prototype.command111,
    context.Yanfly.SSV.Game_Interpreter_command111,
    context.Yanfly.Core.Game_Interpreter_command111,
    context.RG19.OpenPS5Activity].forEach(method => reviewed.add(method));
  if (configure) configure(context, state);
  const source = fs.readFileSync(path.join(__dirname, '../../../patches/isat/input-polling.js'), 'utf8');
  vm.runInContext(source, context);
  function install() {
    let result;
    for (const entry of hooks) if (entry.phase === 'afterPlugins') result = entry.hook();
    return result;
  }
  return { context, state, install, source, warnings,
    create: list => new context.Game_Interpreter(list) };
}

function command(code, indent = 0, parameters = []) { return { code, indent, parameters }; }
function inputLoop() {
  return [command(112), command(111, 1, [11, 'ok']), command(355, 2), command(113, 2),
    command(0, 2), command(412, 1), command(0, 1), command(413), command(0)];
}

test('unreviewed input cycles preserve the original scheduling, including fresh input', () => {
  for (const input of [false, true]) {
    const baseline = fixture(), candidate = fixture();
    candidate.install();
    baseline.state.input = candidate.state.input = input;
    const left = baseline.create(inputLoop()), right = candidate.create(inputLoop());
    const before = JSON.stringify(right._list);
    assert.equal(right.update(), left.update());
    assert.deepEqual(candidate.state, baseline.state);
    for (const key of ['_index', '_waitCount', 'commands']) assert.equal(right[key], left[key]);
    if (!input) assert.equal(JSON.stringify(right._list), before);
  }
});

test('a list with an audited length but different contents keeps ordinary execution', () => {
  const f = fixture(); f.install();
  const list = inputLoop();
  while (list.length < 55) list.push(command(0));
  const i = f.create(list);
  i.update();
  assert.ok(f.state.checks > 10);
});

test('predicate exceptions propagate for unreviewed lists', () => {
  const f = fixture(); f.install();
  const error = new Error('predicate failed'); f.state.error = error;
  const i = f.create(inputLoop());
  assert.throws(() => i.update(), caught => caught === error);
  f.state.error = null; i.update();
  assert.ok(f.state.checks > 10);
});

test('unqualified sources, missing plugins and unknown conditional methods remain untouched', () => {
  for (const change of [
    context => { context.PMJS.isatSourceQualification.verified = false; },
    context => { context.Yanfly = undefined; },
    context => { delete context.Yanfly.SSV; },
    context => { context.Game_Interpreter.prototype.command111 = function changed() {}; },
    context => { context.Yanfly.SSV.Game_Interpreter_command111 = function changed() {}; },
    context => { context.Yanfly.Core.Game_Interpreter_command111 = function changed() {}; }
  ]) {
    const f = fixture(change), proto = f.context.Game_Interpreter.prototype;
    const update = proto.update, execute = proto.executeCommand;
    assert.equal(f.install(), false);
    assert.equal(proto.update, update);
    assert.equal(proto.executeCommand, execute);
  }
});

test('installation is idempotent and unknown dispatchers are untouched', () => {
  const f = fixture();
  assert.equal(f.install(), true);
  const execute = f.context.Game_Interpreter.prototype.executeCommand;
  vm.runInContext(f.source, f.context);
  assert.equal(f.install(), true);
  assert.equal(f.context.Game_Interpreter.prototype.executeCommand, execute);
  const unknown = fixture(context => { context.Game_Interpreter.prototype.executeCommand = function() {}; });
  assert.equal(unknown.install(), false);
});
