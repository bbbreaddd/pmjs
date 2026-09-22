#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

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
    const versionMatch = rpgCore.match(/RPG Maker MV\s+v?(\d+\.\d+\.\d+)/i) ||
      rpgCore.match(/rpg_core\.js\s+v?(\d+\.\d+\.\d+)/i) ||
      rpgCore.match(/\bv(\d+\.\d+\.\d+)\b/);
    if (versionMatch) mvVersion = versionMatch[1];
    return { engine: 'mv', engineVersion: mvVersion, mvVersion };
  }

  const rmmzCore = read(path.join('js', 'rmmz_core.js'));
  if (rmmzCore !== null) {
    const versionMatch = rmmzCore.match(/RPG Maker MZ\s+v?(\d+\.\d+\.\d+)/i) ||
      rmmzCore.match(/rmmz_core\.js\s+v?(\d+\.\d+\.\d+)/i);
    return { engine: 'mz', engineVersion: versionMatch && versionMatch[1],
      mvVersion: null };
  }

  return { engine: 'unknown', engineVersion: null, mvVersion: null };
}

export function detectPixiVersion(gameDir) {
  for (const relative of [path.join('js', 'libs', 'pixi.js'), path.join('js', 'pixi.js')]) {
    const file = path.join(gameDir, relative);
    if (!fs.existsSync(file)) continue;
    let source = '';
    try {
      const handle = fs.openSync(file, 'r');
      const buffer = Buffer.alloc(65536);
      const bytes = fs.readSync(handle, buffer, 0, buffer.length, 0);
      fs.closeSync(handle);
      source = buffer.subarray(0, bytes).toString('utf8');
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

function pluginArrayText(source) {
  const assignment = source.match(/(?:\bvar\s+)?\$plugins\s*=/);
  if (!assignment) throw new Error('js/plugins.js does not assign $plugins');
  const start = source.indexOf('[', assignment.index + assignment[0].length);
  if (start < 0) throw new Error('js/plugins.js does not contain a $plugins array');

  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (quote !== null) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"') {
      quote = character;
    } else if (character === '[') {
      depth += 1;
    } else if (character === ']') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error('js/plugins.js has an unterminated $plugins array');
}

export function readPluginManifest(gameDir) {
  const file = path.join(gameDir, 'js', 'plugins.js');
  if (!fs.existsSync(file)) {
    throw new Error(`plugin manifest not found: ${file}`);
  }
  const source = fs.readFileSync(file, 'utf8');
  try {
    const entries = JSON.parse(pluginArrayText(source));
    if (!Array.isArray(entries)) throw new Error('$plugins is not an array');
    const plugins = entries
      .filter(entry => entry && typeof entry.name === 'string')
      .map(entry => ({ name: entry.name, status: entry.status === true }));
    const enabled = plugins.filter(entry => entry.status).map(entry => entry.name);
    return { plugins, enabled };
  } catch (error) {
    throw new Error(`unsupported generated plugin manifest ${file}: ${error.message}`);
  }
}

export function loadAdapterRegistry(registryPath) {
  const raw = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  if (!Array.isArray(raw.adapters)) {
    throw new Error(`adapter registry requires an adapters array: ${registryPath}`);
  }
  const seen = new Set();
  for (const entry of raw.adapters) {
    if (!entry || !Array.isArray(entry.plugins) || !entry.plugins.length ||
        !entry.plugins.every(plugin => typeof plugin === 'string' && plugin) ||
        !Array.isArray(entry.modules) || !entry.modules.length ||
        !entry.modules.every(module => typeof module === 'string' && module)) {
      throw new Error(`adapter registry entry requires nonempty plugins and modules arrays: ${registryPath}`);
    }
    for (const plugin of entry.plugins) {
      if (seen.has(plugin)) throw new Error(`duplicate adapter plugin name: ${plugin}`);
      seen.add(plugin);
    }
  }
  return raw.adapters;
}

// Resolve registry adapters against enabled plugin names. Returns the
// modules to include, in registry order, with the match reason attached.
export function resolveAdapters(adapters, enabledNames) {
  const enabled = new Set(enabledNames);
  return adapters
    .flatMap(entry => {
      const plugin = entry.plugins.find(name => enabled.has(name));
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
  const matched = resolveAdapters(registry, manifest.enabled);
  const unknown = manifest.enabled.filter(name =>
    !registry.some(entry => entry.plugins.includes(name)));
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
    matchedAdapters: matched,
    unmatchedEnabledPlugins: unknown,
  };
}
