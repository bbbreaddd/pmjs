#!/usr/bin/env node
'use strict';

const { runSupervised } = require('./supervisor.cjs');

function parse(argv) {
  const result = {};
  const names = new Map([
    ['--engine', 'engine'], ['--engine-data', 'engineData'],
    ['--addon', 'addon'], ['--game-root', 'gameRoot'], ['--bootstrap', 'bootstrap'],
    ['--save-root', 'saveRoot'], ['--asset-root', 'assetRoot'], ['--title', 'title'],
    ['--width', 'width'], ['--height', 'height'],
    ['--config', 'config'],
    ['--greenworks-module', 'greenworksModule'],
    ['--image-warm-cache-bytes', 'imageWarmCacheBytes'],
    ['--prepared-frame-cache-bytes', 'preparedFrameCacheBytes'],
    ['--asset-preparation', 'assetPreparation'], ['--asset-cache-root', 'assetCacheRoot'],
    ['--asset-recipes', 'assetRecipes'], ['--map-preparation', 'mapPreparation'],
  ]);
  for (let index = 0; index < argv.length; index += 2) {
    if (argv[index] === '--') { result.guestArguments = argv.slice(index + 1); break; }
    const name = names.get(argv[index]);
    if (!name || index + 1 >= argv.length) throw new Error(`invalid argument: ${argv[index]}`);
    result[name] = argv[index + 1];
  }
  if (result.width !== undefined) result.width = Number(result.width);
  if (result.height !== undefined) result.height = Number(result.height);
  if (result.imageWarmCacheBytes !== undefined) {
    result.imageWarmCacheBytes = Number(result.imageWarmCacheBytes);
  }
  if (result.preparedFrameCacheBytes !== undefined) {
    result.preparedFrameCacheBytes = Number(result.preparedFrameCacheBytes);
  }
  return result;
}

if (require.main === module) {
  require('./logging.cjs').installConsoleLogging();
  Promise.resolve().then(() => runSupervised(parse(process.argv.slice(2)))).then(result => {
    if (result.signal) process.kill(process.pid, result.signal);
    else process.exitCode = result.code;
  }).catch(error => {
    console.error(error && error.stack || error);
    process.exitCode = 1;
  });
}

module.exports = { parse };
