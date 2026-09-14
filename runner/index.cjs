'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { performance } = require('node:perf_hooks');
const { createStorage } = require('./storage.cjs');

function resolveDefaults(input) {
  let title = input.title;
  let width = input.width;
  let height = input.height;

  if (input.config) {
    const configPath = path.resolve(input.config);
    if (!fs.existsSync(configPath)) {
      throw new Error(`config file not found: ${configPath}`);
    }
    let cfg;
    const configText = fs.readFileSync(configPath, 'utf8');
    if (configPath.endsWith('.json')) {
      try {
        cfg = JSON.parse(configText);
      } catch (err) {
        throw new Error(`invalid JSON in config file ${configPath}: ${err.message}`);
      }
    } else {
      const sandbox = { globalThis: {} };
      sandbox.window = sandbox.globalThis;
      try {
        vm.runInNewContext(configText, sandbox);
      } catch (err) {
        throw new Error(`error evaluating config file ${configPath}: ${err.message}`);
      }
      cfg = sandbox.globalThis.PMJS_GAME_CONFIG;
    }
    if (cfg) {
      if (title === undefined && cfg.title) title = cfg.title;
      if (width === undefined && cfg.display && cfg.display.width) width = Number(cfg.display.width);
      if (height === undefined && cfg.display && cfg.display.height) height = Number(cfg.display.height);
    }
  }

  if (input.gameRoot) {
    const pkgPath = path.join(path.resolve(input.gameRoot), 'package.json');
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
  if (title === undefined) title = 'pmjs native runtime';

  return { ...input, width, height, title };
}

function validate(input) {
  const options = resolveDefaults(input);
  const requiredPaths = ['addon', 'gameRoot', 'bootstrap', 'saveRoot'];
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
  return {
    ...options,
    addon: path.resolve(options.addon),
    gameRoot: path.resolve(options.gameRoot),
    bootstrap: path.resolve(options.bootstrap),
    saveRoot: path.resolve(options.saveRoot),
    assetRoot: options.assetRoot ? path.resolve(options.assetRoot) : '',
    ...(imageWarmCacheBytes === undefined ? {} : { imageWarmCacheBytes }),
    title: options.title,
  };
}

async function run(input, hooks = {}) {
  const options = validate(input);
  const native = options.native || require(options.addon);
  native.initialize({ gameRoot: options.gameRoot, assetRoot: options.assetRoot,
    width: options.width, height: options.height, windowTitle: options.title,
    ...(options.imageWarmCacheBytes === undefined ? {} :
      { imageWarmCacheBytes: options.imageWarmCacheBytes }) });
  native.storage = createStorage(options.saveRoot);
  native.runtime.now = () => performance.now();
  native.runtime.platform = () => ({ platform: process.platform, arch: process.arch });
  native.runtime.splitLines = value => String(value).split(/\r\n|\n|\r/);
  native.runtime.collectGarbage = typeof globalThis.gc === 'function'
    ? globalThis.gc.bind(globalThis) : () => {};
  native.runtime.loadScript = relative => {
    const source = native.fs.readText(relative);
    if (source === null) throw new Error(`cannot load script: ${relative}`);
    return vm.runInThisContext(source, { filename: path.join(options.gameRoot, relative) });
  };
  const hostProcess = process;
  const hostSetTimeout = globalThis.setTimeout.bind(globalThis);
  const hostClearTimeout = globalThis.clearTimeout.bind(globalThis);
  const hostSetImmediate = typeof globalThis.setImmediate === 'function'
    ? globalThis.setImmediate.bind(globalThis) : null;
  globalThis.NativeHost = { runtime: native.runtime, render: native.render,
    scene: native.scene, images: native.images, assets: native.assets, fs: native.fs,
    storage: native.storage, input: native.input, canvas: native.canvas, media: native.media };
  globalThis.__pmjsBuiltinRequire = require;
  globalThis.__pmjsNativeRuntime = true;
  try {
    vm.runInThisContext(fs.readFileSync(options.bootstrap, 'utf8'), {
      filename: options.bootstrap, displayErrors: true,
    });
    if (typeof globalThis.__pmjsTick !== 'function' ||
        typeof globalThis.__pmjsRender !== 'function') {
      throw new Error('bootstrap did not install __pmjsTick and __pmjsRender');
    }
    if (hooks.afterBootstrap !== undefined) {
      if (typeof hooks.afterBootstrap !== 'function') throw new Error('afterBootstrap must be a function');
      await hooks.afterBootstrap({ native, options });
    }
  } catch (error) {
    try { native.runtime.quit(); } catch (_) {}
    throw error;
  }

  const logicPeriod = 1000 / Number(hostProcess.env.PMJS_LOGIC_HZ || 60);
  const renderPeriod = 1000 / Number(hostProcess.env.PMJS_RENDER_HZ || 60);
  const period = Math.min(logicPeriod, renderPeriod);
  let deadline = native.runtime.monotonicNow() + period;
  console.log(`[pmjs] ready size=${options.width}x${options.height}`);
  return new Promise((resolve, reject) => {
    function schedule() {
      const delay = Math.max(0, deadline - native.runtime.monotonicNow());
      if (delay < 1 && hostSetImmediate) hostSetImmediate(tick);
      else hostSetTimeout(tick, delay);
    }
    function tick() {
      try {
        if (!native.pollEvents()) { resolve(); return; }
        const now = performance.now();
        native.beginFrame();
        globalThis.__pmjsTick(now);
        native.finishLogicStep();
        globalThis.__pmjsRender(now);
        native.renderFrame();
        if (typeof globalThis.__pmjsAfterNativeRender === 'function') {
          globalThis.__pmjsAfterNativeRender();
        }
        native.swapFrame();
        deadline += period;
        const monotonicNow = native.runtime.monotonicNow();
        if (deadline < monotonicNow - period) deadline = monotonicNow + period;
        schedule();
      } catch (error) {
        try { native.runtime.quit(); } catch (_) {}
        reject(error);
      }
    }
    schedule();
  });
}

module.exports = { run, validate };
