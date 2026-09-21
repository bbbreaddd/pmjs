#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectGame, loadAdapterRegistry, resolveAdapters } from './game-inspect.mjs';

const args = process.argv.slice(2);
const check = args.includes('--check');
const printModules = args.includes('--print-modules');
const verbose = args.includes('--verbose');

function option(name) {
  const index = args.indexOf(name);
  if (index < 0 || index + 1 >= args.length) return null;
  return args[index + 1];
}

const rootArgument = option('--root');
const manifestArgument = option('--manifest');
const profileArgument = option('--profile');
const configArgument = option('--config');
const compatArgument = option('--compat');
const outputArgument = option('--output');
const gameArgument = option('--game');

if (!manifestArgument && !profileArgument && !gameArgument) {
  console.error('usage: build-js-runtime.mjs [--root ROOT] (--game DIR [--manifest FILE] | --profile NAME | --manifest FILE) [--output FILE] [--config FILE] [--compat FILE] [--check] [--print-modules]');
  process.exit(2);
}
if (!outputArgument && !printModules) {
  console.error('usage: build-js-runtime.mjs [--root ROOT] (--game DIR [--manifest FILE] | --profile NAME | --manifest FILE) --output FILE [--config FILE] [--compat FILE] [--check] [--print-modules]');
  process.exit(2);
}
if (profileArgument && gameArgument) {
  console.error('error: --game and --profile are mutually exclusive');
  process.exit(2);
}

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = rootArgument ? path.resolve(process.cwd(), rootArgument) : defaultRoot;
const supportedEngines = {
  mv: { profile: 'mv', pixiMajor: 4, bootstrap: 'js/pmjs-mv/bootstrap.js', pluginAdapters: true },
  mz: { profile: 'mz', pixiMajor: 5, bootstrap: 'js/pmjs-mz/bootstrap.js', pluginAdapters: false },
};

function insideRoot(input, label) {
  const resolved = path.resolve(root, input);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`${label} must be inside root`);
  }
  return resolved;
}

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

let output = null;
if (outputArgument) {
  if (profileArgument || path.isAbsolute(outputArgument)) {
    output = path.resolve(process.cwd(), outputArgument);
  } else {
    output = insideRoot(outputArgument, 'output');
  }
}

function findProfile(name) {
  const inRoot = path.resolve(root, 'profiles', `${name}.json`);
  if (fs.existsSync(inRoot)) return { profilePath: inRoot, baseDir: root };
  const inDefault = path.resolve(defaultRoot, 'profiles', `${name}.json`);
  if (fs.existsSync(inDefault)) return { profilePath: inDefault, baseDir: defaultRoot };
  return { profilePath: inRoot, baseDir: root };
}

let rawModules = [];
let buildReport = null;

function loadProfile(name) {
  const { profilePath, baseDir } = findProfile(name);
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

function portFiles(port, manifestPath) {
  if (port === undefined) return { config: null, modules: [], id: null };
  if (!port || typeof port !== 'object' || Array.isArray(port) ||
      typeof port.id !== 'string' || !port.id ||
      typeof port.entry !== 'string' || !port.entry) {
    throw new Error(`manifest ${manifestPath} port requires nonempty id and entry strings`);
  }
  if (path.basename(port.id) !== port.id || port.id === '.' || port.id === '..') {
    throw new Error(`manifest ${manifestPath} port id must be one path segment`);
  }
  const portRoot = path.resolve(root, 'ports', port.id);
  function insidePort(relative, label) {
    if (typeof relative !== 'string' || !relative) {
      throw new Error(`manifest ${manifestPath} port ${label} must be a nonempty path`);
    }
    const absolute = path.resolve(root, relative);
    const fromPort = path.relative(portRoot, absolute);
    if (fromPort === '' || fromPort === '..' || fromPort.startsWith(`..${path.sep}`) ||
        path.isAbsolute(fromPort)) {
      throw new Error(`manifest ${manifestPath} port ${label} must live under ports/${port.id}/`);
    }
    return absolute;
  }
  for (const [label, value] of [['config', port.config], ['entry', port.entry]]) {
    if (value !== undefined) insidePort(value, label);
  }
  const entryPath = insidePort(port.entry, 'entry');
  const entry = JSON.parse(fs.readFileSync(entryPath, 'utf8'));
  if (!Array.isArray(entry.modules) || !entry.modules.length ||
      !entry.modules.every(module => typeof module === 'string' && module)) {
    throw new Error(`port entry ${port.entry} requires a nonempty modules array`);
  }
  for (const module of entry.modules) insidePort(module, `entry module ${module}`);
  return { id: port.id, config: port.config || null, modules: entry.modules };
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
  if (manifest.modules !== undefined || manifest.extends !== undefined ||
      manifest.prepend !== undefined || manifest.append !== undefined ||
      manifest.portModules !== undefined || manifest.schema !== undefined ||
      manifest.engine !== undefined) {
    throw new Error(`manifest ${manifestPath} mixes capability keys with legacy module positioning keys`);
  }
  if (!gameArgument) throw new Error(`capability manifest ${manifestPath} requires --game`);
  const port = portFiles(manifest.port, manifestPath);
  const adaptersOption = manifest.adapters === undefined ? 'auto' : manifest.adapters;

  const registryPath = path.join(defaultRoot, 'profiles', 'plugin-adapters.json');
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
    ...adapterModules.map(mod => ({ module: mod, baseDir: defaultRoot })),
    ...port.modules.map(mod => ({ module: mod, baseDir: root })),
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
    port: port.id,
    portModuleCount: port.modules.length,
  };
  return [
    ...(port.config ? [{ module: port.config, baseDir: root }] : []),
    ...ordered,
  ];
}

if (profileArgument) {
  const { modules, baseDir } = loadProfile(profileArgument);
  rawModules = modules.map(mod => ({ module: mod, baseDir }));
} else if (manifestArgument) {
  const manifestPath = path.isAbsolute(manifestArgument)
    ? manifestArgument
    : insideRoot(manifestArgument, 'manifest');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.modules !== undefined) {
    if (!Array.isArray(manifest.modules) || !manifest.modules.length) {
      throw new Error('bundle manifest requires a non-empty modules array');
    }
    rawModules = manifest.modules.map(mod => ({ module: mod, baseDir: root }));
  } else {
    rawModules = resolveCapabilityManifest(manifest, manifestPath);
  }
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
  if (buildReport.port) {
    const count = buildReport.portModuleCount;
    lines.push(`[pmjs-build] port: ${buildReport.port} (${count} module${count === 1 ? '' : 's'})`);
  }
  const write = printModules ? console.error : console.log;
  write(lines.join('\n'));
}

const seenModules = new Set();
for (const item of rawModules) {
  if (seenModules.has(item.module)) {
    throw new Error(`duplicate module in profile/manifest: ${item.module}`);
  }
  seenModules.add(item.module);
}

const bundleItems = [];

if (configArgument) {
  const resolvedConfig = path.resolve(process.cwd(), configArgument);
  if (!fs.existsSync(resolvedConfig)) {
    console.error(`error: config file not found: ${resolvedConfig}`);
    process.exit(1);
  }
  const configText = fs.readFileSync(resolvedConfig, 'utf8');
  if (resolvedConfig.endsWith('.json')) {
    try {
      const parsed = JSON.parse(configText);
      assertDisableOptimizationsShape(parsed.disableOptimizations, resolvedConfig);
      const generated = `globalThis.PMJS_GAME_CONFIG = ${JSON.stringify(parsed, null, 2)};\n`;
      bundleItems.push({ label: path.basename(resolvedConfig), inlineSource: generated });
    } catch (e) {
      console.error(`error: invalid JSON in config file ${resolvedConfig}: ${e.message}`);
      process.exit(1);
    }
  } else {
    bundleItems.push({ label: path.basename(resolvedConfig), path: resolvedConfig });
  }
}

let compatInserted = false;
for (const item of rawModules) {
  if (compatArgument && !compatInserted &&
      (item.module === 'js/pmjs-mv/bootstrap.js' || item.module === 'js/pmjs-mz/bootstrap.js')) {
    const resolvedCompat = path.resolve(process.cwd(), compatArgument);
    if (!fs.existsSync(resolvedCompat)) {
      console.error(`error: compat file not found: ${resolvedCompat}`);
      process.exit(1);
    }
    bundleItems.push({ label: path.basename(resolvedCompat), path: resolvedCompat });
    compatInserted = true;
  }
  bundleItems.push({ label: item.module, module: item.module, baseDir: item.baseDir });
}

if (compatArgument && !compatInserted) {
  const resolvedCompat = path.resolve(process.cwd(), compatArgument);
  if (!fs.existsSync(resolvedCompat)) {
    console.error(`error: compat file not found: ${resolvedCompat}`);
    process.exit(1);
  }
  bundleItems.push({ label: path.basename(resolvedCompat), path: resolvedCompat });
}

function buildBundle() {
  return bundleItems.map(item => {
    let source;
    if (item.inlineSource) {
      source = item.inlineSource;
    } else if (item.path) {
      source = fs.readFileSync(item.path, 'utf8');
    } else {
      const relative = item.module;
      if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) ||
          relative.split(/[\\/]/).includes('..')) {
        throw new Error(`invalid bundle module: ${relative}`);
      }
      const fileResolved = path.resolve(item.baseDir, relative);
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
    base: item.baseDir === defaultRoot ? 'native-runtime' : 'root',
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
