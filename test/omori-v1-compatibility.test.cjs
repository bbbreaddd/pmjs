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
  const scope = { PMJS: {}, NativeHost: { runtime: { omoriBackports: { sleepingCharacters: true } } } };
  const context = vm.createContext(scope);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../patches/omori', modules[0]), 'utf8'), context);
  assert.equal(scope.PMJS.omori.backports.sleepingCharacters, true);
  assert.equal(Object.isFrozen(scope.PMJS.omori.backports), true);
  assert.deepEqual(Object.keys(scope.PMJS.omori), ['backports']);
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
  const context = vm.createContext({ PMJS: {}, PluginManager: class {}, NativeHost: { runtime: { readGameScript: () => source } } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../patches/omori/v1-compatibility.js'), 'utf8'), context);
  vm.runInContext('const crypto = "loader";', context);
  vm.runInContext(context.NativeHost.runtime.readGameScript('js/main.js'), context);
  assert.equal(context.started, true);
  assert.equal(vm.runInContext('crypto', context), 'loader');
  assert.equal(context.NativeHost.runtime.readGameScript('js/other.js'), source);
});
