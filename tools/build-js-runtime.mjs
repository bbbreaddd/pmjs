#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareGameConfig } from './game-inspect.mjs';
import { insertExplicitAdapters, loadProfile, resolveCapabilityManifest, supportedEngines } from './build-js-composition.mjs';

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

if (profileArgument) {
  const { modules, baseDir } = loadProfile(root, profileArgument);
  rawModules = modules.map(module => ({ module, baseDir }));
} else {
  let manifest = {};
  let manifestPath = '<command line>';
  if (manifestArgument) {
    manifestPath = path.resolve(manifestArgument);
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  }
  const composition = resolveCapabilityManifest({
    root,
    gameDir: gameArgument && path.resolve(process.cwd(), gameArgument),
    manifest,
    manifestPath,
  });
  rawModules = composition.modules;
  buildReport = composition.buildReport;
  detectedRuntime = composition.detectedRuntime;
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

rawModules = insertExplicitAdapters(rawModules, adapterFiles);

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
const runtimeEngine = detectedRuntime?.engine || (rawModules.some(item => item.module.startsWith('js/pmjs-mz/')) ? 'mz' :
  rawModules.some(item => item.module.startsWith('js/pmjs-mv/')) ? 'mv' : null);
if (runtimeEngine) bundleItems.push({ label: 'runtime-engine', inlineSource:
  `globalThis.PMJS_RUNTIME_ENGINE = ${JSON.stringify(runtimeEngine)};\n` });

if (detectedRuntime) {
  bundleItems.push({ label: 'detected-game', inlineSource:
    `globalThis.PMJS_RUNTIME_GAME = ${JSON.stringify(detectedRuntime)};\n` });
}

let parsedConfig = {};
let configLabel = 'game-config';
if (configArgument) {
  const resolvedConfig = path.resolve(process.cwd(), configArgument);
  if (!fs.existsSync(resolvedConfig)) {
    console.error(`error: config file not found: ${resolvedConfig}`);
    process.exit(1);
  }
  try { parsedConfig = JSON.parse(fs.readFileSync(resolvedConfig, 'utf8')); }
  catch (error) { throw new Error(`invalid JSON in config file ${resolvedConfig}: ${error.message}`); }
  if (!parsedConfig || typeof parsedConfig !== 'object' || Array.isArray(parsedConfig)) throw new Error('configuration must be an object');
  assertDisableOptimizationsShape(parsedConfig.disableOptimizations, resolvedConfig);
  configLabel = path.basename(resolvedConfig);
}
if (gameArgument) parsedConfig = prepareGameConfig(path.resolve(gameArgument), parsedConfig);
if (configArgument || Object.keys(parsedConfig).length) {
  bundleItems.push({ label: configLabel, inlineSource:
    `globalThis.PMJS_GAME_CONFIG = ${JSON.stringify(parsedConfig, null, 2)};\n` });
}
for (const item of rawModules) {
  bundleItems.push({ label: item.module, module: item.module, file: item.file, baseDir: root });
}

const VLQ_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function encodeVlq(value) {
  let vlq = value < 0 ? ((-value) << 1) | 1 : value << 1;
  let encoded = '';
  do {
    let digit = vlq & 31;
    vlq >>>= 5;
    if (vlq > 0) digit |= 32;
    encoded += VLQ_CHARS[digit];
  } while (vlq > 0);
  return encoded;
}

function writeAtomic(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(temporary, content, { flag: 'wx' });
    fs.renameSync(temporary, filePath);
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

function buildBundle(outputFile) {
  const sources = [];
  const mappingLines = [];
  const chunks = [];
  let prevSource = 0;
  let prevOrigLine = 0;

  for (let index = 0; index < bundleItems.length; index++) {
    const item = bundleItems[index];
    let source;
    if (item.inlineSource) {
      source = item.inlineSource;
    } else if (item.file) {
      source = fs.readFileSync(item.file, 'utf8');
    } else {
      const fileResolved = path.resolve(item.baseDir, item.module);
      source = fs.readFileSync(fileResolved, 'utf8');
    }
    const trimmed = source.trimEnd();
    const lines = trimmed.split('\n');
    chunks.push(`// BEGIN ${item.label}\n${trimmed}\n// END ${item.label}\n`);
    mappingLines.push(''); // // BEGIN ...
    if (item.inlineSource) {
      for (let line = 0; line < lines.length; line++) mappingLines.push('');
    } else {
      const sourceIndex = sources.length;
      sources.push(item.label);
      for (let line = 0; line < lines.length; line++) {
        const segment = encodeVlq(0) +
          encodeVlq(sourceIndex - prevSource) +
          encodeVlq(line - prevOrigLine) +
          encodeVlq(0);
        prevSource = sourceIndex;
        prevOrigLine = line;
        mappingLines.push(segment);
      }
    }
    mappingLines.push(''); // // END ...
    if (index < bundleItems.length - 1) mappingLines.push(''); // join('\n') blank line
  }

  let code = chunks.join('\n');
  const mapFile = outputFile ? `${path.basename(outputFile)}.map` : null;
  if (mapFile) {
    code += `\n//# sourceMappingURL=${mapFile}\n`;
    mappingLines.push('', '');
  }
  const sourceMap = {
    version: 3,
    file: outputFile ? path.basename(outputFile) : 'core-bootstrap.js',
    sources,
    names: [],
    mappings: mappingLines.join(';'),
  };
  return { code, sourceMap };
}

const { code: bundle, sourceMap } = buildBundle(output);
const mapOutput = output ? `${output}.map` : null;
const mapContent = JSON.stringify(sourceMap) + '\n';
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
  const currentMap = fs.existsSync(mapOutput) ? fs.readFileSync(mapOutput, 'utf8') : '';
  if (current !== bundle || currentMap !== mapContent) {
    console.error(`${path.relative(root, output)} is out of date`);
    process.exitCode = 1;
  }
} else if (fs.existsSync(output) && fs.readFileSync(output, 'utf8') === bundle &&
    fs.existsSync(mapOutput) && fs.readFileSync(mapOutput, 'utf8') === mapContent) {
  console.log(`unchanged ${path.relative(process.cwd(), output)}`);
} else {
  writeAtomic(output, bundle);
  writeAtomic(mapOutput, mapContent);
  console.log(`generated ${path.relative(process.cwd(), output)} from ${bundleItems.length} modules`);
  printBuildReport();
}
