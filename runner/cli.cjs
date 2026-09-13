#!/usr/bin/env node
'use strict';

const { run } = require('./index.cjs');

function parse(argv) {
  const result = {};
  const names = new Map([
    ['--addon', 'addon'], ['--game-root', 'gameRoot'], ['--bootstrap', 'bootstrap'],
    ['--save-root', 'saveRoot'], ['--asset-root', 'assetRoot'], ['--title', 'title'],
    ['--width', 'width'], ['--height', 'height'],
    ['--image-warm-cache-bytes', 'imageWarmCacheBytes'],
  ]);
  for (let index = 0; index < argv.length; index += 2) {
    const name = names.get(argv[index]);
    if (!name || index + 1 >= argv.length) throw new Error(`invalid argument: ${argv[index]}`);
    result[name] = argv[index + 1];
  }
  result.width = Number(result.width);
  result.height = Number(result.height);
  if (result.imageWarmCacheBytes !== undefined) {
    result.imageWarmCacheBytes = Number(result.imageWarmCacheBytes);
  }
  return result;
}

if (require.main === module) {
  run(parse(process.argv.slice(2))).catch(error => {
    console.error(error && error.stack || error);
    process.exitCode = 1;
  });
}

module.exports = { parse };
