#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { discoverAchievements } from './achievement-discovery.mjs';
import pluginManifest from '../runner/plugin-manifest.cjs';

export function pluginIdentity(name, engine = 'mv') {
  let value = name.replace(/\.js$/i, '');
  if (engine === 'mz') value = value.split('/').pop();
  return value.toLowerCase();
}

export function preparationInputs(gameDir, config, manifest, adapters = [], hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')) {
  const candidates = ['js/rpg_core.js', 'js/rpg_managers.js', 'js/rmmz_core.js',
    'js/libs/pixi.js', 'js/pixi.js', 'js/libs/pixi-tilemap.js', 'js/pixi-tilemap.js', 'js/plugins.js',
    'lib/steam_settings/achievements.json'];
  const files = candidates.map(name => path.join(gameDir, name));
  if (config) files.push(config);
  if (manifest) files.push(manifest);
  files.push(...adapters);
  return Object.fromEntries(files.map(file => [file, fs.existsSync(file) ?
    hash(file) : null]));
}

export function prepareGameConfig(gameDir, config = {}) {
  if (Array.isArray(config.achievements?.catalog)) return config;
  const file = path.join(gameDir, 'lib/steam_settings/achievements.json');
  let records;
  try {
    records = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(records)) throw new Error('expected an array');
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn('[pmjs-build] Cannot import achievement metadata: ' + error.message);
    records = null;
  }
  if (records === null) return config;
  const seen = new Set();
  const catalog = [];
  for (const record of records) {
    if (!record || typeof record.name !== 'string' || !record.name || seen.has(record.name)) {
      console.warn('[pmjs-build] Ignoring achievement metadata with a missing or duplicate name');
      continue;
    }
    seen.add(record.name);
    catalog.push({ id: record.name,
      name: typeof record.displayName === 'string' ? record.displayName : record.name,
      description: typeof record.description === 'string' ? record.description : '',
      hidden: record.hidden === true || record.hidden === '1' || record.hidden === 1,
      icon: typeof record.icon === 'string' && record.icon ?
        path.posix.join('lib/steam_settings', record.icon.replaceAll('\\', '/')) : null });
  }
  return { ...config, achievements: { ...config.achievements, catalog } };
}

export function detectEngine(gameDir) {
  const read = (relative) => {
    const file = path.join(gameDir, relative);
    if (!fs.existsSync(file)) return null;
    try {
      return fs.readFileSync(file, 'utf8');
    } catch {
      return null;
    }
  };

  const rpgCore = read(path.join('js', 'rpg_core.js'));
  const rpgManagers = read(path.join('js', 'rpg_managers.js'));
  if (rpgCore !== null && rpgManagers !== null) {
    let mvVersion = null;
    const versionMatch = rpgCore.match(/Utils\.RPGMAKER_VERSION\s*=\s*['"](\d+\.\d+\.\d+)['"]/i) ||
      rpgCore.match(/RPG Maker MV\s+v?(\d+\.\d+\.\d+)/i) ||
      rpgCore.match(/rpg_core\.js\s+v?(\d+\.\d+\.\d+)/i) ||
      rpgCore.match(/\bv(\d+\.\d+\.\d+)\b/);
    if (versionMatch) mvVersion = versionMatch[1];
    return { engine: 'mv', engineVersion: mvVersion, mvVersion };
  }

  const rmmzCore = read(path.join('js', 'rmmz_core.js'));
  if (rmmzCore !== null) {
    const versionMatch = rmmzCore.match(/Utils\.RPGMAKER_VERSION\s*=\s*['"](\d+\.\d+\.\d+)['"]/i) ||
      rmmzCore.match(/RPG Maker MZ\s+v?(\d+\.\d+\.\d+)/i) ||
      rmmzCore.match(/rmmz_core\.js\s+v?(\d+\.\d+\.\d+)/i);
    return { engine: 'mz', engineVersion: versionMatch && versionMatch[1],
      mvVersion: null };
  }

  return { engine: 'unknown', engineVersion: null, mvVersion: null };
}

export function resolveGameDirectory(location) {
  const directory = fs.realpathSync(location);
  if (!fs.statSync(directory).isDirectory()) throw new Error('game must be a directory');
  if (detectEngine(directory).engine !== 'unknown') return directory;
  const web = path.join(directory, 'www');
  if (detectEngine(web).engine !== 'unknown') return fs.realpathSync(web);

  // PortMaster game data may contain one nested game, with or without www.
  const nested = fs.readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .flatMap(entry => [path.join(directory, entry.name), path.join(directory, entry.name, 'www')])
    .filter(candidate => detectEngine(candidate).engine !== 'unknown');
  if (nested.length === 1) return fs.realpathSync(nested[0]);
  if (nested.length > 1) throw new Error(`Multiple games found in ${directory}; keep only one game folder`);
  throw new Error(`no RPG Maker MV/MZ game found in ${directory}`);
}

export function detectPixiVersion(gameDir) {
  for (const relative of [path.join('js', 'libs', 'pixi.js'), path.join('js', 'pixi.js')]) {
    const file = path.join(gameDir, relative);
    if (!fs.existsSync(file)) continue;
    let source = '';
    try {
      const handle = fs.openSync(file, 'r');
      try {
        const buffer = Buffer.alloc(65536);
        const bytes = fs.readSync(handle, buffer, 0, buffer.length, 0);
        source = buffer.subarray(0, bytes).toString('utf8');
      } finally {
        fs.closeSync(handle);
      }
    } catch {
      continue;
    }
    const match = source.match(/VERSION\s*=\s*['"](\d+\.\d+\.\d+)['"]/) ||
      source.match(/pixi\.js\s+v?(\d+\.\d+\.\d+)/i) ||
      source.match(/\bv(\d+\.\d+\.\d+)\b/);
    if (match) return { pixiVersion: match[1], pixiPath: relative };
    return { pixiVersion: null, pixiPath: relative };
  }
  return { pixiVersion: null, pixiPath: null };
}

function detectPixiTilemapPath(gameDir) {
  for (const relative of [path.join('js', 'libs', 'pixi-tilemap.js'),
    path.join('js', 'pixi-tilemap.js')]) {
    if (fs.existsSync(path.join(gameDir, relative))) return relative;
  }
  return null;
}

export function readPluginManifest(gameDir) {
  const file = path.join(gameDir, 'js', 'plugins.js');
  if (!fs.existsSync(file)) {
    throw new Error(`plugin manifest not found: ${file}`);
  }
  const source = fs.readFileSync(file, 'utf8');
  const parsed = pluginManifest.parsePluginManifest(source, file);
  // Adapter inspection requires status === true; loaders use truthiness and tracking uses status !== false.
  const plugins = parsed.plugins.filter(entry => entry && typeof entry.name === 'string')
    .map(entry => ({ name: entry.name, status: entry.status === true }));
  return { plugins, enabled: plugins.filter(entry => entry.status).map(entry => entry.name) };
}

export function loadAdapterRegistry(registryPath) {
  const raw = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  if (!Array.isArray(raw.adapters)) {
    throw new Error(`adapter registry requires an adapters array: ${registryPath}`);
  }
  const seen = new Map();
  for (const entry of raw.adapters) {
    if (!entry || !Array.isArray(entry.plugins) || !entry.plugins.length ||
        !entry.plugins.every(plugin => typeof plugin === 'string' && plugin) ||
        !Array.isArray(entry.modules) || !entry.modules.length ||
        !entry.modules.every(module => typeof module === 'string' && module)) {
      throw new Error(`adapter registry entry requires nonempty plugins and modules arrays: ${registryPath}`);
    }
    for (const plugin of entry.plugins) {
      const identity = pluginIdentity(plugin);
      if (seen.has(identity)) throw new Error(`duplicate adapter plugin name: ${seen.get(identity)} and ${plugin}`);
      seen.set(identity, plugin);
    }
  }
  return raw.adapters;
}

// Resolve registry adapters against enabled plugin names. Returns the
// modules to include, in registry order, with the match reason attached.
export function resolveAdapters(adapters, enabledNames) {
  const enabled = new Set(enabledNames.map(name => pluginIdentity(name)));
  return adapters
    .flatMap(entry => {
      const plugin = entry.plugins.find(name => enabled.has(pluginIdentity(name)));
      return plugin ? [{ plugin, modules: entry.modules }] : [];
    });
}

export function inspectGame(gameDir, registryPath) {
  const absolute = path.resolve(gameDir);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isDirectory()) {
    throw new Error(`game directory not found: ${absolute}`);
  }
  const engine = detectEngine(absolute);
  const pixi = detectPixiVersion(absolute);
  const manifest = readPluginManifest(absolute);
  const registry = registryPath ? loadAdapterRegistry(registryPath) : [];
  const identities = new Map();
  for (const name of manifest.enabled) {
    const identity = pluginIdentity(name, engine.engine);
    if (!identities.has(identity)) identities.set(identity, []);
    identities.get(identity).push(name);
  }
  const collisions = [...identities.values()].filter(names => names.length > 1);
  for (const names of collisions) {
    console.warn(`[pmjs-build] plugin identity collision: ${names.join(', ')}; automatic adapter selection skipped`);
  }
  const ambiguous = new Set(collisions.map(names => pluginIdentity(names[0], engine.engine)));
  const selectable = manifest.enabled.filter(name => !ambiguous.has(pluginIdentity(name, engine.engine)));
  const matched = resolveAdapters(registry, selectable);
  const unknown = manifest.enabled.filter(name =>
    !registry.some(entry => entry.plugins.some(plugin => pluginIdentity(plugin) === pluginIdentity(name))));
  return {
    gameDir: absolute,
    engine: engine.engine,
    engineVersion: engine.engineVersion,
    mvVersion: engine.mvVersion,
    pixiVersion: pixi.pixiVersion,
    pixiPath: pixi.pixiPath,
    pixiTilemapPath: detectPixiTilemapPath(absolute),
    pluginTotal: manifest.plugins.length,
    enabledPlugins: manifest.enabled,
    selectablePlugins: selectable,
    matchedAdapters: matched,
    unmatchedEnabledPlugins: unknown,
  };
}

export function inspectAchievements(gameDir) {
  return discoverAchievements(gameDir, readPluginManifest(gameDir).plugins);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4 || process.argv[2] !== '--achievements') {
    throw new Error('usage: game-inspect.mjs --achievements GAME_DIRECTORY');
  }
  console.log(JSON.stringify(inspectAchievements(path.resolve(process.argv[3])), null, 2));
}
