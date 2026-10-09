#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectGame, loadAdapterRegistry, resolveAdapters } from './game-inspect.mjs';

const args = process.argv.slice(2);
const values = new Map();
const adapterFiles = [];
const switches = new Set(['--check', '--print-modules', '--verbose']);
const inputs = new Set(['--manifest', '--profile', '--config', '--output', '--game']);
for (let index = 0; index < args.length; index++) {
  const argument = args[index];
  if (argument === '--adapter' && args[index + 1] && !args[index + 1].startsWith('--')) {
    adapterFiles.push(fs.realpathSync(path.resolve(args[++index])));
    continue;
  }
  if (switches.has(argument)) { values.set(argument, true); continue; }
  if (!inputs.has(argument) || values.has(argument) || !args[index + 1] || args[index + 1].startsWith('--')) {
    throw new Error(`invalid argument: ${argument}`);
  }
  values.set(argument, args[++index]);
}
const check = values.has('--check');
const printModules = values.has('--print-modules');
const verbose = values.has('--verbose');
const manifestArgument = values.get('--manifest');
const profileArgument = values.get('--profile');
const configArgument = values.get('--config');
const outputArgument = values.get('--output');
const gameArgument = values.get('--game');
if ((!profileArgument && !gameArgument) || (!outputArgument && !printModules)) {
  console.error('usage: build-js-runtime.mjs (--game DIR [--manifest FILE] | --profile NAME) [--adapter FILE ...] [--config JSON] --output FILE [--check] [--print-modules] [--verbose]');
  process.exit(2);
}
if (profileArgument && (gameArgument || manifestArgument)) {
  throw new Error('--profile cannot be combined with --game or --manifest');
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = outputArgument ? path.resolve(outputArgument) : null;
const supportedEngines = {
  mv: { profile: 'mv', pixiMajor: 4, bootstrap: 'js/pmjs-mv/bootstrap.js', pluginAdapters: true },
  mz: { profile: 'mz', pixiMajor: 5, bootstrap: 'js/pmjs-mz/bootstrap.js', pluginAdapters: false },
};

// Structural validation only: the runtime optimization registry remains the
// single authority for which IDs exist. Unknown IDs fail at startup instead.
function assertDisableOptimizationsShape(value, configPath) {
  if (value === undefined) return;
  const ok = Array.isArray(value) && value.every(id => typeof id === 'string' && id) &&
    new Set(value).size === value.length;
  if (!ok) {
    console.error(`error: disableOptimizations in ${configPath} must be an array of unique nonempty strings`);
    process.exit(1);
  }
}

let rawModules = [];
let buildReport = null;
let detectedRuntime = null;

function loadProfile(name) {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error(`invalid profile: ${name}`);
  const profilePath = path.join(root, 'profiles', `${name}.json`);
  const baseDir = root;
  if (!fs.existsSync(profilePath)) {
    console.error(`error: profile '${name}' not found at ${profilePath}`);
    process.exit(1);
  }
  const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
  if (!Array.isArray(profile.modules) || !profile.modules.length) {
    throw new Error(`profile '${name}' requires a non-empty modules array`);
  }
  return { ...profile, baseDir };
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
  for (const name of [...include, ...exclude]) {
    if (typeof name !== 'string' || !known.has(name)) {
      throw new Error(`manifest ${manifestPath} adapters unknown plugin: ${name}`);
    }
  }
  let names = mode === 'all' ? [...known]
    : mode === 'auto' ? inspection.enabledPlugins
      : mode === 'explicit' ? include : [];
  if (mode === 'auto') names = [...new Set([...names, ...include])];
  const excluded = new Set(exclude);
  return resolveAdapters(registry, names.filter(name => !excluded.has(name)));
}

function resolveCapabilityManifest(manifest, manifestPath) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error(`manifest ${manifestPath} must be an object`);
  }
  for (const key of Object.keys(manifest)) {
    if (key !== 'adapters') throw new Error(`unsupported manifest key: ${key}`);
  }
  if (!gameArgument) throw new Error(`capability manifest ${manifestPath} requires --game`);
  const adaptersOption = manifest.adapters === undefined ? 'auto' : manifest.adapters;

  const registryPath = path.join(root, 'profiles', 'plugin-adapters.json');
  const registry = loadAdapterRegistry(registryPath);

  let inspection;
  try {
    inspection = inspectGame(path.resolve(process.cwd(), gameArgument), registryPath);
  } catch (error) {
    throw new Error(`cannot inspect game: ${error.message}`);
  }
  const engine = supportedEngines[inspection.engine];
  if (!engine) {
    throw new Error(`detected unsupported engine '${inspection.engine}' in ${inspection.gameDir}`);
  }
  if (!inspection.pixiPath) {
    throw new Error(`detected ${inspection.engine.toUpperCase()} but could not find Pixi`);
  }
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
  detectedRuntime = {
    engine: inspection.engine,
    engineVersion: inspection.engineVersion,
    pixiPath: inspection.pixiPath.replaceAll(path.sep, '/'),
    pixiVersion: inspection.pixiVersion,
    pixiTilemapPath: inspection.pixiTilemapPath &&
      inspection.pixiTilemapPath.replaceAll(path.sep, '/'),
  };

  const profileName = engine.profile;
  const profile = loadProfile(profileName);
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
  const selected = engine.pluginAdapters
    ? adapterSelection(adaptersOption, registry, inspection, manifestPath)
    : [];
  const adapterModules = [];
  const adapterReport = [];
  for (const { plugin, modules } of selected) {
    for (const module of modules) {
      if (!adapterModules.includes(module)) adapterModules.push(module);
    }
    adapterReport.push(`${plugin} -> ${modules.join(', ')}`);
  }

  const split = baseModules.length - 1;
  const ordered = [
    ...baseModules.slice(0, split).map(mod => ({ module: mod, baseDir })),
    ...adapterModules.map(mod => ({ module: mod, baseDir: root })),
    ...baseModules.slice(split).map(mod => ({ module: mod, baseDir })),
  ];
  buildReport = {
    engine: profileName,
    detected: inspection ? {
      engine: inspection.engine,
      mvVersion: inspection.mvVersion,
      pixiVersion: inspection.pixiVersion,
      pluginTotal: inspection.pluginTotal,
      enabledPlugins: inspection.enabledPlugins.length,
      unmatchedEnabledPlugins: inspection.unmatchedEnabledPlugins,
    } : null,
    adapters: adapterReport,
  };
  return ordered;
}

if (profileArgument) {
  const { modules, baseDir } = loadProfile(profileArgument);
  rawModules = modules.map(mod => ({ module: mod, baseDir }));
} else if (manifestArgument) {
  const manifestPath = path.resolve(manifestArgument);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  rawModules = resolveCapabilityManifest(manifest, manifestPath);
} else {
  rawModules = resolveCapabilityManifest({}, '<command line>');
}

function printBuildReport() {
  if (!buildReport) return;
  const lines = [`[pmjs-build] engine: ${buildReport.engine}`];
  if (buildReport.detected) {
    const detected = buildReport.detected;
    const versions = [detected.mvVersion ? `mv ${detected.mvVersion}` : null,
      detected.pixiVersion ? `pixi ${detected.pixiVersion}` : null]
      .filter(Boolean).join(', ');
    lines.push(`[pmjs-build] detected: ${detected.engine}${versions ? ` (${versions})` : ''}, ${detected.enabledPlugins}/${detected.pluginTotal} plugins enabled`);
  }
  lines.push(`[pmjs-build] matched adapters: ${buildReport.adapters.length}`);
  if (buildReport.adapters.length) lines.push(buildReport.adapters.map(entry => `  ${entry}`).join('\n'));
  if (buildReport.detected) {
    const unmatched = buildReport.detected.unmatchedEnabledPlugins;
    lines.push(`[pmjs-build] unmatched enabled plugins: ${unmatched.length}`);
    if (verbose && unmatched.length) lines.push(`No PMJS adapter:\n${unmatched.map(name => `  ${name}`).join('\n')}`);
  }
  const write = printModules ? console.error : console.log;
  write(lines.join('\n'));
}

if (adapterFiles.length) {
  const bootstrap = rawModules.findIndex(item =>
    Object.values(supportedEngines).some(engine => item.module === engine.bootstrap));
  if (bootstrap !== rawModules.length - 1 || bootstrap < 0) {
    throw new Error('explicit adapters require a terminal MV/MZ bootstrap');
  }
  rawModules.splice(bootstrap, 0, ...adapterFiles.map(file => ({ module: path.basename(file), file })));
}

const seenModules = new Set();
for (const item of rawModules) {
  if (!item.file && (typeof item.module !== 'string' || !item.module || path.isAbsolute(item.module) ||
      item.module.split(/[\\/]/).includes('..'))) {
    throw new Error(`invalid bundle module: ${item.module}`);
  }
  const identity = item.file || fs.realpathSync(path.resolve(root, item.module));
  if (seenModules.has(identity)) {
    throw new Error(`duplicate module in profile/manifest: ${item.module}`);
  }
  seenModules.add(identity);
}

const bundleItems = [];

if (detectedRuntime) {
  bundleItems.push({ label: 'detected-game', inlineSource:
    `globalThis.PMJS_RUNTIME_GAME = ${JSON.stringify(detectedRuntime)};\n` });
}

if (configArgument) {
  const resolvedConfig = path.resolve(process.cwd(), configArgument);
  if (!fs.existsSync(resolvedConfig)) {
    console.error(`error: config file not found: ${resolvedConfig}`);
    process.exit(1);
  }
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(resolvedConfig, 'utf8')); }
  catch (error) { throw new Error(`invalid JSON in config file ${resolvedConfig}: ${error.message}`); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('configuration must be an object');
  assertDisableOptimizationsShape(parsed.disableOptimizations, resolvedConfig);
  bundleItems.push({ label: path.basename(resolvedConfig), inlineSource:
    `globalThis.PMJS_GAME_CONFIG = ${JSON.stringify(parsed, null, 2)};\n` });
}
for (const item of rawModules) {
  bundleItems.push({ label: item.module, module: item.module, file: item.file, baseDir: root });
}

function buildBundle() {
  return bundleItems.map(item => {
    let source;
    if (item.inlineSource) {
      source = item.inlineSource;
    } else if (item.file) {
      source = fs.readFileSync(item.file, 'utf8');
    } else {
      const fileResolved = path.resolve(item.baseDir, item.module);
      source = fs.readFileSync(fileResolved, 'utf8');
    }
    return `// BEGIN ${item.label}\n${source.trimEnd()}\n// END ${item.label}\n`;
  }).join('\n');
}

const bundle = buildBundle();
if (printModules) {
  printBuildReport();
  console.log(JSON.stringify(rawModules.map(item => ({
    module: item.module,
    base: item.file ? 'explicit-adapter' : 'native-runtime',
  }))));
  process.exit(0);
}
if (check) {
  if (!output) {
    console.error('error: --check requires --output');
    process.exit(2);
  }
  const current = fs.existsSync(output) ? fs.readFileSync(output, 'utf8') : '';
  if (current !== bundle) {
    console.error(`${path.relative(root, output)} is out of date`);
    process.exitCode = 1;
  }
} else if (fs.existsSync(output) && fs.readFileSync(output, 'utf8') === bundle) {
  console.log(`unchanged ${path.relative(process.cwd(), output)}`);
} else {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const temporary = `${output}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(temporary, bundle, { flag: 'wx' });
    fs.renameSync(temporary, output);
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  console.log(`generated ${path.relative(process.cwd(), output)} from ${bundleItems.length} modules`);
  printBuildReport();
}
