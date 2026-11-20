'use strict';
const sheetName = '$DW_SleepingChars';
const beds = [
  { id: 78, x: 14, y: 16, row: 3, delay: 60, message: 420 },
  { id: 80, x: 14, y: 19, row: 1, delay: 62, message: 423 },
  { id: 81, x: 16, y: 19, row: 0, delay: 66, message: 425 },
  { id: 82, x: 18, y: 19, row: 2, delay: 52, message: 421 }
];
const tiles = [[14, 16, 158], [14, 17, 174], [14, 19, 121], [14, 20, 137],
  [16, 19, 155], [16, 20, 171], [18, 19, 122], [18, 20, 138]];
function page(bed, selfSwitch, message, nextSwitch) {
  const commands = [{ code: 356, indent: 0, parameters: ['ShowMessage black_space_rev.message_' + message] }];
  if (nextSwitch) commands.push({ code: 123, indent: 0, parameters: [nextSwitch, 0] });
  commands.push({ code: 0, indent: 0, parameters: [] });
  return {
    conditions: { actorId: 1, actorValid: false, itemId: 1, itemValid: false,
      selfSwitchCh: selfSwitch || 'A', selfSwitchValid: !!selfSwitch, switch1Id: 1,
      switch1Valid: false, switch2Id: 1, switch2Valid: false, variableId: 1, variableValid: false, variableValue: 0 },
    directionFix: bed.id !== 81 && !selfSwitch,
    image: { tileId: 0, characterName: sheetName, direction: 2 + bed.row * 2, pattern: 0, characterIndex: 0 },
    list: commands, moveFrequency: 3,
    moveRoute: { list: [
      { code: 45, parameters: ['this.setCustomFrameXY(0,' + bed.row + ');'], indent: null },
      { code: 15, parameters: [bed.delay], indent: null },
      { code: 45, parameters: ['this.setCustomFrameXY(1,' + bed.row + ');'], indent: null },
      { code: 15, parameters: [bed.delay], indent: null }, { code: 0, parameters: [] }
    ], repeat: true, skippable: false, wait: false },
    moveSpeed: 3, moveType: 3, priorityType: 0, stepAnime: false, through: false, trigger: 0, walkAnime: bed.id === 81 || !!selfSwitch
  };
}
function restoreBedroom(map, tiled) {
  const set = tiled.tilesets?.find(set => set.source?.toLowerCase() === 'dw_neighbors_room.json');
  const layers = tiled.layers?.filter(layer => layer.name === 'GROUND - IV' && layer.type === 'tilelayer');
  if (map.width !== 33 || map.height !== 55 || tiled.width !== 33 || tiled.height !== 55 ||
      !Array.isArray(map.events) || beds.some(bed => map.events[bed.id] != null) || !set || layers?.length !== 1 ||
      layers[0].data?.length !== 33 * 55 || tiles.some(([x, y, index]) => layers[0].data[y * 33 + x] !== set.firstgid + index)) return null;
  map = JSON.parse(JSON.stringify(map)); tiled = JSON.parse(JSON.stringify(tiled));
  const ground = tiled.layers.find(layer => layer.name === 'GROUND - IV' && layer.type === 'tilelayer');
  for (const [x, y] of tiles) ground.data[y * 33 + x] = 0;
  for (const bed of beds) {
    const pages = [page(bed, null, bed.message, bed.id === 82 ? 'A' : null)];
    if (bed.id === 82) pages.push(page(bed, 'A', 422, 'B'), page(bed, 'B', 421, null));
    map.events[bed.id] = { id: bed.id, name: 'EV' + String(bed.id).padStart(3, '0'),
      note: '<Sprite Offset Y: +38>', pages, x: bed.x, y: bed.y };
  }
  return { map, tiled };
}
function makeSheet(native, bytes) {
  const image = native.images.loadBytes(bytes, true);
  let canvas;
  try {
    if (image.width !== 512 || image.height !== 512) throw new Error('unexpected OMORI bedroom tileset dimensions');
    canvas = native.canvas.create(96, 256);
    for (let row = 0; row < 4; row++) {
      native.canvas.drawImage(canvas.handle, image.handle, 256 + row * 32, 224, 32, 64, 0, row * 64, 32, 64, 1, false);
      native.canvas.drawImage(canvas.handle, image.handle, 352 + row * 32, 288, 32, 64, 32, row * 64, 32, 64, 1, false);
    }
    return Buffer.from(native.canvas.encodePng(canvas.handle));
  } finally {
    if (canvas) native.canvas.release(canvas.handle);
    native.images.release(image.handle);
  }
}
function restoreSummoningCircle(map) {
  const list = map.events?.[10]?.pages?.[6]?.list;
  if (map.width !== 32 || map.height !== 53 || list?.length !== 61 ||
      list[0]?.code !== 356 || list[0].parameters?.[0] !== 'AddChoice XX_GENERAL.message_4 Label1' ||
      list[57]?.code !== 118 || list[57].parameters?.[0] !== 'Label2' ||
      list[59]?.code !== 356 || list[59].parameters?.[0] !== 'ShowMessage dreamworld_extras_doomtomb.message_512' ||
      list[60]?.code !== 0) return null;
  map = JSON.parse(JSON.stringify(map));
  const command = (code, indent, parameters) => ({ code, indent, parameters });
  const route = [
    { code: 45, parameters: ['Fuku_Plugins.EventTremble.start(this._eventId,1,1);'], indent: null },
    { code: 15, parameters: [30], indent: null },
    { code: 45, parameters: ['Fuku_Plugins.EventTremble.stop(this._eventId)'], indent: null }
  ];
  map.events[10].pages[6].list = [
    command(111, 0, [1, 111, 0, 1, 1]),
    command(356, 1, ['StopEventMovement']),
    command(205, 1, [0, { list: [...route, { code: 0 }], repeat: false, skippable: false, wait: false }]),
    ...route.map(step => command(505, 1, [step])),
    command(356, 1, ['ShowMessage XX_MELON.message_184']),
    command(356, 1, ['AllowEventMovement']),
    command(119, 1, ['end']), command(0, 1, []), command(412, 0, []),
    ...map.events[10].pages[6].list.slice(0, -1), command(118, 0, ['end']), command(0, 0, [])
  ];
  return map;
}
function restoreGeneralOptions(system) {
  const general = system.plugins?.optionsMenu?.general;
  const expected = ['screenResolution', 'fullScreen', 'gamepadTips', 'battleLogSpeed', 'alwaysDash'];
  if (!general || JSON.stringify(Object.keys(general)) !== JSON.stringify(expected)) return null;
  system = JSON.parse(JSON.stringify(system));
  const options = {};
  for (const key of expected) {
    if (key === 'battleLogSpeed') options.textSkip = {
      text: 'TEXT SKIP', options: ['ON', 'OFF'],
      help: 'Fast-forward text by pressing or holding CONFIRM or CANCEL.', boolIndex: true, spacing: 80
    };
    options[key] = system.plugins.optionsMenu.general[key];
  }
  system.plugins.optionsMenu.general = options;
  system.plugins.optionsMenu.buttonHints = Object.assign({ confirm: 'CONFIRM', cancel: 'CANCEL' }, system.plugins.optionsMenu.buttonHints);
  return system;
}
function prepare({ native, files }) {
  native.runtime.omoriBackports = {};
  const sheet = 'img/characters/' + sheetName + '.png';
  const data = 'data/Map466.json', map = 'maps/map466.json', atlas = 'img/tilesets/DW_NeighborsRoom.png';
  let bedroom;
  if (!files.exists(sheet) && [data, map, atlas].every(name => files.exists(name))) {
    bedroom = restoreBedroom(JSON.parse(files.read(data)), JSON.parse(files.read(map)));
  }
  const circlePath = 'data/Map343.json';
  const circle = files.exists(circlePath) ? restoreSummoningCircle(JSON.parse(files.read(circlePath))) : null;
  const systemPath = 'languages/en/System.yaml';
  let system, yaml;
  if (files.exists(systemPath)) {
    yaml = require(native.fs.resolvePath('js/libs/js-yaml-master/index.js'));
    system = restoreGeneralOptions(yaml.safeLoad(files.read(systemPath).toString('utf8')));
  }
  if (!bedroom && !circle && !system) return null;
  const output = files.createLayer('omori-v1');
  try {
    if (bedroom) {
      output.write(data, Buffer.from(JSON.stringify(bedroom.map)));
      output.write(map, Buffer.from(JSON.stringify(bedroom.tiled)));
      output.write(sheet, makeSheet(native, files.read(atlas)));
    }
    if (circle) output.write(circlePath, Buffer.from(JSON.stringify(circle)));
    if (system) output.write(systemPath, Buffer.from(yaml.dump(system)));
    const result = output.finish();
    if (bedroom) native.runtime.omoriBackports.sleepingCharacters = true;
    if (circle) native.runtime.omoriBackports.summoningCircleGuard = true;
    if (system) native.runtime.omoriBackports.generalOptionsSchema = true;
    return result;
  } finally { output.dispose(); }
}
module.exports = { prepare, restoreBedroom, restoreSummoningCircle, restoreGeneralOptions };
