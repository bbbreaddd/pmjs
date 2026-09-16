'use strict';

const assert = require('node:assert');
const test = require('node:test');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const modulePath = path.join(__dirname, '../js/pmjs-mv/autorun-events.js');

function makeHost() {
  const context = {};
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(modulePath, 'utf8'), context, {
    filename: 'pmjs-mv/autorun-events.js'
  });
  return context;
}

const STOCK_SOURCE =
  'Game_Map.prototype.setupAutorunCommonEvent = function() {\r\n' +
  '    for (var i = 0; i < $dataCommonEvents.length; i++) {\r\n' +
  '        var event = $dataCommonEvents[i];\r\n' +
  '        if (event && event.trigger === 1 && $gameSwitches.value(event.switchId)) {\r\n' +
  '            this._interpreter.setup(event.list);\r\n' +
  '            return true;\r\n' +
  '        }\r\n' +
  '    }\r\n' +
  '    return false;\r\n' +
  '};';

function installStockMethod(context) {
  context.Game_Map = function GameMap() {
    this._interpreter = { setup(list) { this.list = list; } };
  };
  vm.runInContext(STOCK_SOURCE, context, { filename: 'stock-shape.js' });
}

test('autorun index accepts the pinned stock fingerprint', () => {
  const context = makeHost();
  installStockMethod(context);
  context.$dataCommonEvents = [null];
  context.$gameSwitches = { value() { return false; } };
  assert.equal(context.pmjsInstallAutorunCommonEventIndex(context), true);
  assert.equal(typeof context.Game_Map.prototype.__pmjsAutorunCommonEventIndex,
    'boolean');
});

test('autorun index preserves first-match order with live switches', () => {
  const context = makeHost();
  installStockMethod(context);
  const first = { trigger: 1, switchId: 11, list: ['first'] };
  const second = { trigger: 1, switchId: 12, list: ['second'] };
  context.$dataCommonEvents = [null,
    { trigger: 0, switchId: 0, list: ['normal'] }, first,
    { trigger: 2, switchId: 11, list: ['parallel'] }, second];
  const switched = { 11: true, 12: true };
  context.$gameSwitches = { value(id) { return !!switched[id]; } };
  assert.equal(context.pmjsInstallAutorunCommonEventIndex(context), true);
  const map = new context.Game_Map();
  assert.equal(map.setupAutorunCommonEvent(), true);
  assert.deepEqual(map._interpreter.list, ['first']);
  switched[11] = false;
  assert.equal(map.setupAutorunCommonEvent(), true);
  assert.deepEqual(map._interpreter.list, ['second']);
  switched[12] = false;
  assert.equal(map.setupAutorunCommonEvent(), false);
  assert.deepEqual(context.pmjsAutorunCommonEventStats(), {
    rebuilds: 1, fallbackCalls: 0, setupInvalidations: 0
  });
});

test('autorun index reads list and switchId live without rebuilding', () => {
  const context = makeHost();
  installStockMethod(context);
  const entry = { trigger: 1, switchId: 11, list: ['v1'] };
  context.$dataCommonEvents = [null, entry];
  const switched = { 11: true, 99: false };
  context.$gameSwitches = { value(id) { return !!switched[id]; } };
  assert.equal(context.pmjsInstallAutorunCommonEventIndex(context), true);
  const map = new context.Game_Map();
  assert.equal(map.setupAutorunCommonEvent(), true);
  assert.deepEqual(map._interpreter.list, ['v1']);
  entry.list = ['v2'];
  entry.switchId = 99;
  assert.equal(map.setupAutorunCommonEvent(), false);
  switched[99] = true;
  assert.equal(map.setupAutorunCommonEvent(), true);
  assert.deepEqual(map._interpreter.list, ['v2']);
  entry.trigger = 0;
  assert.equal(map.setupAutorunCommonEvent(), false);
  assert.deepEqual(context.pmjsAutorunCommonEventStats(), {
    rebuilds: 1, fallbackCalls: 0, setupInvalidations: 0
  });
});

test('autorun index rebuilds on replacement, reorder, and edits', () => {
  const context = makeHost();
  installStockMethod(context);
  const entry = { trigger: 1, switchId: 7, list: ['a'] };
  context.$dataCommonEvents = [null, entry];
  context.$gameSwitches = { value() { return true; } };
  assert.equal(context.pmjsInstallAutorunCommonEventIndex(context), true);
  const map = new context.Game_Map();
  assert.equal(map.setupAutorunCommonEvent(), true);
  context.$dataCommonEvents = [null, { trigger: 1, switchId: 8, list: ['b'] }];
  assert.equal(map.setupAutorunCommonEvent(), true);
  assert.deepEqual(map._interpreter.list, ['b']);
  const other = { trigger: 1, switchId: 9, list: ['c'] };
  context.$dataCommonEvents = [null, other, context.$dataCommonEvents[1]];
  assert.equal(map.setupAutorunCommonEvent(), true);
  assert.deepEqual(map._interpreter.list, ['c']);
  entry.trigger = 0;
  context.$dataCommonEvents = [null, entry];
  assert.equal(map.setupAutorunCommonEvent(), false);
  context.$dataCommonEvents = 'broken';
  assert.equal(map.setupAutorunCommonEvent(), false);
  context.pmjsRebuildAutorunCommonEvents();
  assert.deepEqual(context.pmjsAutorunCommonEventStats(), {
    rebuilds: 4, fallbackCalls: 1, setupInvalidations: 0
  });
});

test('autorun index rejects extra conditions despite stock tokens', () => {
  const context = makeHost();
  context.Game_Map = function GameMap() {};
  context.Game_Map.prototype.setupAutorunCommonEvent = new Function(
    'for (var i = 0; i < $dataCommonEvents.length; i++) {' +
    'var event = $dataCommonEvents[i];' +
    'if (event && event.trigger === 1 && this.someExtraAutorunPolicy(event) && ' +
    '$gameSwitches.value(event.switchId)) { return true; } } return false;'
  );
  assert.equal(context.pmjsInstallAutorunCommonEventIndex(context), false);
  assert.equal(context.Game_Map.prototype.__pmjsAutorunCommonEventIndex,
    undefined);
});

test('autorun index matches reference throw on malformed switches', () => {
  const context = makeHost();
  installStockMethod(context);
  context.$dataCommonEvents = [null, { trigger: 1, switchId: 1, list: [] }];
  context.$gameSwitches = null;
  assert.equal(context.pmjsInstallAutorunCommonEventIndex(context), true);
  const map = new context.Game_Map();
  // Cross-realm TypeError fails instanceof: match by error name instead.
  assert.throws(() => map.setupAutorunCommonEvent(),
    error => error && error.name === 'TypeError');
});

test('autorun installer is idempotent', () => {
  const context = makeHost();
  installStockMethod(context);
  context.$dataCommonEvents = [null];
  context.$gameSwitches = { value() { return false; } };
  assert.equal(context.pmjsInstallAutorunCommonEventIndex(context), true);
  const installed = context.Game_Map.prototype.setupAutorunCommonEvent;
  assert.equal(context.pmjsInstallAutorunCommonEventIndex(context), false);
  assert.equal(context.Game_Map.prototype.setupAutorunCommonEvent, installed);
});

test('mid-map eligibility creation waits for map setup', () => {
  const context = makeHost();
  installStockMethod(context);
  const latecomer = { trigger: 0, switchId: 21, list: ['late'] };
  context.Game_Map.prototype.setupEvents = function() { this.setupRan = true; };
  context.$dataCommonEvents = [null, latecomer];
  context.$gameSwitches = { value() { return true; } };
  assert.equal(context.pmjsInstallAutorunCommonEventIndex(context), true);
  const map = new context.Game_Map();
  map._interpreter = { setup(list) { this.list = list; } };
  assert.equal(map.setupAutorunCommonEvent(), false);
  // Outside the fast-path contract: stock would run this immediately.
  latecomer.trigger = 1;
  assert.equal(map.setupAutorunCommonEvent(), false);
  // Transfer bound: the next map setup invalidates; the query rebuilds.
  map.setupEvents();
  assert.equal(map.setupRan, true);
  assert.equal(map.setupAutorunCommonEvent(), true);
  assert.deepEqual(map._interpreter.list, ['late']);
  assert.deepEqual(context.pmjsAutorunCommonEventStats(), {
    rebuilds: 2, fallbackCalls: 0, setupInvalidations: 1
  });
});

test('autorun index honors the kill switch', () => {
  const context = makeHost();
  context.NativeHost = { runtime: { env(name) {
    assert.equal(name, 'PMJS_MV_AUTORUN_INDEX');
    return '0';
  } } };
  installStockMethod(context);
  context.$dataCommonEvents = [null];
  context.$gameSwitches = { value() { return false; } };
  assert.equal(context.pmjsInstallAutorunCommonEventIndex(context), false);
  assert.equal(context.Game_Map.prototype.__pmjsAutorunCommonEventIndex,
    undefined);
});
