'use strict';

const path = require('node:path');
const { packCache } = require('../runner/packed-cache.cjs');

const args = process.argv.slice(2);
const flags = new Set(args.slice(2));
if (args.length < 2 || flags.size !== args.length - 2 ||
    [...flags].some(flag => flag !== '--verify-hashes' && flag !== '--compact')) {
  console.error('usage: node tools/pack-prepared-cache.cjs ADDON PREPARATION_DIRECTORY [--verify-hashes] [--compact]');
  process.exitCode = 1;
} else {
  const native = require(path.resolve(args[0]));
  packCache(args[1], native.assets, { verifyHashes: flags.has('--verify-hashes'), compact: flags.has('--compact') }).then(result => console.log(JSON.stringify(result)))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
