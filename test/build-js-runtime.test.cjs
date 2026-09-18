'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { temporaryDirectory } = require('./helpers/temp.cjs');

const tool = path.resolve(__dirname, '../tools/build-js-runtime.mjs');
test('bundle generation is deterministic and confined to the explicit root', () => {
  const root = temporaryDirectory('pmjs-bundle-');
  fs.writeFileSync(path.join(root, 'a.js'), 'one();\n');
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ modules: ['a.js'] }));
  const args = [tool, '--root', root, '--manifest', 'manifest.json', '--output', 'out.js'];
  childProcess.execFileSync(process.execPath, args);
  const first = fs.readFileSync(path.join(root, 'out.js'), 'utf8');
  childProcess.execFileSync(process.execPath, [...args, '--check']);
  assert.equal(fs.readFileSync(path.join(root, 'out.js'), 'utf8'), first);
  assert.throws(() => childProcess.execFileSync(process.execPath,
    [tool, '--root', root, '--manifest', 'manifest.json', '--output', '../escape.js']),
  /output must be inside root/);
});

test('bundle generation supports --profile with JSON --config and --compat', () => {
  const tempDir = temporaryDirectory('pmjs-profile-');
  const config = path.join(tempDir, 'config.json');
  const compat = path.join(tempDir, 'compat.js');
  const out = path.join(tempDir, 'out.js');
  fs.writeFileSync(config, JSON.stringify({ title: 'JSON Title', display: { width: 960, height: 540 } }));
  fs.writeFileSync(compat, 'globalThis.COMPAT_LOADED = true;\n');

  const args = [tool, '--profile', 'mv', '--config', config, '--compat', compat, '--output', out];
  childProcess.execFileSync(process.execPath, args);

  const bundleContent = fs.readFileSync(out, 'utf8');
  assert.match(bundleContent, /globalThis\.PMJS_GAME_CONFIG = \{/);
  assert.match(bundleContent, /"title": "JSON Title"/);
  assert.match(bundleContent, /\/\/ BEGIN compat\.js\nglobalThis\.COMPAT_LOADED = true;\n\/\/ END compat\.js/);

  const configIndex = bundleContent.indexOf('PMJS_GAME_CONFIG');
  const compatIndex = bundleContent.indexOf('COMPAT_LOADED');
  const bootstrapIndex = bundleContent.indexOf('BEGIN js/pmjs-mv/bootstrap.js');

  assert.ok(configIndex < compatIndex, 'config must precede compat');
  assert.ok(compatIndex < bootstrapIndex, 'compat must precede bootstrap');
});

test('bundle validates disableOptimizations shape and orders the registry first', () => {
  const tempDir = temporaryDirectory('pmjs-opt-config-');
  const good = path.join(tempDir, 'good.json');
  const out = path.join(tempDir, 'out.js');
  fs.writeFileSync(good, JSON.stringify({
    title: 'Opt Title',
    disableOptimizations: ['terrax.native-lighting'],
  }));
  childProcess.execFileSync(process.execPath,
    [tool, '--profile', 'mv', '--config', good, '--output', out]);
  const bundleContent = fs.readFileSync(out, 'utf8');
  const configIndex = bundleContent.indexOf('PMJS_GAME_CONFIG');
  const registryIndex = bundleContent.indexOf('BEGIN js/pmjs-core/optimizations.js');
  const setupIndex = bundleContent.indexOf('BEGIN js/pmjs-mv/setup.js');
  assert.ok(configIndex >= 0 && registryIndex > configIndex,
    'registry must follow the injected config');
  assert.ok(setupIndex > registryIndex, 'registry must precede consumers');

  // Structural validation only: unknown-but-well-formed IDs build fine here
  // and fail at runtime, where the registry is the single authority.
  const badValues = [[''], [42], ['a', 'a'], 'terrax.native-lighting', [null]];
  badValues.forEach((value, index) => {
    const bad = path.join(tempDir, `bad-${index}.json`);
    fs.writeFileSync(bad, JSON.stringify({ disableOptimizations: value }));
    assert.throws(() => childProcess.execFileSync(process.execPath,
      [tool, '--profile', 'mv', '--config', bad, '--output', out]),
    /disableOptimizations/);
  });
});

test('bundle generation rejects duplicate modules', () => {
  const root = path.resolve(__dirname, '..');
  const tempDir = temporaryDirectory('pmjs-dupe-');
  const manifest = path.join(tempDir, 'manifest.json');
  const out = path.join(tempDir, 'out.js');

  fs.writeFileSync(manifest, JSON.stringify({
    extends: 'mv',
    prepend: ['js/pmjs-core/operation-trace.js'] // already in mv.json!
  }));

  assert.throws(() => childProcess.execFileSync(process.execPath,
    [tool, '--root', root, '--manifest', manifest, '--output', out]),
  /duplicate module in profile\/manifest/);
});

test('manifest extends profile with custom modules', () => {
  const root = path.resolve(__dirname, '..');
  const tempDir = temporaryDirectory('pmjs-extends-');
  const manifest = path.join(tempDir, 'manifest.json');
  const out = path.join(tempDir, 'out.js');
  const customModule = path.join(root, 'custom-addon-temp.js');
  fs.writeFileSync(customModule, '// custom addon\n');

  fs.writeFileSync(manifest, JSON.stringify({
    extends: 'mv',
    prepend: ['custom-addon-temp.js']
  }));

  try {
    const args = [tool, '--root', root, '--manifest', manifest, '--output', out];
    childProcess.execFileSync(process.execPath, args);
    const bundleContent = fs.readFileSync(out, 'utf8');
    assert.match(bundleContent, /\/\/ BEGIN custom-addon-temp\.js/);
    assert.match(bundleContent, /\/\/ BEGIN js\/pmjs-mv\/bootstrap\.js/);
  } finally {
    fs.unlinkSync(customModule);
  }
});
