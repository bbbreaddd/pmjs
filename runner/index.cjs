'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { performance } = require('node:perf_hooks');
const { createStorage } = require('./storage.cjs');

function validate(options) {
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
    title: options.title || 'pmjs native runtime',
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

  const logicPeriod = 1000 / Number(process.env.PMJS_LOGIC_HZ || 60);
  const renderPeriod = 1000 / Number(process.env.PMJS_RENDER_HZ || 60);
  const period = Math.min(logicPeriod, renderPeriod);
  let deadline = native.runtime.monotonicNow() + period;
  console.log(`[pmjs] ready size=${options.width}x${options.height}`);
  return new Promise((resolve, reject) => {
    function schedule() {
      const delay = Math.max(0, deadline - native.runtime.monotonicNow());
      if (delay < 1) setImmediate(tick); else setTimeout(tick, delay);
    }
    function tick() {
      try {
        if (!native.pollEvents()) { resolve(); return; }
        globalThis.__pmjsTick(logicPeriod / 1000);
        native.finishLogicStep();
        native.beginFrame();
        globalThis.__pmjsRender(performance.now() / 1000);
        native.renderFrame();
        if (typeof globalThis.__pmjsAfterNativeRender === 'function') {
          globalThis.__pmjsAfterNativeRender();
        }
        native.swapFrame();
        deadline += period;
        const now = native.runtime.monotonicNow();
        if (deadline < now - period) deadline = now + period;
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
