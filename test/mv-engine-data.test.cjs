'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { temporaryDirectory } = require('./helpers/temp.cjs');
const { loadGame, detectRpgMakerEngine, inspectDatabase, resolveBasicSettings } = require('../runner/mv-engine-data.cjs');
const { parsePluginManifest } = require('../runner/plugin-manifest.cjs');

function data() {
  return { maps: { 1: { width: 1, height: 1, data: [0, 0, 0, 0, 0, 0], scrollType: 0, events: [null,
    { id: 1, pages: [{ moveType: 0, trigger: 0, moveRoute: { list: [{ code: 0 }] }, list: [] }] }] } },
  commonEvents: [], troops: [], actors: [], classes: [], weapons: [], armors: [], states: [], skills: [], items: [], enemies: [] };
}
test('admits scripts inside events and forced movement', () => {
  const database = data();
  database.maps[1].events[1].pages[0].list = [{ code: 355, parameters: ['anything()'] },
    { code: 205, parameters: [-1, { list: [{ code: 45, parameters: ['anything()'] }] }] }];
  const result = inspectDatabase(database);
  assert.deepEqual(result.issues, []);
});
test('reports unsupported formulas without rejecting script conditions or variables', () => {
  const database = data();
  database.maps[1].events[1].pages[0].list = [{ code: 111, parameters: [12, 'anything()'] }, { code: 122, parameters: [1, 1, 0, 4, 'anything()'] }];
  database.skills = [null, { id: 1, damage: { type: 1, formula: 'a.atk; anything()' } }];
  assert.deepEqual(inspectDatabase(database).issues, [{ location: 'skills[1].damage.formula', reason: 'unsupported damage expression' }]);
});
test('accepts the arithmetic and condition forms without modifying caller data', () => {
  const database = data();
  database.skills = [null, { id: 1, damage: { type: 1, formula: 'a.atk * 4 * .8 - b.def * 2' } }];
  const original = structuredClone(database);
  assert.deepEqual(inspectDatabase(database).issues, []);
  assert.deepEqual(database, original);
});

test('plugin manifest parser retains its optional literal-only mode', () => {
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

test('reports unknown actor and screen-coordinate forms', () => {
  const database = data();
  database.maps[1].events[1].pages[0].list = [
    { code: 111, parameters: [999, 60, 0] }, { code: 111, parameters: [4, 1, 999, 'Name'] },
    { code: 122, parameters: [1, 1, 0, 3, 3, 1, 12] },
    { code: 122, parameters: [1, 1, 0, 3, 5, -1, 5] },
    { code: 122, parameters: [1, 1, 0, 3, 7, 10, 0] },
  ];
  assert.deepEqual(inspectDatabase(database).issues.map(issue => issue.reason), [
    'unsupported condition 999', 'unsupported actor condition 999', 'unsupported game-data operand 3:12',
    'unsupported game-data operand 5:5', 'unsupported game-data operand 7:10',
  ]);
});

test('resolves Community_Basic screen, cache, dash, rendering and window settings', () => {
  assert.deepEqual(resolveBasicSettings({ plugins: [] }), {
    width: 816, height: 624, imageCacheBytes: 10000000, alwaysDash: false, renderingMode: 'auto',
  });
  assert.deepEqual(resolveBasicSettings({
    plugins: [{
      name: 'Community_Basic',
      status: true,
      parameters: {
        screenWidth: '1024',
        screenHeight: '576',
        cacheLimit: '25',
        alwaysDash: 'ON',
        renderingMode: 'WebGL',
      },
    }],
  }), {
    width: 1024,
    height: 576,
    imageCacheBytes: 25000000,
    alwaysDash: true,
    renderingMode: 'webgl',
    windowWidth: 1024,
    windowHeight: 576,
  });
  assert.deepEqual(resolveBasicSettings({
    plugins: [{
      name: 'Community_Basic',
      status: true,
      parameters: {
        screenWidth: '816',
        screenHeight: '624',
        changeWindowWidthTo: '1280',
        changeWindowHeightTo: '720',
      },
    }],
  }), {
    width: 816,
    height: 624,
    imageCacheBytes: 10000000,
    alwaysDash: false,
    renderingMode: 'auto',
    windowWidth: 1280,
    windowHeight: 720,
  });
  assert.throws(() => resolveBasicSettings({
    plugins: [{ name: 'Community_Basic', status: true, parameters: { renderingMode: 'canvas' } }],
  }), /unsupported rendering mode/);
  assert.throws(() => resolveBasicSettings({
    plugins: [{ name: 'Community_Basic', status: true, parameters: { screenWidth: '0' } }],
  }), /invalid dimensions/);
});

function gameFiles() {
  const root = temporaryDirectory('mv-engine-admission-');
  for (const folder of ['js', 'data', 'fonts']) fs.mkdirSync(path.join(root, folder));
  fs.writeFileSync(path.join(root, 'js/rpg_core.js'), `
    Utils.RPGMAKER_NAME = 'MV';
    Tilemap.FLOOR_AUTOTILE_TABLE = [];
    Tilemap.WALL_AUTOTILE_TABLE = [];
    Tilemap.WATERFALL_AUTOTILE_TABLE = [];
    customEngineChange();
  `);
  fs.writeFileSync(path.join(root, 'js/plugins.js'), 'var $plugins = [{"name":"CustomPlugin","status":true,"parameters":{}}];');
  fs.writeFileSync(path.join(root, 'fonts/gamefont.css'), '@font-face { font-family: GameFont; src: url("game.ttf"); }');
  fs.writeFileSync(path.join(root, 'fonts/game.ttf'), 'font-fixture');
  const database = data();
  database.system = { startMapId: 1 };
  database.tilesets = []; database.animations = []; database.mapInfos = [null, { id: 1 }];
  database.maps[1].events[1].pages[0].list = [{ code: 9999, parameters: [] }];
  for (const [name, value] of Object.entries(database)) {
    if (name === 'maps') continue;
    fs.writeFileSync(path.join(root, 'data', name[0].toUpperCase() + name.slice(1) + '.json'), JSON.stringify(value));
  }
  fs.writeFileSync(path.join(root, 'data/Map001.json'), JSON.stringify(database.maps[1]));
  return root;
}

test('loads modified MV without stock script identities or a plugin allowlist', () => {
  const root = gameFiles();
  const loaded = loadGame(root);
  assert.equal(loaded.engineFamily, 'MV');
  assert.equal(loaded.manifest.plugins[0].name, 'CustomPlugin');
  assert.deepEqual(loaded.contract.issues, [{ location: 'Map001.json.events[1].pages[0].list[0]', reason: 'unsupported event command 9999' }]);
  assert.equal(loaded.database.maps[1].events[1].pages[0].list[0].code, 9999);
});

test('unused map index entries do not require unshipped map files at startup', () => {
  const root = gameFiles();
  fs.writeFileSync(path.join(root, 'data/MapInfos.json'), JSON.stringify([null, { id: 1 }, { id: 2 }]));
  const loaded = loadGame(root);
  assert.ok(loaded.database.maps[1]);
  assert.equal(Object.hasOwn(loaded.database.maps, 2), false);
});

test('detects MZ and reports that the native MV engine cannot execute it', () => {
  const root = gameFiles();
  fs.writeFileSync(path.join(root, 'js/rmmz_core.js'), "Utils.RPGMAKER_NAME = 'MZ';");
  assert.equal(detectRpgMakerEngine(root), 'MZ');
  assert.throws(() => loadGame(root), /native-mv does not support RPG Maker MZ/);
});

test('engine detection supports older MV without a name marker and rejects unknown input', () => {
  const root = gameFiles();
  fs.writeFileSync(path.join(root, 'js/rpg_core.js'), '// older MV core');
  assert.equal(detectRpgMakerEngine(root), 'MV');
  fs.writeFileSync(path.join(root, 'js/rpg_core.js'), "Utils.RPGMAKER_NAME = 'Other';");
  assert.throws(() => detectRpgMakerEngine(root), /unrecognized RPG Maker engine/);
  fs.unlinkSync(path.join(root, 'js/rpg_core.js'));
  assert.throws(() => detectRpgMakerEngine(root), /cannot identify RPG Maker MV or MZ/);
});
