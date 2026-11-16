#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { preparationInputs, resolveGameDirectory as gameDirectory } from './game-inspect.mjs';
import { createBundle, gameDeclarations, readBundle } from './game-bundle.mjs';
import { startupFiles, runtimeIdentity as computeRuntimeIdentity } from '../runner/startup-files.cjs';
import { measureLauncherCheck } from '../runner/startup-metrics.cjs';
import { installConsoleLogging, startLauncherLog } from '../runner/logging.cjs';
import { formatLauncherIdentity, formatLauncherEnvironment } from '../runner/launcher-info.cjs';

const require = createRequire(import.meta.url);
const action = process.argv[3];
if (!['--build-info', '--help', 'help', 'self-test', 'bundle', 'package'].includes(action)) {
  installConsoleLogging();
  startLauncherLog();
  console.log(formatLauncherEnvironment());
}
const root = path.resolve(process.argv[2]);
const share = path.join(root, 'share/pmjs');
const info = JSON.parse(fs.readFileSync(path.join(root, 'build-info.json'), 'utf8'));
const args = process.argv.slice(3);
const guestDelimiter = args.indexOf('--');
const guestArguments = guestDelimiter < 0 ? [] : args.splice(guestDelimiter).slice(1);

const first = args.shift();
const buildInfo = `PMJS${info.buildId ? ` build=${info.buildId}` : ''} ` +
  `source=${info.source.dirty ? 'dirty' : info.source.commit.slice(0, 12)}`;
const help = `${buildInfo}
Usage:
  pmjs GAME [--config FILE] [--manifest FILE] [--patch FILE ...] [-- GAME_ARGUMENT ...]
  pmjs bundle GAME --output DIR [--include-assets | --no-index]
      [--config FILE] [--manifest FILE] [--patch FILE ...]
      [--include-port-assets] [--asset-cache-root DIR]
  pmjs BUNDLE [--game DIR]
  pmjs package BUNDLE --runtime DIR --output ZIP [--sources FILE --sources-url URL]
      [--submission DIR] [--layout testing|pr] [--no-image-compression]
  pmjs run --game DIR [--state DIR] [--save-root DIR] [--asset-cache-root DIR]
  pmjs prepare --game DIR [--state DIR] [--config FILE] [--manifest FILE]
  pmjs self-test [--graphics]
  pmjs --build-info
Game paths may contain a www/ directory. Prepared files use the user cache;
saves use the user data directory. Game JavaScript runs with Node capabilities.
Only run games you trust.`;

function invoke(file, arguments_) {
  const result = spawnSync(process.execPath, [file, ...arguments_], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`operation failed (${result.signal || result.status})`);
}

function parse(values, names, requireGame = true) {
  const result = { adapters: [], portPreparers: [] };
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    if (!names.includes(key) || (key !== '--adapter' && key !== '--patch' &&
        key !== '--port-preparer' && result[key]) ||
        !values[index + 1] || values[index + 1].startsWith('--')) {
      throw new Error(`invalid argument: ${key}`);
    }
    const value = path.resolve(values[index + 1]);
    if (key === '--adapter' || key === '--patch') result.adapters.push(value);
    else if (key === '--port-preparer') result.portPreparers.push(value);
    else result[key] = value;
  }
  if (requireGame && !result['--game']) throw new Error('--game is required');
  return result;
}

function hash(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

let verification;
const verifiedHash = file => verification ? verification.hash(file) : hash(file);
const runtimeIdentity = pass => measureLauncherCheck('runtime', pass, () =>
  computeRuntimeIdentity(share, verifiedHash), verification?.stats);
const gameInputs = (game, config, manifest, adapters, pass) => measureLauncherCheck('game-inputs', pass, () =>
  preparationInputs(game, config, manifest, adapters, verifiedHash), verification?.stats);


function matches(record, context) {
  try {
    return record.schema === 2 && record.game === context.game &&
      record.runtimeIdentity === context.runtimeIdentity &&
      record.config === context.config && record.manifest === context.manifest &&
      record.bundleBootstrapSha256 === context.bundleBootstrapSha256 &&
      JSON.stringify(record.adapters) === JSON.stringify(context.adapters) &&
      /^bootstrap-[a-f0-9]{64}\.js$/.test(record.bootstrap) &&
      verifiedHash(path.join(context.state, record.bootstrap)) === record.bootstrapSha256 &&
      JSON.stringify(record.inputs) === JSON.stringify(context.inputs);
  } catch { return false; }
}

function prepare(context) {
  fs.mkdirSync(context.state, { recursive: true });
  const temporary = path.join(context.state, `bootstrap-${process.pid}.tmp`);
  const buildArgs = ['--game', context.game, '--output', temporary];
  if (context.config) buildArgs.push('--config', context.config);
  if (context.manifest) buildArgs.push('--manifest', context.manifest);
  for (const adapter of context.adapters) buildArgs.push('--adapter', adapter);
  try {
    if (context.bundleBootstrap && context.bundleBootstrapCurrent &&
        context.bundleRuntimeIdentity === context.runtimeIdentity) {
      fs.copyFileSync(context.bundleBootstrap, temporary);
    } else {
      invoke(path.join(share, 'tools/build-js-runtime.mjs'), buildArgs);
    }
    if (JSON.stringify(context.inputs) !== JSON.stringify(gameInputs(context.game,
      context.config, context.manifest, context.adapters, 'bootstrap-integrity')) ||
      context.runtimeIdentity !== runtimeIdentity('bootstrap-integrity')) {
      throw new Error('preparation inputs changed during generation; retry');
    }
    const bootstrap = `bootstrap-${hash(temporary)}.js`;
    const target = path.join(context.state, bootstrap);
    fs.renameSync(temporary, target);
    const record = { schema: 2, game: context.game, packageSha256: context.packageSha256,
      runtimeIdentity: context.runtimeIdentity, config: context.config, manifest: context.manifest,
      adapters: context.adapters, inputs: context.inputs, bootstrap, bootstrapSha256: hash(target),
      bundleBootstrapSha256: context.bundleBootstrapSha256 };
    const next = path.join(context.state, `prepared.${process.pid}.tmp`);
    try {
      fs.writeFileSync(next, JSON.stringify(record, null, 2) + '\n');
      fs.renameSync(next, path.join(context.state, 'prepared.json'));
    } finally { fs.rmSync(next, { force: true }); }
    return record;
  } finally { fs.rmSync(temporary, { force: true }); }
}

async function main() {
  if (first === '--build-info') { console.log(buildInfo); return; }
  if (first === '--help' || first === 'help') { console.log(help); return; }
  if (first === 'self-test') {
    if (args.some(value => value !== '--graphics') || args.length > 1) throw new Error('invalid self-test arguments');
    invoke(path.join(share, 'tools/package-self-test.cjs'), [root, ...args]);
    return;
  }
  if (first === 'bundle') {
    const gameArgument = args.shift();
    if (!gameArgument || gameArgument.startsWith('--')) throw new Error('bundle requires a game directory');
    const includeAssets = args.includes('--include-assets');
    const includePortAssets = args.includes('--include-port-assets');
    const index = !args.includes('--no-index');
    if (args.filter(value => value === '--include-assets').length > 1 ||
        args.filter(value => value === '--include-port-assets').length > 1 ||
        args.filter(value => value === '--no-index').length > 1) throw new Error('duplicate bundle option');
    const options = parse(args.filter(value => !['--include-assets', '--include-port-assets', '--no-index'].includes(value)),
      ['--output', '--config', '--manifest', '--patch', '--adapter', '--port-preparer', '--asset-cache-root'], false);
    if (!options['--output']) throw new Error('--output is required');
    const game = gameDirectory(gameArgument);
    if (includeAssets) console.warn('[pmjs] Generated pages can contain game artwork. Share this bundle only when allowed.');
    if (includePortAssets) console.warn('[pmjs] Port-generated data may reproduce game content. Confirm redistribution rights.');
    await createBundle({ root, share, game, output: options['--output'], config: options['--config'],
      manifest: options['--manifest'], adapters: options.adapters, runtimeIdentity: runtimeIdentity('bundle-build'),
      index, includeAssets, portProcessors: options.portPreparers, includePortAssets,
      cacheRoot: options['--asset-cache-root'] });
    console.log(`Bundle created: ${options['--output']}`);
    return;
  }
  if (first === 'package') {
    const bundleArgument = args.shift();
    if (!bundleArgument || bundleArgument.startsWith('--')) throw new Error('package requires a bundle directory');
    if (!fs.existsSync(path.join(share, 'tools/portmaster.py'))) {
      throw new Error('Packaging requires a host installation; use tools/portmaster.py from the PMJS source checkout');
    }
    const sourceUrlAt = args.indexOf('--sources-url');
    const sourceUrl = sourceUrlAt < 0 ? undefined : args.splice(sourceUrlAt, 2)[1];
    if (sourceUrlAt >= 0 && !sourceUrl) throw new Error('--sources-url requires a URL');
    const layoutAt = args.indexOf('--layout');
    const layout = layoutAt < 0 ? undefined : args.splice(layoutAt, 2)[1];
    if (layoutAt >= 0 && !layout) throw new Error('--layout requires testing or pr');
    const compressImages = !args.includes('--no-image-compression');
    if (args.filter(value => value === '--no-image-compression').length > 1) throw new Error('duplicate package option');
    const options = parse(args.filter(value => value !== '--no-image-compression'),
      ['--runtime', '--output', '--sources', '--submission'], false);
    if (!options['--runtime'] || !options['--output']) throw new Error('package requires --runtime and --output');
    const result = spawnSync('python3', [path.join(share, 'tools/portmaster.py'),
      '--stage', options['--runtime'], '--bundle', path.resolve(bundleArgument), '--output', options['--output'],
      ...(options['--sources'] ? ['--sources', options['--sources']] : []),
      ...(options['--submission'] ? ['--submission', options['--submission']] : []),
      ...(layout ? ['--layout', layout] : []),
      ...(compressImages ? [] : ['--no-image-compression']),
      ...(sourceUrl ? ['--sources-url', sourceUrl] : [])],
    { stdio: 'inherit', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`packaging failed (${result.signal || result.status})`);
    return;
  }
  let command = first;
  let options;
  let bundle = null;
  if (first === 'prepare' || first === 'run') {
    options = parse(args, ['--game', '--state', '--save-root', '--asset-cache-root', '--config', '--manifest', '--patch', '--adapter']);
  } else if (!first || first.startsWith('--')) {
    if (first) throw new Error(`unknown command: ${first}`);
    if (fs.existsSync(path.join(process.cwd(), 'pmjs.json'))) bundle = readBundle(process.cwd());
    else {
      try { gameDirectory(process.cwd()); } catch { console.log(help); return; }
    }
    command = 'run';
    options = { '--game': bundle ? path.join(bundle.root, bundle.descriptor.game) : process.cwd(), adapters: [] };
  } else {
    command = 'run';
    options = parse(args, ['--state', '--save-root', '--asset-cache-root', '--game', '--config', '--manifest', '--patch', '--adapter'], false);
    if (fs.existsSync(path.join(path.resolve(first), 'pmjs.json'))) bundle = readBundle(first);
    if (!bundle || !options['--game']) options['--game'] = first;
  }
  if (bundle) {
    options['--game'] = options['--game'] === bundle.root ?
      path.join(bundle.root, bundle.descriptor.game) : options['--game'];
    options['--config'] = bundle.config;
    options['--manifest'] = bundle.manifest;
    options.adapters = bundle.adapters;
  }
  const buildInfoSha256 = hash(path.join(root, 'build-info.json'));
  console.log(formatLauncherIdentity(info, buildInfoSha256));
  const game = gameDirectory(options['--game']);
  const id = crypto.createHash('sha256').update(game).digest('hex').slice(0, 24);
  const state = options['--state'] || path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'pmjs', id);
  const saveRoot = options['--save-root'] || path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local/share'), 'pmjs', id, 'saves');
  const prepared = path.join(state, 'prepared.json');
  let previous;
  try { previous = JSON.parse(fs.readFileSync(prepared, 'utf8')); } catch { previous = null; }
  const config = options['--config'] || (command === 'run' && previous?.game === game ? previous.config : null);
  const manifest = options['--manifest'] || (command === 'run' && previous?.game === game ? previous.manifest : null);
  const adapters = options.adapters.length ? options.adapters :
    (command === 'run' && previous?.game === game && Array.isArray(previous.adapters) ? previous.adapters : []);
  verification = startupFiles(path.join(state, 'bootstrap-files.json'), buildInfoSha256,
    process.env.PMJS_VERIFY_BOOTSTRAP === '1' || command === 'prepare');
  const context = { game, state, packageSha256: buildInfoSha256,
    runtimeIdentity: runtimeIdentity('cache-lookup'), config, manifest, adapters,
    inputs: gameInputs(game, config, manifest, adapters, 'cache-lookup') };
  if (bundle) {
    context.bundleBootstrap = path.join(bundle.root, bundle.descriptor.bootstrap);
    context.bundleBootstrapSha256 = bundle.descriptor.bootstrapSha256;
    context.bundleRuntimeIdentity = bundle.descriptor.runtimeIdentity;
    context.bundleBootstrapCurrent = bundle.bootstrapCurrent &&
      JSON.stringify(bundle.descriptor.bootstrapGameInputs) === JSON.stringify(gameDeclarations(game, verifiedHash));
  }
  let record = command === 'prepare' || !previous || !matches(previous, context) ? prepare(context) : previous;
  verification.save();
  if (command === 'prepare') {
    const { prepareGameAssets } = require(path.join(share, 'runner/preparation.cjs'));
    const { offlineFilesystem } = require(path.join(share, 'runner/asset-index.cjs'));
    const { resolveDefaults } = require(path.join(share, 'runner/config.cjs'));
    const filesystem = offlineFilesystem(game, new Map());
    const addon = require(path.join(root, 'lib/pmjs_native.node'));
    const defaults = resolveDefaults({ gameRoot: game, config, assetCacheRoot: options['--asset-cache-root'] });
    const preparedIndex = require(path.join(share, 'runner/asset-index.cjs')).loadAssetIndex(bundle?.assetIndex, addon, defaults);
    await prepareGameAssets({ ...defaults.assetPreparation, gameRoot: game,
      cacheRoot: defaults.assetPreparation.cacheRoot || path.join(saveRoot, 'asset-cache'),
      native: { assets: Object.assign(Object.create(addon.assets), filesystem.assets), fs: filesystem.fs },
      width: defaults.width, height: defaults.height, images: defaults.assetPreparation.enabled,
      preparationContext: 'offline', bundleRoot: bundle?.root, portDescriptors: bundle?.descriptor.portPreparation,
      portableIndex: preparedIndex, portableAssetRoot: bundle?.root, adapters });
    console.log(`Prepared ${game}`); return;
  }
  const { runSupervised } = await import('../runner/supervisor.cjs');
  const result = await runSupervised(() => {

    context.inputs = gameInputs(game, config, manifest, adapters, 'prelaunch');
    context.runtimeIdentity = runtimeIdentity('prelaunch');
    if (bundle) context.bundleBootstrapCurrent = bundle.bootstrapCurrent &&
      JSON.stringify(bundle.descriptor.bootstrapGameInputs) === JSON.stringify(gameDeclarations(game, verifiedHash));
    if (!matches(record, context)) record = prepare(context);
    verification.save();
    return { addon: path.join(root, 'lib/pmjs_native.node'), gameRoot: game,
    bootstrap: path.join(state, record.bootstrap), saveRoot, config: record.config || undefined,
    assetIndex: bundle?.assetIndex || undefined, assetCacheRoot: options['--asset-cache-root'],
    bundleRoot: bundle?.root, portDescriptors: bundle?.descriptor.portPreparation, preparationAdapters: adapters, guestArguments };
  });
  if (result.signal) process.kill(process.pid, result.signal);
  else process.exitCode = result.code;
}

main().catch(error => {
  installConsoleLogging();
  console.error(`[pmjs] ${error.stack || error}`);
  process.exitCode = 1;
});
