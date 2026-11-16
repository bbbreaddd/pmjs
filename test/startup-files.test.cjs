'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { temporaryDirectory } = require('./helpers/temp.cjs');
const { startupFiles, runtimeIdentity } = require('../runner/startup-files.cjs');

test('startup receipts reuse unchanged bytes and rehash edits, replacements, upgrades and explicit verification', () => {
  const root = temporaryDirectory('startup-files-'), file = path.join(root, 'input');
  const receipt = path.join(root, 'receipt.json');
  fs.writeFileSync(file, 'first');
  const cold = startupFiles(receipt, 'generation');
  const first = cold.hash(file); cold.save();
  assert.equal(cold.stats.hashedBytes, 5);
  const warm = startupFiles(receipt, 'generation');
  assert.equal(warm.hash(file), first);
  assert.equal(warm.stats.hashedBytes, 0);
  const before = fs.statSync(file);
  fs.writeFileSync(file, 'other'); fs.utimesSync(file, before.atime, before.mtime);
  assert.notEqual(warm.hash(file), first, 'ctime invalidates restored mtime');
  fs.writeFileSync(file + '.new', 'third'); fs.renameSync(file + '.new', file);
  const third = warm.hash(file); warm.save();
  assert.notEqual(third, first);
  for (const [generation, verify] of [['upgrade', false], ['generation', true]]) {
    const checked = startupFiles(receipt, generation, verify);
    assert.equal(checked.hash(file), third); assert.equal(checked.stats.hashedBytes, 5);
  }
  fs.writeFileSync(receipt, '{');
  const repaired = startupFiles(receipt, 'generation');
  assert.equal(repaired.hash(file), third); assert.equal(repaired.stats.hashedBytes, 5);
});

test('runtime identity notices added and removed files while warm content reads remain zero', () => {
  const root = temporaryDirectory('runtime-identity-');
  for (const directory of ['js', 'profiles', 'tools', 'runner']) fs.mkdirSync(path.join(root, directory));
  for (const file of ['js/base.js', 'profiles/base.json', 'tools/build-js-runtime.mjs',
    'tools/build-js-composition.mjs',
    'tools/game-inspect.mjs', 'tools/achievement-discovery.mjs', 'runner/plugin-manifest.cjs']) fs.writeFileSync(path.join(root, file), file);
  const receipt = path.join(root, 'receipt.json'), cold = startupFiles(receipt, 'build');
  const original = runtimeIdentity(root, cold.hash); cold.save();
  const warm = startupFiles(receipt, 'build');
  assert.equal(runtimeIdentity(root, warm.hash), original);
  assert.equal(warm.stats.hashedBytes, 0);
  fs.writeFileSync(path.join(root, 'js/added.js'), 'new');
  assert.notEqual(runtimeIdentity(root, warm.hash), original);
  fs.unlinkSync(path.join(root, 'js/added.js'));
  assert.equal(runtimeIdentity(root, warm.hash), original);
});

test('startup verification rejects mutation of an opened input', t => {
  const root = temporaryDirectory('startup-mutation-'), file = path.join(root, 'input');
  fs.writeFileSync(file, Buffer.alloc(512 * 1024));
  const read = fs.readSync;
  let changed = false;
  t.mock.method(fs, 'readSync', (...args) => {
    const count = read(...args);
    if (!changed) { changed = true; fs.appendFileSync(file, 'changed'); }
    return count;
  });
  const checked = startupFiles(path.join(root, 'receipt.json'), 'build');
  assert.throws(() => checked.hash(file), /changed while hashing/);
});

test('composition identity follows plugin parser changes and ignores documentation edits', () => {
  const crypto = require('node:crypto');
  const { spawnSync } = require('node:child_process');
  const root = temporaryDirectory('composition-identity-'), share = path.join(root, 'runtime');
  fs.mkdirSync(share);
  for (const directory of ['js', 'profiles']) fs.cpSync(path.join(__dirname, '..', directory), path.join(share, directory), { recursive: true });
  for (const directory of ['tools', 'runner']) fs.mkdirSync(path.join(share, directory));
  for (const name of ['build-js-runtime.mjs', 'build-js-composition.mjs', 'game-inspect.mjs', 'achievement-discovery.mjs']) {
    fs.copyFileSync(path.join(__dirname, '../tools', name), path.join(share, 'tools', name));
  }
  const parser = path.join(share, 'runner/plugin-manifest.cjs');
  fs.copyFileSync(path.join(__dirname, '../runner/plugin-manifest.cjs'), parser);
  fs.copyFileSync(path.join(__dirname, '../runner/file-overrides.cjs'), path.join(share, 'runner/file-overrides.cjs'));
  const game = path.join(root, 'game');
  fs.mkdirSync(path.join(game, 'js/libs'), { recursive: true });
  fs.writeFileSync(path.join(game, 'js/libs/pixi.js'), 'PIXI.VERSION = "4.5.4";');
  fs.writeFileSync(path.join(game, 'js/libs/pixi-tilemap.js'), '');
  for (const [name, text] of Object.entries({ 'rpg_core.js': 'Utils.RPGMAKER_VERSION = "1.6.2";',
    'rpg_managers.js': '', 'plugins.js': 'var $plugins = [];' })) fs.writeFileSync(path.join(game, 'js', name), text);
  const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const build = () => {
    const output = path.join(root, 'bootstrap.js');
    const result = spawnSync(process.execPath, [path.join(share, 'tools/build-js-runtime.mjs'), '--game', game, '--output', output], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return hash(output);
  };
  const originalIdentity = runtimeIdentity(share, hash), originalBundle = build();
  fs.writeFileSync(path.join(share, 'README.md'), 'Changed documentation');
  assert.equal(runtimeIdentity(share, hash), originalIdentity);
  assert.equal(build(), originalBundle);
  fs.writeFileSync(parser, 'module.exports = { parsePluginManifest() { return { plugins: [{ name: "YEP_CoreEngine", status: true, parameters: {} }] }; } };');
  assert.notEqual(build(), originalBundle, 'parser changes affect the actual composed bootstrap');
  assert.notEqual(runtimeIdentity(share, hash), originalIdentity, 'changed composition must invalidate bootstrap reuse');
});
