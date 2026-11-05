import fs from 'node:fs';
import path from 'node:path';
import { inspectGame, loadAdapterRegistry, resolveAdapters, pluginIdentity } from './game-inspect.mjs';

export const supportedEngines = {
  mv: { profile: 'mv', pixiMajor: 4, bootstrap: 'js/pmjs-mv/bootstrap.js', pluginAdapters: true },
  mz: { profile: 'mz', pixiMajor: 5, bootstrap: 'js/pmjs-mz/bootstrap.js', pluginAdapters: false },
};

export function loadProfile(root, name) {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error(`invalid profile: ${name}`);
  const profilePath = path.join(root, 'profiles', `${name}.json`);
  if (!fs.existsSync(profilePath)) throw new Error(`profile '${name}' not found at ${profilePath}`);
  const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
  if (!Array.isArray(profile.modules) || !profile.modules.length) {
    throw new Error(`profile '${name}' requires a non-empty modules array`);
  }
  return { ...profile, baseDir: root };
}

function adapterSelection(option, registry, inspection, manifestPath) {
  let mode = option;
  let include = [];
  let exclude = [];
  if (option && typeof option === 'object' && !Array.isArray(option)) {
    mode = option.mode;
    include = option.include || [];
    exclude = option.exclude || [];
    if (mode !== 'auto' || !Array.isArray(include) || !Array.isArray(exclude)) {
      throw new Error(`manifest ${manifestPath} adapter object requires mode "auto" and include/exclude arrays`);
    }
  }
  if (Array.isArray(option)) {
    mode = 'explicit';
    include = option;
  }
  if (!['auto', 'all', 'none', 'explicit'].includes(mode)) {
    throw new Error(`manifest ${manifestPath} adapters must be "auto", "all", "none", an array, or an auto override object`);
  }
  const known = new Set(registry.flatMap(entry => entry.plugins));
  const identity = name => pluginIdentity(name);
  const knownIdentities = new Set([...known].map(identity));
  for (const name of [...include, ...exclude]) {
    if (typeof name !== 'string' || !knownIdentities.has(identity(name))) {
      throw new Error(`manifest ${manifestPath} adapters unknown plugin: ${name}`);
    }
  }
  let names = mode === 'all' ? [...known]
    : mode === 'auto' ? inspection.selectablePlugins
      : mode === 'explicit' ? include : [];
  if (mode === 'auto') names = [...new Set([...names, ...include])];
  const excluded = new Set(exclude.map(identity));
  return resolveAdapters(registry, names.filter(name => !excluded.has(identity(name))));
}

export function resolveCapabilityManifest({ root, gameDir, manifest = {}, manifestPath = '<command line>' }) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error(`manifest ${manifestPath} must be an object`);
  }
  for (const key of Object.keys(manifest)) {
    if (key !== 'adapters') throw new Error(`unsupported manifest key: ${key}`);
  }
  if (!gameDir) throw new Error(`capability manifest ${manifestPath} requires --game`);
  const adaptersOption = manifest.adapters === undefined ? 'auto' : manifest.adapters;
  const registryPath = path.join(root, 'profiles', 'plugin-adapters.json');
  const registry = loadAdapterRegistry(registryPath);

  let inspection;
  try {
    inspection = inspectGame(path.resolve(gameDir), registryPath);
  } catch (error) {
    throw new Error(`cannot inspect game: ${error.message}`);
  }
  const engine = supportedEngines[inspection.engine];
  if (!engine) throw new Error(`detected unsupported engine '${inspection.engine}' in ${inspection.gameDir}`);
  if (!inspection.pixiPath) throw new Error(`detected ${inspection.engine.toUpperCase()} but could not find Pixi`);
  if (!inspection.pixiVersion) {
    throw new Error(`detected ${inspection.engine.toUpperCase()} but could not determine Pixi version from ${inspection.pixiPath}`);
  }
  const detectedPixiMajor = Number.parseInt(inspection.pixiVersion, 10);
  if (detectedPixiMajor !== engine.pixiMajor) {
    throw new Error(`engine ${inspection.engine} requires Pixi ${engine.pixiMajor}.x; detected ${inspection.pixiVersion}`);
  }
  if (inspection.engine === 'mv' && !inspection.pixiTilemapPath) {
    throw new Error('detected MV but could not find pixi-tilemap.js');
  }
  const detectedRuntime = {
    engine: inspection.engine,
    engineVersion: inspection.engineVersion,
    pixiPath: inspection.pixiPath.replaceAll(path.sep, '/'),
    pixiVersion: inspection.pixiVersion,
    pixiTilemapPath: inspection.pixiTilemapPath && inspection.pixiTilemapPath.replaceAll(path.sep, '/'),
  };

  const profileName = engine.profile;
  const profile = loadProfile(root, profileName);
  const baseModules = profile.modules;
  const baseDir = profile.baseDir;
  const bootstrap = engine.bootstrap;
  const bootstrapCount = baseModules.filter(module => module === bootstrap).length;
  if (bootstrapCount !== 1 || baseModules.at(-1) !== bootstrap) {
    throw new Error(`profile ${profileName} must contain ${bootstrap} exactly once as its final module`);
  }
  if (!engine.pluginAdapters && adaptersOption !== 'auto' && adaptersOption !== 'none') {
    throw new Error(`engine ${inspection.engine} does not yet support plugin adapter selection`);
  }
  const selected = engine.pluginAdapters ? adapterSelection(adaptersOption, registry, inspection, manifestPath) : [];
  const adapterModules = [];
  const adapterReport = [];
  for (const { plugin, modules } of selected) {
    for (const module of modules) if (!adapterModules.includes(module)) adapterModules.push(module);
    adapterReport.push(`${plugin} -> ${modules.join(', ')}`);
  }

  const split = baseModules.length - 1;
  const modules = [
    ...baseModules.slice(0, split).map(module => ({ module, baseDir })),
    ...adapterModules.map(module => ({ module, baseDir: root })),
    ...baseModules.slice(split).map(module => ({ module, baseDir })),
  ];
  const buildReport = {
    engine: profileName,
    detected: {
      engine: inspection.engine,
      mvVersion: inspection.mvVersion,
      pixiVersion: inspection.pixiVersion,
      pluginTotal: inspection.pluginTotal,
      enabledPlugins: inspection.enabledPlugins.length,
      unmatchedEnabledPlugins: inspection.unmatchedEnabledPlugins,
    },
    adapters: adapterReport,
  };
  return { modules, buildReport, detectedRuntime };
}

export function insertExplicitAdapters(modules, files) {
  if (!files.length) return modules;
  const bootstrap = modules.findIndex(item => Object.values(supportedEngines)
    .some(engine => item.module === engine.bootstrap));
  if (bootstrap !== modules.length - 1 || bootstrap < 0) {
    throw new Error('explicit adapters require a terminal MV/MZ bootstrap');
  }
  return [
    ...modules.slice(0, bootstrap),
    ...files.map(file => ({ module: path.basename(file), file })),
    ...modules.slice(bootstrap),
  ];
}
