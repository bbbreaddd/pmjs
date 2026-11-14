'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { parsePluginManifest } = require('./plugin-manifest.cjs');

const eventCodes = new Set([0, 101, 102, 103, 104, 105, 108, 111, 112, 113, 115, 117, 118, 119, 121, 122, 123, 124, 125, 126, 127, 128, 129, 132, 133, 134, 135, 136, 137, 138, 139, 140, 201, 202, 203, 204, 205, 206, 211, 212, 213, 214, 216, 217, 221, 222, 223, 224, 225, 230, 231, 232, 233, 234, 235, 236, 241, 242, 243, 244, 245, 246, 249, 250, 251, 261, 281, 282, 283, 284, 285, 301, 302, 303, 311, 312, 313, 314, 315, 316, 317, 318, 319, 320, 321, 322, 323, 324, 325, 326, 331, 332, 333, 334, 335, 336, 337, 339, 340, 342, 351, 352, 353, 354, 355, 356, 401, 402, 403, 404, 405, 408, 411, 412, 413, 505, 601, 602, 603, 604, 605, 655]);
const conditionTypes = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
const routeCodes = new Set(Array.from({ length: 46 }, (_, index) => index));
const traitCodes = new Set([11, 12, 13, 14, 21, 22, 23, 31, 32, 33, 34, 41, 42, 43, 44, 51, 52, 53, 54, 55, 61, 62, 63, 64]);
const effectCodes = new Set([11, 12, 13, 21, 22, 31, 32, 33, 34, 41, 42, 43, 44]);
const statNames = ['mhp', 'mmp', 'atk', 'def', 'mat', 'mdf', 'agi', 'luk'];
const hash = source => createHash('sha256').update(source.replace(/\r\n/g, '\n')).digest('hex');

function inspectDatabase(database) {
  const issues = [], commands = new Set(), routes = new Set(), formulas = new Set();
  const reject = (location, reason) => issues.push({ location, reason });
  function inspectRoute(route, location) {
    for (const [index, command] of (route.list || []).entries()) {
      routes.add(command.code);
      if (!routeCodes.has(command.code)) reject(`${location}.list[${index}]`, `unsupported movement command ${command.code}`);
    }
  }
  function inspectList(list, location) {
    for (const [index, command] of list.entries()) {
      const at = `${location}[${index}]`, p = command.parameters;
      commands.add(command.code);
      if (!eventCodes.has(command.code)) reject(at, `unsupported event command ${command.code}`);
      if (command.code === 111) {
        if (!conditionTypes.has(p[0])) reject(at, `unsupported condition ${p[0]}`);
        else if (p[0] === 4 && ![0, 1, 2, 3, 4, 5, 6].includes(p[2])) reject(at, `unsupported actor condition ${p[2]}`);
      }
      if (command.code === 122) {
        if (![0, 1, 2, 3, 4].includes(p[3])) reject(at, `unsupported variable operand ${p[3]}`);
        else if (p[3] === 3) {
          const [type, first, second] = p.slice(4);
          const supported = type >= 0 && type <= 7 &&
            (type !== 3 || second >= 0 && second <= 11) &&
            (type !== 4 || second >= 0 && second <= 9) &&
            (type !== 5 || second >= 0 && second <= 4) &&
            (type !== 7 || first >= 0 && first <= 9);
          if (!supported) reject(at, `unsupported game-data operand ${type}:${type === 7 ? first : second}`);
        }
      }
      if (command.code === 205) inspectRoute(p[1], `${at}.parameters[1]`);
    }
  }
  for (const [id, map] of Object.entries(database.maps)) {
    const location = `Map${String(id).padStart(3, '0')}.json`;
    if (map.data.length !== map.width * map.height * 6) reject(location, 'invalid map tile count');
    for (const event of map.events.filter(Boolean)) {
      for (const [index, page] of event.pages.entries()) {
        const at = `${location}.events[${event.id}].pages[${index}]`;
        inspectRoute(page.moveRoute, `${at}.moveRoute`);
        inspectList(page.list, `${at}.list`);
      }
    }
  }
  for (const event of database.commonEvents.filter(Boolean)) {
    inspectList(event.list, `CommonEvents.json[${event.id}].list`);
  }
  for (const troop of database.troops.filter(Boolean)) {
    for (const [index, page] of troop.pages.entries()) {
      const at = `Troops.json[${troop.id}].pages[${index}].list`;
      inspectList(page.list, at);
    }
  }
  for (const name of ['actors', 'classes', 'weapons', 'armors', 'states', 'skills', 'items', 'enemies']) {
    for (const item of database[name].filter(Boolean)) {
      const at = `${name}[${item.id}]`;
      for (const trait of item.traits || []) {
        if (!traitCodes.has(trait.code)) reject(at, `unsupported trait ${trait.code}`);
        else if (trait.code === 62 && ![0, 1, 2, 3].includes(trait.dataId)) reject(at, `unsupported special battler flag ${trait.dataId}`);
      }
      for (const effect of item.effects || []) if (!effectCodes.has(effect.code)) reject(at, `unsupported effect ${effect.code}`);
      if (item.damage?.type) {
        formulas.add(item.damage.formula);
        const arithmetic = item.damage.formula.replace(/\b[ab]\.[A-Za-z]+\b/g, field => statNames.includes(field.slice(2)) ? '0' : field);
        if (/[^\w\s.$+*/()%<>=!&|^~?:,\[\]\-]/.test(arithmetic)) reject(`${at}.damage.formula`, 'unsupported damage expression');
      }
    }
  }
  return { issues, eventCodes: [...commands].sort((a, b) => a - b), routeCodes: [...routes].sort((a, b) => a - b), formulas: [...formulas].sort() };
}

function resolveBasicSettings(manifest) {
  const parseNumber = (value, fallback) => {
    if (value === undefined || value === null || value === '') return fallback;
    const parsed = Number(value);
    return Number.isNaN(parsed) ? fallback : parsed;
  };
  let settings = { width: 816, height: 624, imageCacheBytes: 10000000, alwaysDash: false, renderingMode: 'auto' };
  for (const plugin of manifest.plugins.filter(item => item.status)) {
    if (plugin.name !== 'Community_Basic') continue;
    const file = `js/plugins/${plugin.name}.js`;
    const p = plugin.parameters || {};
    const width = parseNumber(p.screenWidth, 816), height = parseNumber(p.screenHeight, 624);
    const cacheLimit = parseNumber(p.cacheLimit, 10);
    const renderingMode = String(p.renderingMode || 'auto').toLowerCase();
    if (!['auto', 'webgl'].includes(renderingMode)) throw new Error(`${file}: unsupported rendering mode`);
    const imageCacheBytes = cacheLimit * 1000000;
    if (![width, height, imageCacheBytes].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error(`${file}: invalid dimensions or cache budget`);
    const windowWidthTo = parseNumber(p.changeWindowWidthTo, 0), windowHeightTo = parseNumber(p.changeWindowHeightTo, 0);
    if (![windowWidthTo, windowHeightTo].every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error(`${file}: invalid window dimensions`);
    const windowWidth = windowWidthTo || (width !== 816 ? width : 0);
    const windowHeight = windowHeightTo || (height !== 624 ? height : 0);
    settings = {
      width, height, imageCacheBytes, renderingMode,
      alwaysDash: String(p.alwaysDash || '').toLowerCase() === 'on',
      ...(windowWidth > 0 && windowHeight > 0 ? { windowWidth, windowHeight } : {}),
    };
  }
  return settings;
}

function detectRpgMakerEngine(root) {
  for (const [file, family] of [['rmmz_core.js', 'MZ'], ['rpg_core.js', 'MV']]) {
    const source = path.join(root, 'js', file);
    if (!fs.existsSync(source)) continue;
    const marker = fs.readFileSync(source, 'utf8').match(/Utils\.RPGMAKER_NAME\s*=\s*["']([^"']+)["']/);
    if (!marker || ['MV', 'MZ'].includes(marker[1])) return marker ? marker[1] : family;
    throw new Error(`unrecognized RPG Maker engine: ${marker[1]}`);
  }
  throw new Error('cannot identify RPG Maker MV or MZ: missing core script');
}

function loadGame(root) {
  const identities = {};
  const read = file => {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    identities[file] = hash(source); return source;
  };
  const engineFamily = detectRpgMakerEngine(root);
  if (engineFamily !== 'MV') throw new Error(`native-mv does not support RPG Maker ${engineFamily}`);
  const manifest = parsePluginManifest(read('js/plugins.js'), 'js/plugins.js');
  const settings = resolveBasicSettings(manifest);
  const database = {};
  database.tileTables = {};
  const coreSource = read('js/rpg_core.js');
  for (const [name, key] of [['FLOOR', 'floor'], ['WALL', 'wall'], ['WATERFALL', 'waterfall']]) {
    const match = coreSource.match(new RegExp(`Tilemap\\.${name}_AUTOTILE_TABLE = (\\[[\\s\\S]*?\\]);`));
    if (!match) throw new Error(`js/rpg_core.js: missing ${name} tile table`);
    database.tileTables[key] = JSON.parse(match[1]);
  }
  const fontCss = read('fonts/gamefont.css');
  const fontSource = fontCss.match(/font-family\s*:\s*GameFont\s*;\s*src\s*:\s*url\(["']?([^"')]+)["']?\)/i);
  if (!fontSource || !/^[A-Za-z0-9_.-]+\.(?:ttf|otf)$/i.test(fontSource[1])) throw new Error('fonts/gamefont.css: unsupported GameFont source');
  settings.fontFile = `fonts/${fontSource[1]}`;
  identities[settings.fontFile] = createHash('sha256').update(fs.readFileSync(path.join(root, settings.fontFile))).digest('hex');
  for (const name of ['System', 'Actors', 'Classes', 'Skills', 'Items', 'Weapons', 'Armors', 'Enemies', 'Troops', 'States', 'Animations', 'Tilesets', 'CommonEvents', 'MapInfos']) {
    database[name[0].toLowerCase() + name.slice(1)] = JSON.parse(read(`data/${name}.json`));
  }
  database.maps = {};
  for (const info of database.mapInfos.filter(Boolean)) {
    const file = `data/Map${String(info.id).padStart(3, '0')}.json`;
    if (!fs.existsSync(path.join(root, file))) continue;
    database.maps[info.id] = JSON.parse(read(file));
  }
  const contract = inspectDatabase(database);
  return { database, settings, contract, identities, manifest, engineFamily };
}

module.exports = { loadGame, inspectDatabase, resolveBasicSettings, detectRpgMakerEngine };
