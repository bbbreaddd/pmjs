'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { temporaryDirectory } = require('./helpers/temp.cjs');
const directory = temporaryDirectory('program-binaries-');
const root = path.join(directory, 'cache');
function run(mode, target = root) {
  const result = spawnSync(process.argv[2], [target, mode, directory], { encoding: 'utf8', timeout: 60000 });
  assert.equal(result.status, 0, `${mode}: ${result.stdout}\n${result.stderr}`);
  console.log(mode, result.stdout.trim());
}
const files = () => fs.readdirSync(root).filter(name => name.endsWith('.bin'));
try {
  run('populate');
  const before = new Map(files().map(name => [name, fs.statSync(path.join(root, name)).mtimeMs]));
  run('hit');
  for (const [name, time] of before) assert.equal(fs.statSync(path.join(root, name)).mtimeMs, time,
    'cache hits must not rewrite binaries');
  run('changed'); run('hit');
  const names = files(), binaries = names.map(name => fs.readFileSync(path.join(root, name)));
  names.forEach((name, index) => fs.writeFileSync(path.join(root, name), binaries[(index + 1) % names.length]));
  run('populate'); run('hit');
  for (const name of files()) {
    const file = path.join(root, name), bytes = fs.readFileSync(file);
    bytes.fill(0, 48);
    crypto.createHash('sha256').update(name.slice(0, -4)).update(bytes.subarray(48)).digest().copy(bytes, 16);
    fs.writeFileSync(file, bytes);
  }
  run('populate'); run('hit');
  run('reject'); run('hit');
  run('driver'); run('recover'); run('hit');
  run('unsupported');
  for (const name of files()) {
    const file = path.join(root, name), bytes = fs.readFileSync(file);
    bytes[bytes.length - 1] ^= 1; fs.writeFileSync(file, bytes);
  }
  run('populate'); run('hit');
  for (const name of files()) {
    const file = path.join(root, name), bytes = fs.readFileSync(file);
    bytes.writeUInt32LE(0xffffffff, 8); fs.writeFileSync(file, bytes);
  }
  run('populate'); run('hit');
  const binary = fs.readFileSync(path.join(root, files()[0]));
  for (let i = 0; i < 70; ++i) {
    const file = path.join(root, i.toString(16).padStart(64, '0') + '.bin');
    fs.writeFileSync(file, binary); fs.utimesSync(file, 1, 1);
  }
  const oversized = path.join(root, 'f'.repeat(64) + '.bin');
  fs.writeFileSync(oversized, ''); fs.truncateSync(oversized, 17 * 1024 * 1024); fs.utimesSync(oversized, 1, 1);
  run('budget');
  assert(files().length <= 64);
  assert(files().reduce((sum, name) => sum + fs.statSync(path.join(root, name)).size, 0) <= 16 * 1024 * 1024);
  const blocked = path.join(directory, 'blocked'); fs.writeFileSync(blocked, 'not a directory');
  run('populate', blocked);
} finally { fs.rmSync(directory, { recursive: true, force: true }); }
