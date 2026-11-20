'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { bedroom } = require('./helpers/omori-bedroom.cjs');
const { restoreBedroom, prepare } = require('../patches/omori/v1-compatibility.cjs');

test('bedroom backport preserves caller state and unrelated map data', () => {
  const input = bedroom(), before = JSON.stringify(input);
  const restored = restoreBedroom(input.map, input.tiled);
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(restored.map.events[79], input.map.events[79]);
  assert.equal(restored.tiled.layers[0].data[0], 42);
  assert.equal(restored.tiled.layers[0].data.filter(value => value !== 0).length, 1);
  assert.deepEqual(restored.map.events.filter(event => event?.id !== 79).filter(Boolean).map(event =>
    [event.id, event.x, event.y, event.pages[0].image.direction]), [[78, 14, 16, 8], [80, 14, 19, 4], [81, 16, 19, 2], [82, 18, 19, 6]]);
});

test('sleeping characters animate and KEL retains the three self-switch dialogue pages', () => {
  const input = bedroom(), { map } = restoreBedroom(input.map, input.tiled);
  for (const [id, row, delay] of [[78, 3, 60], [80, 1, 62], [81, 0, 66], [82, 2, 52]]) {
    const page = map.events[id].pages[0];
    assert.equal(map.events[id].note, '<Sprite Offset Y: +38>');
    assert.equal(page.moveType, 3);
    assert.equal(page.walkAnime, id === 81);
    assert.equal(page.moveRoute.repeat, true);
    assert.deepEqual(page.moveRoute.list.slice(0, 4).map(command => command.parameters),
      [['this.setCustomFrameXY(0,' + row + ');'], [delay], ['this.setCustomFrameXY(1,' + row + ');'], [delay]]);
  }
  const pages = map.events[82].pages;
  assert.deepEqual(pages.map(page => [page.conditions.selfSwitchValid, page.conditions.selfSwitchCh]), [[false, 'A'], [true, 'A'], [true, 'B']]);
  assert.deepEqual(pages.map(page => page.list[0].parameters[0]),
    ['ShowMessage black_space_rev.message_421', 'ShowMessage black_space_rev.message_422', 'ShowMessage black_space_rev.message_421']);
  assert.deepEqual(pages.slice(0, 2).map(page => page.list[1].parameters), [['A', 0], ['B', 0]]);
});

test('modern or independently modified bedrooms are not rewritten', () => {
  for (const change of [room => { room.map.events[78] = { id: 78 }; }, room => { room.tiled.layers[0].data[16 * 33 + 14] = 999; }]) {
    const input = bedroom(); change(input); const before = JSON.stringify(input);
    assert.equal(restoreBedroom(input.map, input.tiled), null);
    assert.equal(JSON.stringify(input), before);
  }
  assert.equal(prepare({ native: { runtime: {} }, files: { exists: name => name.endsWith('$DW_SleepingChars.png') } }), null);
});

test('backport detection is available before mod loading without claiming a game version', () => {
  const modules = JSON.parse(fs.readFileSync(path.join(__dirname, '../patches/omori/entry.json'))).modules;
  const scope = { PMJS: { plugins: { onLoading() {}, onLoaded() {} } }, NativeHost: { runtime: { omoriBackports: { sleepingCharacters: true } } } };
  const context = vm.createContext(scope);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../patches/omori', modules[0]), 'utf8'), context);
  assert.equal(scope.PMJS.omori.backports.sleepingCharacters, true);
  assert.equal(Object.isFrozen(scope.PMJS.omori.backports), true);
  assert.deepEqual(Object.keys(scope.PMJS.omori), ['backports']);
});

test('existing sleeping-character artwork does not suppress the bedroom map backport', () => {
  const room = bedroom(), written = new Map(), native = { runtime: {} };
  const input = new Map([
    ['data/Map466.json', Buffer.from(JSON.stringify(room.map))],
    ['maps/map466.json', Buffer.from(JSON.stringify(room.tiled))],
    ['img/characters/$DW_SleepingChars.png', Buffer.from('custom sleeping characters')]
  ]);
  const files = { exists: name => input.has(name), read: name => input.get(name),
    createLayer: () => ({ write(name, bytes) { written.set(name, bytes); },
      finish() { return { root: 'prepared' }; }, dispose() {} }) };
  assert.equal(prepare({ native, files }).root, 'prepared');
  assert.equal(JSON.parse(written.get('data/Map466.json')).events[78].pages[0].image.characterName, '$DW_SleepingChars');
  assert.equal(JSON.parse(written.get('maps/map466.json')).layers[0].data[16 * 33 + 14], 0);
  assert.equal(written.has('img/characters/$DW_SleepingChars.png'), false);
  assert.equal(native.runtime.omoriBackports.sleepingCharacters, true);
});

test('a missing sleeping-character sheet is restored without rewriting an existing event map', () => {
  const room = bedroom(), modern = restoreBedroom(room.map, room.tiled), written = new Map();
  const input = new Map([
    ['data/Map466.json', Buffer.from(JSON.stringify(modern.map))],
    ['maps/map466.json', Buffer.from(JSON.stringify(modern.tiled))],
    ['img/tilesets/DW_NeighborsRoom.png', Buffer.from('tileset')]
  ]);
  const native = { runtime: {}, images: { loadBytes: () => ({ handle: 1, width: 512, height: 512 }), release() {} },
    canvas: { create: () => ({ handle: 2 }), drawImage() {}, encodePng: () => Buffer.from('sheet'), release() {} } };
  prepare({ native, files: { exists: name => input.has(name), read: name => input.get(name),
    createLayer: () => ({ write(name, bytes) { written.set(name, bytes); }, finish: () => ({}), dispose() {} }) } });
  assert.deepEqual([...written.keys()], ['img/characters/$DW_SleepingChars.png']);
  assert.equal(native.runtime.omoriBackports.sleepingCharacters, true);
});

test('shared game-file reads accept mixed contents independently of their extensions', () => {
  const crypto = require('node:crypto');
  const { createGameFiles } = require('../patches/omori/game-files.cjs');
  const key = 'a'.repeat(32), iv = Buffer.alloc(16, 9), assetKey = Buffer.alloc(16, 7);
  const json = Buffer.from('{"events":[]}'), header = Buffer.from('5250474d560000000003010000000000', 'hex');
  const cipher = crypto.createCipheriv('aes-256-ctr', key, iv);
  const encodedJson = Buffer.concat([iv, cipher.update(json), cipher.final()]);
  const png = require('./helpers/png.cjs').png(1, 1, Uint8Array.from([20, 40, 60, 255]));
  const image = Buffer.from(png); for (let i = 0; i < 16; i++) image[i] ^= assetKey[i];
  const input = {
    'js/main.js': Buffer.from('let key = "' + key + '";'),
    'data/Map466.KEL': json,
    'languages/en/test.PLUTO': Buffer.from('message: hello'),
    'maps/map466.json': encodedJson,
    'data/System.KEL': Buffer.from(JSON.stringify({ encryptionKey: assetKey.toString('hex') })),
    'img/tilesets/DW_NeighborsRoom.png': Buffer.concat([header, image])
  };
  const written = new Map();
  const files = createGameFiles({ native: { fs: { exists: name => Object.hasOwn(input, name) } }, read: name => input[name],
    createLayer: () => ({ write(name, bytes) { written.set(name, bytes); }, finish() { return {}; }, dispose() {} }) });
  assert.deepEqual(files.read('/game/./data/Map466.json'), json);
  assert.equal(files.read('languages/en/test.yaml').toString(), 'message: hello');
  assert.equal(files.read('languages/en/test.PLUTO').toString(), 'message: hello');
  assert.deepEqual(files.read('maps/map466.AUBREY'), json);
  assert.deepEqual(files.read('img/tilesets/DW_NeighborsRoom.png'), png);
  const layer = files.createLayer('fixture');
  layer.write('data/Map466.json', json); layer.write('maps/map466.json', json); layer.write('img/characters/new.png', png);
  assert.deepEqual([...written.keys()], ['data/Map466.json', 'maps/map466.json', 'img/characters/new.png']);
  assert.deepEqual(written.get('data/Map466.json'), json);
  assert.deepEqual(written.get('maps/map466.json'), json);
  assert.deepEqual(written.get('img/characters/new.png'), png);
});

test('original main declarations remain local while installed loader globals coexist', () => {
  const source = 'const crypto = {}; const key = "' + 'a'.repeat(32) + '"; PluginManager=class extends PluginManager {}; globalThis.started = true;';
  const context = vm.createContext({ PMJS: { plugins: { onLoading() {}, onLoaded() {} } }, PluginManager: class {}, NativeHost: { runtime: { readGameScript: () => source } } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../patches/omori/v1-compatibility.js'), 'utf8'), context);
  vm.runInContext('const crypto = "loader";', context);
  vm.runInContext(context.NativeHost.runtime.readGameScript('js/main.js'), context);
  assert.equal(context.started, true);
  assert.equal(vm.runInContext('crypto', context), 'loader');
  assert.equal(context.NativeHost.runtime.readGameScript('js/other.js'), source);
});

test('summoning-circle guard preserves the exit sequence and adds the conditional skip target', () => {
  const { restoreSummoningCircle } = require('../patches/omori/v1-compatibility.cjs');
  const list = Array.from({ length: 61 }, () => ({ code: 230, indent: 0, parameters: [20] }));
  list[0] = { code: 356, indent: 0, parameters: ['AddChoice XX_GENERAL.message_4 Label1'] };
  list[57] = { code: 118, indent: 0, parameters: ['Label2'] };
  list[59] = { code: 356, indent: 0, parameters: ['ShowMessage dreamworld_extras_doomtomb.message_512'] };
  list[60] = { code: 0, indent: 0, parameters: [] };
  const map = { width: 32, height: 53, events: Array(11).fill(null) };
  map.events[10] = { pages: Array.from({ length: 7 }, () => ({ list: [] })) };
  map.events[10].pages[6].list = list;
  const before = JSON.stringify(map), result = restoreSummoningCircle(map);
  assert.equal(JSON.stringify(map), before);
  const restored = result.events[10].pages[6].list;
  assert.equal(restored.length, 73);
  assert.deepEqual(restored[0], { code: 111, indent: 0, parameters: [1, 111, 0, 1, 1] });
  assert.deepEqual(restored[8], { code: 119, indent: 1, parameters: ['end'] });
  assert.deepEqual(restored[71], { code: 118, indent: 0, parameters: ['end'] });
  assert.deepEqual(restored.slice(11, 71), list.slice(0, 60));
  assert.equal(restoreSummoningCircle(result), null);
  map.events[10].pages[6].list[59].parameters[0] = 'different exit';
  assert.equal(restoreSummoningCircle(map), null);
});

test('general-options schema inserts text skip without changing other language data', () => {
  const { restoreGeneralOptions } = require('../patches/omori/v1-compatibility.cjs');
  const general = Object.fromEntries(['screenResolution', 'fullScreen', 'gamepadTips', 'battleLogSpeed', 'alwaysDash'].map(key => [key, { text: key }]));
  const system = { plugins: { optionsMenu: { general, buttonHints: { confirm: 'OK' } } } };
  const before = JSON.stringify(system), result = restoreGeneralOptions(system);
  assert.equal(JSON.stringify(system), before);
  assert.deepEqual(Object.keys(result.plugins.optionsMenu.general), ['screenResolution', 'fullScreen', 'gamepadTips', 'textSkip', 'battleLogSpeed', 'alwaysDash']);
  assert.deepEqual(result.plugins.optionsMenu.buttonHints, { confirm: 'OK', cancel: 'CANCEL' });
  assert.deepEqual(result.plugins.optionsMenu.general.battleLogSpeed, general.battleLogSpeed);
  assert.equal(restoreGeneralOptions(result), null);
  general.custom = {};
  assert.equal(restoreGeneralOptions(system), null);
});
