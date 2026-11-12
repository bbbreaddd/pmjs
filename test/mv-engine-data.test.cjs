'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { inspectDatabase } = require('../runner/mv-engine-data.cjs');
const { parsePluginManifest } = require('../runner/plugin-manifest.cjs');

function data() {
  return { maps: { 1: { width: 1, height: 1, data: [0, 0, 0, 0, 0, 0], scrollType: 0, events: [null,
    { id: 1, pages: [{ moveType: 0, trigger: 0, moveRoute: { list: [{ code: 0 }] }, list: [] }] }] } },
  commonEvents: [], troops: [], actors: [], classes: [], weapons: [], armors: [], states: [], skills: [], items: [], enemies: [] };
}
test('reports unsupported scripts inside events and forced movement with exact locations', () => {
  const database = data();
  database.maps[1].events[1].pages[0].list = [{ code: 355, parameters: ['anything()'] },
    { code: 205, parameters: [-1, { list: [{ code: 45, parameters: ['anything()'] }] }] }];
  const result = inspectDatabase(database);
  assert.deepEqual(result.issues, [
    { location: 'Map001.json.events[1].pages[0].list[0]', reason: 'unsupported event command 355' },
    { location: 'Map001.json.events[1].pages[0].list[1].parameters[1].list[0]', reason: 'unsupported movement command 45' },
  ]);
});
test('rejects executable conditions, variables and formulas before engine creation', () => {
  const database = data();
  database.maps[1].events[1].pages[0].list = [{ code: 111, parameters: [12, 'anything()'] }, { code: 122, parameters: [1, 1, 0, 4, 'anything()'] }];
  database.skills = [null, { id: 1, damage: { type: 1, formula: 'a.atk; anything()' } }];
  assert.equal(inspectDatabase(database).issues.length, 3);
});
test('accepts the arithmetic and condition forms without modifying caller data', () => {
  const database = data();
  database.skills = [null, { id: 1, damage: { type: 1, formula: 'a.atk * 4 * .8 - b.def * 2' } }];
  const original = structuredClone(database);
  assert.deepEqual(inspectDatabase(database).issues, []);
  assert.deepEqual(database, original);
});

test('native engine manifest admission rejects extra executable content', () => {
  assert.deepEqual(parsePluginManifest('// generated\nvar $plugins = [];', 'plugins', { literalOnly: true }).plugins, []);
  assert.throws(() => parsePluginManifest('var $plugins = []; extra();', 'plugins', { literalOnly: true }), /executable content/);
  assert.throws(() => parsePluginManifest('extra(); var $plugins = [];', 'plugins', { literalOnly: true }), /executable content/);
  assert.deepEqual(parsePluginManifest('var $plugins = []; extra();').plugins, []);
});

test('admits native control flow, inventory, conditions, variable operands and transfers', () => {
  const database = data();
  database.maps[1].events[1].pages[0].list = [
    ...[108, 112, 113, 115, 117, 118, 119, 125, 127, 128, 230, 408, 413, 602].map(code => ({ code, parameters: [] })),
    ...[[2, 'A', 0], [4, 1, 3, 1], [5, 0, 0], [6, -1, 2], [7, 10, 0], [8, 1], [9, 1, true], [10, 1, false]]
      .map(parameters => ({ code: 111, parameters })),
    { code: 122, parameters: [1, 3, 0, 2, 0, 10] },
    ...[[0, 1, 0], [3, 1, 2], [4, 0, 0], [5, -1, 2], [6, 0, 0], [7, 6, 0]]
      .map(operand => ({ code: 122, parameters: [1, 1, 0, 3, ...operand] })),
    { code: 201, parameters: [1, 1, 2, 3, 2, 0] },
  ];
  assert.deepEqual(inspectDatabase(database).issues, []);
});

test('keeps unimplemented actor, timer and screen-coordinate forms outside admission', () => {
  const database = data();
  database.maps[1].events[1].pages[0].list = [
    { code: 111, parameters: [3, 60, 0] }, { code: 111, parameters: [4, 1, 1, 'Name'] },
    { code: 122, parameters: [1, 1, 0, 3, 3, 1, 1] },
    { code: 122, parameters: [1, 1, 0, 3, 5, -1, 3] },
    { code: 122, parameters: [1, 1, 0, 3, 7, 5, 0] },
  ];
  assert.deepEqual(inspectDatabase(database).issues.map(issue => issue.reason), [
    'unsupported condition 3', 'unsupported actor condition 1', 'unsupported game-data operand 3:1',
    'unsupported game-data operand 5:3', 'unsupported game-data operand 7:5',
  ]);
});
