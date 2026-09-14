#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const check = args.includes('--check');

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

if (!outputArgument || (!manifestArgument && !profileArgument)) {
  console.error('usage: build-js-runtime.mjs [--root ROOT] (--profile NAME | --manifest FILE) --output FILE [--config FILE] [--compat FILE] [--check]');
  process.exit(2);
}

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = rootArgument ? path.resolve(process.cwd(), rootArgument) : defaultRoot;

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

let output;
if (profileArgument || path.isAbsolute(outputArgument)) {
  output = path.resolve(process.cwd(), outputArgument);
} else {
  output = insideRoot(outputArgument, 'output');
}

function findProfile(name) {
  const inRoot = path.resolve(root, 'profiles', `${name}.json`);
  if (fs.existsSync(inRoot)) return { profilePath: inRoot, baseDir: root };
  const inDefault = path.resolve(defaultRoot, 'profiles', `${name}.json`);
  if (fs.existsSync(inDefault)) return { profilePath: inDefault, baseDir: defaultRoot };
  return { profilePath: inRoot, baseDir: root };
}

let rawModules = [];

if (profileArgument) {
  const { profilePath, baseDir } = findProfile(profileArgument);
  if (!fs.existsSync(profilePath)) {
    console.error(`error: profile '${profileArgument}' not found at ${profilePath}`);
    process.exit(1);
  }
  const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
  if (!Array.isArray(profile.modules) || !profile.modules.length) {
    throw new Error(`profile '${profileArgument}' requires a non-empty modules array`);
  }
  rawModules = profile.modules.map(mod => ({ module: mod, baseDir }));
} else if (manifestArgument) {
  const manifestPath = path.isAbsolute(manifestArgument)
    ? manifestArgument
    : insideRoot(manifestArgument, 'manifest');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.extends) {
    const { profilePath, baseDir } = findProfile(manifest.extends);
    if (!fs.existsSync(profilePath)) {
      console.error(`error: extended profile '${manifest.extends}' not found at ${profilePath}`);
      process.exit(1);
    }
    const baseProfile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
    rawModules = [
      ...(manifest.prepend || []).map(mod => ({ module: mod, baseDir: root })),
      ...baseProfile.modules.map(mod => ({ module: mod, baseDir })),
      ...(manifest.append || []).map(mod => ({ module: mod, baseDir: root }))
    ];
  } else {
    if (!Array.isArray(manifest.modules) || !manifest.modules.length) {
      throw new Error('bundle manifest requires a non-empty modules array');
    }
    rawModules = manifest.modules.map(mod => ({ module: mod, baseDir: root }));
  }
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
  if (compatArgument && !compatInserted && item.module === 'js/pmjs-mv/bootstrap.js') {
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
if (check) {
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
}
