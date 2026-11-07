'use strict';

const path = require('node:path');
const { packCache } = require('../runner/packed-cache.cjs');

if (process.argv.length !== 4) {
  console.error('usage: node tools/pack-prepared-cache.cjs ADDON PREPARATION_DIRECTORY');
  process.exitCode = 1;
} else {
  const native = require(path.resolve(process.argv[2]));
  packCache(process.argv[3], native.assets).then(result => console.log(JSON.stringify(result)))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
