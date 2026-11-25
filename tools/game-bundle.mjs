import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { preparationInputs } from './game-inspect.mjs';

const require = createRequire(import.meta.url);

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export function gameDeclarations(game, hash) {
  return Object.fromEntries(Object.entries(preparationInputs(game, null, null, [], hash)).map(([file, digest]) =>
    [path.relative(game, file).split(path.sep).join('/'), digest]));
}

function regularRelative(root, name) {
  if (typeof name !== 'string' || !name || path.isAbsolute(name) ||
      !name.split(/[\\/]/).every(part => part && part !== '.' && part !== '..')) {
    throw new Error(`invalid bundle path: ${name}`);
  }
  const file = path.join(root, name);
  const resolved = fs.realpathSync(file);
  if (!resolved.startsWith(root + path.sep)) throw new Error(`bundle path escapes its directory: ${name}`);
  if (!fs.statSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) {
    throw new Error(`bundle file must be a regular file: ${name}`);
  }
  return file;
}

export function readBundle(directory) {
  const root = fs.realpathSync(directory);
  const descriptor = JSON.parse(fs.readFileSync(path.join(root, 'pmjs.json'), 'utf8'));
  const patches = descriptor.patches ?? descriptor.adapters;
  if (descriptor.schema !== 1 || descriptor.kind !== 'pmjs-game-bundle' ||
      !Array.isArray(patches) || !patches.every(name => typeof name === 'string')) {
    throw new Error('unsupported PMJS bundle descriptor');
  }
  for (const name of [descriptor.bootstrap, descriptor.config, descriptor.manifest, ...patches]) {
    if (name) regularRelative(root, name);
  }
  const files = [descriptor.config, descriptor.manifest, ...patches].filter(Boolean);
  const bootstrapCurrent = descriptor.compositionFiles &&
    Object.keys(descriptor.compositionFiles).length === files.length &&
    files.every(name => descriptor.compositionFiles[name] === sha256(path.join(root, name)));
  if (descriptor.bootstrapSha256 !== sha256(path.join(root, descriptor.bootstrap))) {
    throw new Error('bundle bootstrap checksum differs from pmjs.json');
  }
  let assetIndex = null;
  if (descriptor.assetIndex && /^[a-zA-Z0-9_-]+\.json$/.test(descriptor.assetIndex)) {
    try {
      const candidate = regularRelative(root, descriptor.assetIndex);
      if (sha256(candidate) === descriptor.assetIndexSha256) assetIndex = candidate;
    } catch (_) {}
  }
  if (typeof descriptor.game !== 'string' || path.isAbsolute(descriptor.game) ||
      !descriptor.game.split(/[\\/]/).every(part => part && part !== '.' && part !== '..')) {
    throw new Error('invalid bundle game path');
  }
  return { root, descriptor, assetIndex, bootstrapCurrent,
    config: descriptor.config && path.join(root, descriptor.config),
    manifest: descriptor.manifest && path.join(root, descriptor.manifest),
    adapters: patches.map(name => path.join(root, name)) };
}

export async function createBundle({ root, share, game, output, config, manifest, adapters = [],
  runtimeIdentity, index = true, includeAssets = false, portProcessors = [], includePortAssets = false, cacheRoot }) {
  if (includeAssets && !index) throw new Error('--include-assets requires an asset index');
  output = path.resolve(output);
  if (fs.existsSync(output) && (fs.lstatSync(output).isSymbolicLink() ||
      !fs.statSync(output).isDirectory() || fs.readdirSync(output).length)) {
    throw new Error('bundle output must be an empty directory');
  }
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const stage = fs.mkdtempSync(path.join(path.dirname(output), `.${path.basename(output)}-stage-`));
  let published = false;
  let cancelled = false;
  const cancel = () => { cancelled = true; };
  process.on('SIGINT', cancel);
  process.on('SIGTERM', cancel);
  try {
    let title = path.basename(game);
    try {
      const system = JSON.parse(fs.readFileSync(path.join(game, 'data/System.json'), 'utf8'));
      if (typeof system.gameTitle === 'string' && system.gameTitle.trim()) title = system.gameTitle.trim();
    } catch (_) {}
    fs.mkdirSync(path.join(stage, 'gamedata'));
    const copy = (file, name) => {
      if (!file) return null;
      const target = path.join(stage, name);
      fs.copyFileSync(file, target, fs.constants.COPYFILE_EXCL);
      return name;
    };
    let configName = copy(config, 'config.json');
    if (configName) {
      const original = JSON.parse(fs.readFileSync(config, 'utf8'));
      if (original?.assetPreparation && typeof original.assetPreparation === 'object') {
        if (typeof original.assetPreparation.recipes === 'string') {
          const recipeFile = path.resolve(path.dirname(config), original.assetPreparation.recipes);
          copy(recipeFile, 'asset-recipes.json');
          original.assetPreparation.recipes = 'asset-recipes.json';
        }
        delete original.assetPreparation.cacheRoot;
        fs.writeFileSync(path.join(stage, configName), JSON.stringify(original, null, 2) + '\n');
      }
    } else {
      configName = 'config.json';
      fs.writeFileSync(path.join(stage, configName), JSON.stringify({ launchArguments: [] }, null, 2) + '\n');
    }
    const manifestName = copy(manifest, 'plugin-selection.json');
    fs.mkdirSync(path.join(stage, 'patches'));
    const usedNames = new Set();
    const patchNames = adapters.map(file => {
      const original = path.basename(file);
      if (!original || original.includes('\\')) throw new Error(`invalid patch filename: ${file}`);
      const extension = path.extname(original);
      const stem = original.slice(0, original.length - extension.length);
      let name = original;
      for (let suffix = 2; usedNames.has(name.toLowerCase()); ++suffix) {
        name = `${stem}-${suffix}${extension}`;
      }
      usedNames.add(name.toLowerCase());
      return copy(file, path.join('patches', name));
    });
    const bootstrap = 'bootstrap.js';
    const args = [path.join(share, 'tools/build-js-runtime.mjs'), '--game', game,
      '--output', path.join(stage, bootstrap)];
    if (configName) args.push('--config', path.join(stage, configName));
    if (manifestName) args.push('--manifest', path.join(stage, manifestName));
    for (const name of patchNames) args.push('--adapter', path.join(stage, name));
    const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`bootstrap generation failed (${result.signal || result.status})`);
    const { buildPortPreparation } = require(path.join(share, 'runner/port-preparation.cjs'));
    let addon = null;
    if (includePortAssets) {
      try { addon = require(path.join(root, 'lib/pmjs_native.node')); }
      catch (error) {
        console.warn(`[pmjs] Port assets not generated because the LZ4 codec is unavailable: ${error.message}`);
      }
    }
    const includePreparedPortAssets = includePortAssets &&
      typeof addon?.assets?.compressPortArtifact === 'function';
    const portPreparation = buildPortPreparation({ gameRoot: game, bundleRoot: stage,
      processors: portProcessors, adapters, include: includePreparedPortAssets,
      compressArtifact: addon?.assets?.compressPortArtifact });
    if (index || includePreparedPortAssets) {
      console.log('[pmjs] Preparing asset index; this may take a few minutes for a large game.');
      const { generateAssetIndex } = require(path.join(share, 'runner/asset-index.cjs'));
      const { resolveDefaults } = require(path.join(share, 'runner/config.cjs'));
      const indexConfig = configName && path.join(stage, configName);
      const options = resolveDefaults({ gameRoot: game, config: indexConfig });
      if (!index) options.assetPreparation.enabled = false;
      const report = await generateAssetIndex({ root, gameRoot: game, options,
        config: indexConfig, output: stage, includeAssets, portDescriptors: portPreparation,
        includePortAssets: includePreparedPortAssets, writeIndex: index,
        shouldCancel: () => cancelled, cacheRoot });
      console.log(`Asset index: ${report.preparedImages}/${report.images} images, ${report.maps} maps`);
      for (const warning of report.warnings) console.warn(warning);
      if (report.warningCount > report.warnings.length)
        console.warn(`[pmjs] ${report.warningCount - report.warnings.length} more preparation warnings`);
    }
    if (cancelled) throw new Error('bundle generation cancelled');
    const descriptor = { schema: 1, kind: 'pmjs-game-bundle', title, game: 'gamedata',
      bootstrap, bootstrapSha256: sha256(path.join(stage, bootstrap)),
      runtimeIdentity, bootstrapGameInputs: gameDeclarations(game),
      compositionFiles: Object.fromEntries([configName, manifestName, ...patchNames]
        .filter(Boolean).map(name => [name, sha256(path.join(stage, name))])),
      config: configName, manifest: manifestName, patches: patchNames,
      assetIndex: index ? 'asset-index.json' : null,
      assetIndexSha256: index ? sha256(path.join(stage, 'asset-index.json')) : null,
      assets: includeAssets ? 'assets' : null,
      ...(portPreparation.length ? { portPreparation } : {}) };
    fs.writeFileSync(path.join(stage, 'pmjs.json'), JSON.stringify(descriptor, null, 2) + '\n');
    if (fs.existsSync(output)) fs.rmdirSync(output);
    fs.renameSync(stage, output);
    published = true;
    return descriptor;
  } finally {
    process.off('SIGINT', cancel);
    process.off('SIGTERM', cancel);
    if (!published) fs.rmSync(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [game, output, config, manifest, ...adapters] = process.argv.slice(2);
  if (!game || !output) throw new Error('game and output are required');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  await createBundle({ root, share: root, game: path.resolve(game), output: path.resolve(output),
    config: config || undefined, manifest: manifest || undefined, adapters,
    runtimeIdentity: null, index: false });
}
