'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { parsePluginManifest } = require('./plugin-manifest.cjs');

const coreIdentities = {
  rpg_core: 'a943b1ef85e7b91a6b09c4b125965282d96f0fdce627ef435421778abcb3b178',
  rpg_managers: 'a278bba3057f18e3047036062f2ebba2b5eaa5cec8b1de47f8f9a482c2d3023f',
  rpg_objects: 'f08061195476a7b58f1e8f5631d26d22f5e2df561f3d34bb52fbd9d416543407',
  rpg_scenes: '8730e7d9490de5386aff4e3c1d3ded6f04c281cdd50a29e7400965d84b1ccfa3',
  rpg_sprites: 'eacdaf2b8bd37069d75eff84dea82595419dd435c5456d6a9435a32f56900fe5',
  rpg_windows: '8d146d13489b91926b21ff98b4b30460d0eb4cddf0757943922a8a518d09ff0c',
};
const startupIdentities = {
  'js/main.js': 'dcab1427f95c4bcedf1ed595b828d0c423d4c8d1767452c9a4e651a9c07a3ab9',
  'js/libs/pixi.js': '47097d24b261679366419f9e36196a3303c35fa3d06d0518edb7f1ab5417def0',
  'js/libs/pixi-tilemap.js': '7401aeac40f9af7f7e777ce7a03a99c39571fa744fdb97add34732d7f8984e06',
  'js/libs/pixi-picture.js': 'f0e2af6190f2c53361047379ff0ae041568097f1b5beadcad28012f0aa5a99bb',
  'js/libs/fpsmeter.js': 'fec43a13a522dafe9c28c3d30635a275af350edf3423de0349fb6fb9c01e9450',
  'js/libs/lz-string.js': '7acc5ae524455fb67dee09375b4246386241f7dc4708dcdf8af0e78ca8267de7',
  'js/libs/iphone-inline-video.browser.js': '688ce9e9460d08399b898519b6d6811f8bd6722369e266b1f2761002be608f72',
};
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

function loadGame(root) {
  const identities = {};
  const read = file => {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    identities[file] = hash(source); return source;
  };
  for (const [name, expected] of Object.entries(coreIdentities)) {
    const file = `js/${name}.js`;
    read(file);
    if (identities[file] !== expected) throw new Error(`${file}: unsupported engine implementation`);
  }
  for (const [file, expected] of Object.entries(startupIdentities)) {
    read(file);
    if (identities[file] !== expected) throw new Error(`${file}: unsupported startup or graphics implementation`);
  }
  const scripts = [...read('index.html').replace(/<!--[\s\S]*?-->/g, '').matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)].map(match => {
    const src = match[1].match(/^\s*(?:type=["']text\/javascript["']\s+)?src=["']([^"']+)["']\s*$/i);
    if (!src || match[2].trim()) throw new Error('index.html: unsupported script declaration');
    return src[1];
  });
  const expectedScripts = ['js/libs/pixi.js', 'js/libs/pixi-tilemap.js', 'js/libs/pixi-picture.js', 'js/libs/fpsmeter.js', 'js/libs/lz-string.js', 'js/libs/iphone-inline-video.browser.js',
    ...Object.keys(coreIdentities).map(name => `js/${name}.js`), 'js/plugins.js', 'js/main.js'];
  if (JSON.stringify(scripts) !== JSON.stringify(expectedScripts)) throw new Error('index.html: unsupported script loading order');
  const manifest = parsePluginManifest(read('js/plugins.js'), 'js/plugins.js', { literalOnly: true });
  let settings = { width: 816, height: 624, imageCacheBytes: 10000000, alwaysDash: false };
  for (const plugin of manifest.plugins.filter(item => item.status)) {
    if (plugin.name !== 'Community_Basic') throw new Error(`js/plugins.js: unsupported plugin ${plugin.name}`);
    const file = `js/plugins/${plugin.name}.js`;
    read(file);
    if (identities[file] !== '30a0f7ab476384f14271c1e0694b45ba0069e8702d5f2f4afa64e148f340c2d6') throw new Error(`${file}: unsupported plugin implementation`);
    const p = plugin.parameters;
    settings = { width: Number(p.screenWidth || 816), height: Number(p.screenHeight || 624),
      imageCacheBytes: Number(p.cacheLimit || 10) * 1000000, alwaysDash: p.alwaysDash === 'on' };
    if (p.renderingMode && !['auto', 'webgl'].includes(p.renderingMode.toLowerCase())) throw new Error(`${file}: unsupported rendering mode`);
    if (![settings.width, settings.height, settings.imageCacheBytes].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error(`${file}: invalid dimensions or cache budget`);
  }
  const database = {};
  database.tileTables = {};
  const coreSource = fs.readFileSync(path.join(root, 'js/rpg_core.js'), 'utf8');
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
    database.maps[info.id] = JSON.parse(read(`data/Map${String(info.id).padStart(3, '0')}.json`));
  }
  const contract = inspectDatabase(database);
  if (contract.issues.length) throw new Error(contract.issues.map(issue => `${issue.location}: ${issue.reason}`).join('\n'));
  return { database, settings, contract, identities };
}

module.exports = { loadGame, inspectDatabase };
