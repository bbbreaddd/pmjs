'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { validRecipes, astcSettings, validLosslessPrefixes } = require('./asset-preparation.cjs');

function resolveDefaults(input) {
  let bitmapBackend = input.bitmapBackend;
  let title = input.title;
  let engineData = input.engineData;
  let battleTest = input.battleTest;
  let width = input.width;
  let height = input.height;
  let assetPreparation = {};
  let configAssetPreparation = {};
  let preparedFrameCacheBytes = input.preparedFrameCacheBytes;
  let preparedCompactSampling = input.preparedCompactSampling;
  let preparedCropUploads = input.preparedCropUploads;
  let preparationFonts = [];
  let virtualFiles = input.virtualFiles;
  let configDirectory = process.cwd();

  if (input.config) {
    const configPath = path.resolve(input.config);
    if (!fs.existsSync(configPath)) {
      throw new Error(`config file not found: ${configPath}`);
    }
    let cfg;
    try { cfg = JSON.parse(fs.readFileSync(configPath, 'utf8')); }
    catch (error) { throw new Error(`invalid JSON in config file ${configPath}: ${error.message}`); }
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error('configuration must be an object');
    if (battleTest === undefined && cfg.battleTest !== undefined) {
      if (typeof cfg.battleTest !== 'boolean') throw new Error('battleTest must be a boolean');
      battleTest = cfg.battleTest;
    }
    if (title === undefined && cfg.title) title = cfg.title;
    if (bitmapBackend === undefined) bitmapBackend = cfg.bitmapBackend;
    if (engineData === undefined && cfg.engineData !== undefined) {
      if (typeof cfg.engineData !== 'string' || !input.gameRoot) throw new Error('engineData requires a game root and relative file path');
      engineData = path.resolve(input.gameRoot, cfg.engineData);
    }
    if (width === undefined && cfg.display && cfg.display.width) width = Number(cfg.display.width);
    if (height === undefined && cfg.display && cfg.display.height) height = Number(cfg.display.height);
    if (cfg.fonts && typeof cfg.fonts === 'object') {
      preparationFonts = Object.values(cfg.fonts).flat().filter(font => typeof font === 'string');
    }
    assertDisableOptimizationsShape(cfg.disableOptimizations, configPath);
    if (virtualFiles === undefined) virtualFiles = cfg.virtualFiles;
    configDirectory = path.dirname(configPath);
    if (cfg.assetPreparation !== undefined) {
      assetPreparation = cfg.assetPreparation;
      configAssetPreparation = cfg.assetPreparation;
    }
    if (preparedFrameCacheBytes === undefined) preparedFrameCacheBytes = cfg.preparedFrameCacheBytes;
    if (preparedCompactSampling === undefined) preparedCompactSampling = cfg.preparedCompactSampling;
    if (preparedCropUploads === undefined) preparedCropUploads = cfg.preparedCropUploads;
  }

  if (input.gameRoot) {
    const rootPath = path.resolve(input.gameRoot);
    if (title === undefined) {
      const systemPath = path.join(rootPath, 'data', 'System.json');
      if (fs.existsSync(systemPath)) {
        try {
          const sys = JSON.parse(fs.readFileSync(systemPath, 'utf8'));
          if (sys && typeof sys.gameTitle === 'string' && sys.gameTitle.trim()) {
            title = sys.gameTitle.trim();
          }
        } catch (_) {}
      }
    }
    const pkgPath = path.join(rootPath, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        if (title === undefined && pkg.window && pkg.window.title) title = pkg.window.title;
        if (title === undefined && pkg.name) title = pkg.name;
        if (width === undefined && pkg.window && pkg.window.width) width = Number(pkg.window.width);
        if (height === undefined && pkg.window && pkg.window.height) height = Number(pkg.window.height);
      } catch (_) {}
    }
  }

  if (width === undefined) width = 816;
  if (height === undefined) height = 624;
  if (title === undefined) title = 'PMJS';

  if (!assetPreparation || typeof assetPreparation !== 'object' || Array.isArray(assetPreparation)) {
    throw new Error('assetPreparation must be an object');
  }
  const inputAssetPreparation = input.assetPreparation !== null && typeof input.assetPreparation === 'object' && !Array.isArray(input.assetPreparation)
    ? input.assetPreparation : {};
  const policyOverrides = {
    astc: Object.hasOwn(configAssetPreparation, 'astc') || Object.hasOwn(inputAssetPreparation, 'astc'),
    losslessPrefixes: Object.hasOwn(configAssetPreparation, 'losslessPrefixes') || Object.hasOwn(inputAssetPreparation, 'losslessPrefixes'),
    recipes: Object.hasOwn(configAssetPreparation, 'recipes') || Object.hasOwn(inputAssetPreparation, 'recipes') || input.assetRecipes !== undefined
  };
  assetPreparation = { enabled: true, maps: true, verifyHashes: false, pageCodec: 'lz4', workspaceBytes: 256 * 1024 * 1024, ...assetPreparation,
    ...inputAssetPreparation };
  if (input.assetPreparation === 'on' || input.assetPreparation === 'off') {
    assetPreparation.enabled = input.assetPreparation === 'on';
  } else if (input.assetPreparation !== undefined && typeof input.assetPreparation !== 'object') {
    throw new Error('assetPreparation must be on or off');
  }
  if (input.mapPreparation !== undefined) {
    if (!['on', 'off'].includes(input.mapPreparation)) throw new Error('mapPreparation must be on or off');
    assetPreparation.maps = input.mapPreparation === 'on';
  }
  if (typeof assetPreparation.maps !== 'boolean') throw new Error('assetPreparation.maps must be a boolean');
  if (!['png', 'lz4'].includes(assetPreparation.pageCodec)) throw new Error('assetPreparation.pageCodec must be png or lz4');
  if (typeof assetPreparation.verifyHashes !== 'boolean') throw new Error('assetPreparation.verifyHashes must be a boolean');
  if (!Number.isSafeInteger(assetPreparation.workspaceBytes) || assetPreparation.workspaceBytes < 0 ||
      assetPreparation.workspaceBytes > 256 * 1024 * 1024)
    throw new Error('assetPreparation.workspaceBytes must be an integer from 0 to 268435456');
  assetPreparation.losslessPrefixes = validLosslessPrefixes(assetPreparation.losslessPrefixes);
  assetPreparation.astc = astcSettings(assetPreparation.astc);
  if (!assetPreparation.enabled) assetPreparation.maps = false;
  if (input.assetCacheRoot !== undefined) assetPreparation.cacheRoot = path.resolve(input.assetCacheRoot);
  else if (assetPreparation.cacheRoot !== undefined) {
    assetPreparation.cacheRoot = path.resolve(configDirectory, assetPreparation.cacheRoot);
  }
  if (input.assetRecipes !== undefined) assetPreparation.recipes = path.resolve(input.assetRecipes);
  else if (typeof assetPreparation.recipes === 'string') {
    assetPreparation.recipes = path.resolve(configDirectory, assetPreparation.recipes);
  }
  if (typeof assetPreparation.enabled !== 'boolean') throw new Error('assetPreparation.enabled must be a boolean');
  if (typeof assetPreparation.recipes === 'string') {
    assetPreparation.recipes = JSON.parse(fs.readFileSync(assetPreparation.recipes, 'utf8'));
  }
  assetPreparation.recipes = validRecipes(assetPreparation.recipes || []);
  return { ...input, bitmapBackend, engineData, battleTest, width, height, title, assetPreparation, assetPolicyOverrides: policyOverrides, preparationFonts, virtualFiles,
    preparedFrameCacheBytes, preparedCompactSampling, preparedCropUploads };
}

function validate(input) {
  const options = resolveDefaults(input);
  if (options.bitmapBackend !== undefined && !['javascript', 'native'].includes(options.bitmapBackend)) throw new Error('bitmapBackend must be javascript or native');
  const requiredPaths = ['addon', 'gameRoot', 'saveRoot', ...(options.engine === 'native-mv' ? [] : ['bootstrap'])];
  for (const name of requiredPaths) {
    if (typeof options[name] !== 'string' || !options[name]) {
      throw new Error(`${name} is required`);
    }
  }
  for (const name of ['width', 'height']) {
    if (!Number.isInteger(options[name]) || options[name] < 1 || options[name] > 16384) {
      throw new Error(`${name} must be an integer between 1 and 16384`);
    }
  }
  const configuredWarmBytes = options.imageWarmCacheBytes ??
    process.env.PMJS_IMAGE_WARM_CACHE_BYTES;
  const imageWarmCacheBytes = configuredWarmBytes === undefined ? undefined :
    Number(configuredWarmBytes);
  if (imageWarmCacheBytes !== undefined &&
      (!Number.isSafeInteger(imageWarmCacheBytes) || imageWarmCacheBytes < 0)) {
    throw new Error('imageWarmCacheBytes must be a non-negative safe integer');
  }
  const configuredFrameBytes = options.preparedFrameCacheBytes === undefined ?
    process.env.PMJS_PREPARED_FRAME_CACHE_BYTES : options.preparedFrameCacheBytes;
  const preparedFrameCacheBytes = configuredFrameBytes === undefined ? 32 * 1024 * 1024 :
    Number(configuredFrameBytes);
  if ((configuredFrameBytes !== undefined &&
       typeof configuredFrameBytes !== 'number' && typeof configuredFrameBytes !== 'string') ||
      !Number.isSafeInteger(preparedFrameCacheBytes) || preparedFrameCacheBytes < 0) {
    throw new Error('preparedFrameCacheBytes must be a non-negative safe integer');
  }
  for (const name of ['preparedCompactSampling', 'preparedCropUploads']) {
    if (options[name] !== undefined && typeof options[name] !== 'boolean') {
      throw new Error(`${name} must be a boolean`);
    }
  }
  if (options.greenworksModule !== undefined &&
      (typeof options.greenworksModule !== 'string' || !options.greenworksModule)) {
    throw new Error('greenworksModule must be a nonempty host module path');
  }
  return {
    ...options,
    ...(options.greenworksModule === undefined ? {} :
      { greenworksModule: path.resolve(options.greenworksModule) }),
    addon: path.resolve(options.addon),
    gameRoot: path.resolve(options.gameRoot),
    ...(options.bootstrap ? { bootstrap: path.resolve(options.bootstrap) } : {}),
    saveRoot: path.resolve(options.saveRoot),
    assetRoot: options.assetRoot ? path.resolve(options.assetRoot) : '',
    assetPreparation: { ...options.assetPreparation,
      cacheRoot: options.assetPreparation.cacheRoot || path.join(path.resolve(options.saveRoot), 'asset-cache') },
    ...(imageWarmCacheBytes === undefined ? {} : { imageWarmCacheBytes }),
    preparedFrameCacheBytes,
    preparedCompactSampling: options.preparedCompactSampling ?? true,
    preparedCropUploads: options.preparedCropUploads ?? true,
    title: options.title,
  };
}


function assertDisableOptimizationsShape(value, configPath) {
  if (value === undefined) return;
  const ok = Array.isArray(value) && value.every(id => typeof id === 'string' && id) &&
    new Set(value).size === value.length;
  if (!ok) {
    throw new Error(`disableOptimizations in ${configPath} must be an array of unique nonempty strings`);
  }
}

const PMJS_MV_LOGIC_HZ = 60;
const PMJS_SUPPORTED_RENDER_HZ = [30, 60, 120];

function parseTimingConfig(env) {
  const source = env || {};
  if (source.PMJS_LOGIC_HZ !== undefined && source.PMJS_LOGIC_HZ !== '' &&
      Number(source.PMJS_LOGIC_HZ) !== PMJS_MV_LOGIC_HZ) {
    throw new Error(
      `PMJS_LOGIC_HZ must be ${PMJS_MV_LOGIC_HZ} ` +
      `(MV simulation is fixed at the authored rate): ${source.PMJS_LOGIC_HZ}`);
  }
  const rawCatchup = source.PMJS_CATCHUP_MODE;
  let catchupMode = 'burst';
  if (rawCatchup !== undefined && rawCatchup !== '') {
    if (rawCatchup !== 'smooth' && rawCatchup !== 'burst') {
      throw new Error(`PMJS_CATCHUP_MODE must be 'smooth' or 'burst': ${rawCatchup}`);
    }
    catchupMode = rawCatchup;
  }
  const uncappedFlag = source.PMJS_UNCAPPED === '1';
  const raw = source.PMJS_RENDER_HZ;
  if (raw === undefined || raw === '') {
    if (uncappedFlag) return { logicHz: PMJS_MV_LOGIC_HZ, renderHz: 0, uncapped: true, renderPeriod: Infinity, catchupMode };
    return { logicHz: PMJS_MV_LOGIC_HZ, renderHz: 60, uncapped: false,
      renderPeriod: 1000 / 60, catchupMode };
  }
  const renderHz = Number(raw);
  if (renderHz === 0) {
    return { logicHz: PMJS_MV_LOGIC_HZ, renderHz: 0, uncapped: true,
      renderPeriod: Infinity, catchupMode };
  }
  if (!PMJS_SUPPORTED_RENDER_HZ.includes(renderHz)) {
    throw new Error(
      `PMJS_RENDER_HZ must be one of 0 (uncapped), ` +
      `${PMJS_SUPPORTED_RENDER_HZ.join(', ')}: ${raw}`);
  }
  if (uncappedFlag) {
    return { logicHz: PMJS_MV_LOGIC_HZ, renderHz: 0, uncapped: true,
      renderPeriod: Infinity, catchupMode };
  }
  return { logicHz: PMJS_MV_LOGIC_HZ, renderHz, uncapped: false,
    renderPeriod: 1000 / renderHz, catchupMode };
}

function resolveSwapDefault(env, timing) {
  const source = env || {};
  if (timing.uncapped && (source.PMJS_SWAP_INTERVAL === undefined ||
      source.PMJS_SWAP_INTERVAL === '')) {
    return '0';
  }
  return null;
}

module.exports = { resolveDefaults, validate, PMJS_MV_LOGIC_HZ,
  PMJS_SUPPORTED_RENDER_HZ, parseTimingConfig, resolveSwapDefault };
