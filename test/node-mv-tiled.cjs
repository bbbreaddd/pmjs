'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const api = require(path.resolve(process.argv[2])).mvEngine;
const { fixture } = require('./helpers/mv-session-fixture.cjs');
const { createScriptRuntime } = require('../runner/mv-script-runtime.cjs');
const { installNativeTiled } = require('../patches/omori/native-tiled.cjs');
const { installSaveManager } = require('../runner/native-save-manager.cjs');

function setup(t, source, parameters = {}) {
  const data = fixture([]); data.system.startX = data.system.startY = 0;
  const session = api.create(data); t.after(() => api.dispose(session));
  const runtime = createScriptRuntime(api, session), scope = runtime.scope;
  function Sprite_Character() {}
  function Spriteset_Map() {}
  Object.assign(Sprite_Character.prototype, { initMembers() {}, update() {}, updatePosition() {}, updateReflect() {} });
  Object.assign(Spriteset_Map.prototype, { createCharacters() {}, createTilemap() {} });
  Object.assign(scope, { Sprite_Character, Spriteset_Map, Sprite: function() {}, Imported: {},
    PluginManager: { parameters() { return { 'Half-tile movement': 'false', 'Map Level Variable': '26', ...parameters }; } },
    ImageManager: {}, DataManager: { loadMapData() {}, isMapLoaded() { return true; } } });
  installNativeTiled(runtime, api, session, Sprite_Character.prototype.updatePosition);
  const guest = value => runtime.runScript('JSON.parse(' + JSON.stringify(JSON.stringify(value)) + ')');
  scope.$dataMap = guest(data.maps[1]);
  api.databaseInvoke(session, 'publishMap', 1, scope.$dataMap);
  scope.DataManager._tempTiledData = guest(source);
  api.tiledInvoke(session, 'bindSource', [1, scope.DataManager._tempTiledData]);
  api.databaseInvoke(session, 'publishTiledMap', 1, source);
  api.newGame(session);
  return { session, runtime, scope, map: scope.$gameMap, player: scope.$gamePlayer, guest };
}

function map(layers, tilesets = []) {
  return { width: 2, height: 1, tilewidth: 48, tileheight: 32, layers, tilesets };
}
const layer = (properties, data = [1, 0]) => ({ type: 'tilelayer', properties, data });

test('native Tiled compiler keeps independent collision, arrows, regions and level changes', () => {
  const result = api.compileTiledMap(map([
    layer({ collision: 'full' }), layer({ collision: 'arrow', arrowImpassable: 'left & up' }),
    layer({ regionId: '08' }), layer({ toLevel: '2' }),
    layer({ collision: 'arrow', arrowImpassable: 'down', level: '2' }, [0, 1])
  ]), false);
  assert.deepEqual(result.levels['0'].collision, [1, 0]);
  assert.deepEqual(result.levels['0'].arrows, [12, 15]);
  assert.deepEqual(result.levels['0'].passage, [15, 0]);
  assert.deepEqual(result.levels['0'].regions, [8, 0]);
  assert.deepEqual(result.levels['0'].levelChanges, [2, -1]);
  assert.deepEqual(result.levels['2'].passage, [0, 1]);
});

test('half-tile compilation expands cells and preserves quarter collision and event placement', () => {
  const result = api.compileTiledMap(map([
    layer({ collision: 'up-right' }), layer({ regionId: 5 }),
    { type: 'objectgroup', objects: [{ x: 24, y: 16, properties: { eventId: '3' } }] }
  ]), true);
  assert.equal(result.mapWidth, 4); assert.equal(result.mapHeight, 2);
  assert.equal(result.logicalTilewidth, 24); assert.equal(result.logicalTileheight, 16);
  assert.deepEqual(result.levels['0'].collision, [0, 1, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(result.levels['0'].regions, [5, 5, 0, 0, 5, 5, 0, 0]);
  assert.deepEqual(result.eventLocations, [{ id: 3, x: 2, y: 2 }]);
});

test('tile properties and repeated arrow layers use authored XOR behavior', () => {
  const tilesets = [{ firstgid: 1, tilecount: 1, tileproperties: { '0': { collision: 'full', arrowImpassable: 'down', regionId: 9 } } }];
  const result = api.compileTiledMap(map([layer({ collision: 'tile-base', regionId: 'tile-base' }),
    layer({ collision: 'arrow', arrowImpassable: 'down' })], tilesets), false);
  assert.deepEqual(result.levels['0'].arrows, [15, 15]);
  assert.deepEqual(result.levels['0'].regions, [9, 0]);
  assert.deepEqual(result.levels['0'].collision, [1, 0]);
});

test('reflection compilation retains invisible rectangles and default opacity', () => {
  const result = api.compileTiledMap(map([{ type: 'objectgroup',
    properties: { reflectionCast: -1, reflectionOpacity: 0, reflectionOffset: 7 },
    objects: [{ x: 0, y: 0, width: 20, height: 30, visible: false }] }]), false);
  assert.deepEqual(result.reflectionAreas, [{ rect: { x: 0, y: 0, width: 20, height: 30 },
    reflectionCast: -1, reflectionMask: undefined, reflectionOpacity: 255, reflectionOffset: 7 }]);
});

test('native map bindings expose live tables and synchronize the level variable', t => {
  const f = setup(t, map([layer({ collision: 'full' }), layer({ regionId: 7 }), layer({ toLevel: '2' }),
    layer({ regionId: 9, level: 2 })]));
  assert.equal(f.map.regionId(0, 0), 7);
  assert.equal(f.map.isPassable(0, 0, 2), false);
  f.map._collisionMap[0][0] = 0;
  assert.equal(f.map.isPassable(0, 0, 2), true);
  f.map._regions[0] = f.guest([11, 12]);
  assert.equal(f.map.regionId(1, 0), 12);
  assert.equal(f.map.checkMapLevelChanging(0, 0), true);
  assert.equal(f.scope.$gameVariables.value(26), 2);
  assert.equal(f.map.currentMapLevel, 2);
  assert.equal(f.map._currentMapLevel, 0);
  assert.equal(f.map.regionId(0, 0), 9);
  f.scope.$gameVariables.setValue(26, 0);
  assert.equal(f.map.regionId(0, 0), 11);
});

test('native stage updates preserve collision accumulation and arrow XOR semantics', t => {
  const source = map([layer({ collision: 'tile-base', regionId: 'tile-base' })],
    [{ firstgid: 1, tilecount: 1, tileproperties: { '0': { collision: 'full', arrowImpassable: 'left', regionId: 8 } } }]);
  const f = setup(t, source);
  assert.equal(f.map._arrowCollisionMap[0][0], 14);
  f.map._setupCollisionArrow(); assert.equal(f.map._arrowCollisionMap[0][0], 15);
  f.map.tiledData.layers[0].data[0] = 0;
  f.map._setupCollisionFull(); assert.equal(f.map._collisionMap[0][0], 1);
  const properties = f.map._getTileProperties(1);
  assert.equal(properties, f.map.tiledData.tilesets[0].tileproperties['0']);
  properties.regionId = 13; f.map.tiledData.layers[0].data[0] = 1;
  f.map._setupRegion(); assert.equal(f.map.regionId(0, 0), 13);
  assert.equal(f.map._getArrowBit(' left & LEFT & down '), 8);
});

test('native character reflection state preserves records, array identity and mutations', t => {
  const f = setup(t, map([{ type: 'objectgroup', properties: { reflectionCast: 1 },
    objects: [{ x: 0, y: 0, width: 48, height: 32 }] }]));
  const area = f.map._reflection[0];
  f.player.updateReflection(); const first = f.player.reflections;
  assert.equal(first[0], area); assert.equal(f.player.reflections, first);
  assert.equal(f.map.getReflections(f.player)[0], area);
  first.push(area);
  assert.equal(f.runtime.tiledCharacter(f.player, 'reflections').length, 2);
  const replacement = f.guest([]); replacement.push(area);
  f.player.reflections = replacement;
  assert.equal(f.player.reflections, replacement);
  area.rect.x = 100;
  f.player.updateReflection(); assert.equal(f.player.reflections.length, 0);
  assert.notEqual(f.player.reflections, replacement);
});

test('native character updates respect overridden reflection queries', t => {
  const f = setup(t, map([])), replacement = f.guest([{ reflectionCast: -1 }]);
  f.map.isOnReflection = () => true; f.map.getReflections = () => replacement;
  f.player.update();
  assert.equal(f.player.reflections, replacement);
});

test('empty reflection updates produce fresh guest arrays and preserve retained array mutations', t => {
  const f = setup(t, map([]));
  f.player.updateReflection(); const first = f.player.reflections;
  assert.equal(Object.getPrototypeOf(first), f.runtime.runScript('Array.prototype'));
  assert.equal(f.player.reflections, first);
  first.push({ reflectionCast: 1 });
  assert.equal(f.runtime.tiledCharacter(f.player, 'reflections').length, 1);
  f.player.updateReflection(); const second = f.player.reflections;
  assert.notEqual(second, first);
  assert.equal(second.length, 0);
  assert.equal(first.length, 1);
});

test('reflection override eligibility is rechecked after native updates', t => {
  const f = setup(t, map([]));
  f.player.update(); assert.equal(f.player.reflections.length, 0);
  const replacement = f.guest([{ reflectionCast: 1 }]);
  f.map.isOnReflection = () => true; f.map.getReflections = () => replacement;
  f.player.update(); assert.equal(f.player.reflections, replacement);
});

test('reflection materialization defines own elements without invoking inherited setters', t => {
  const f = setup(t, map([{ type: 'objectgroup', properties: { reflectionCast: 1 },
    objects: [{ x: 0, y: 0, width: 48, height: 32 }] }]));
  f.runtime.runScript(`
    var reflectionSetterCalls = 0;
    Object.defineProperty(Array.prototype, '0', {
      configurable: true, set() { ++reflectionSetterCalls; }
    });
  `);
  try {
    f.player.updateReflection();
    assert.equal(f.player.reflections[0], f.map._reflection[0]);
    assert.equal(Object.hasOwn(f.player.reflections, '0'), true);
    assert.equal(f.runtime.runScript('reflectionSetterCalls'), 0);
  } finally { f.runtime.runScript("delete Array.prototype['0']"); }
});

test('Tiled tables remain enumerable save state and retain script edits through save restoration', t => {
  const f = setup(t, map([layer({ regionId: 3 })]));
  Object.assign(f.scope.DataManager, { loadGlobalInfo() { return []; }, saveGlobalInfo() {}, createGameObjects() {} });
  installSaveManager(f.runtime, api, f.session);
  assert.equal(Object.keys(f.map).includes('_regions'), true);
  f.map._regions[0][0] = 14;
  const encoded = f.scope.JsonEx.stringify(f.scope.DataManager.makeSaveContents());
  const contents = f.scope.JsonEx.parse(encoded);
  assert.equal(contents.map._regions[0][0], 14);
  f.map._regions[0][0] = 22;
  f.scope.DataManager.extractSaveContents(contents);
  assert.equal(f.scope.$gameMap._regions[0][0], 14);
  assert.equal(f.map.regionId(0, 0), 14);
});


test('map setup retains the per-map YED setup history', t => {
  const f = setup(t, map([]));
  assert.equal(f.map._isSetupBefore[1], true);
  f.map._isSetupBefore[23] = true;
  f.map.setup(1);
  assert.equal(f.map._isSetupBefore[1], true);
  assert.equal(f.map._isSetupBefore[23], true);
  assert.equal(f.map.isSetupBefore, undefined);
});
