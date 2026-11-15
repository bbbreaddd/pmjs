'use strict';

const path = require('node:path');
const { packCache } = require('../runner/packed-cache.cjs');

const args = process.argv.slice(2);
const verifyHashes = args[2] === '--verify-hashes';
if (args.length !== 2 && !(args.length === 3 && verifyHashes)) {
  console.error('usage: node tools/pack-prepared-cache.cjs ADDON PREPARATION_DIRECTORY [--verify-hashes]');
  process.exitCode = 1;
} else {
  const native = require(path.resolve(args[0]));
  packCache(args[1], native.assets, { verifyHashes }).then(result => console.log(JSON.stringify(result)))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
