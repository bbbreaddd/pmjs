'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { temporaryDirectory } = require('./helpers/temp.cjs');

const tool = path.resolve(__dirname, '../tools/build-js-runtime.mjs');

function writeMvGame(root, { pixiVersion = '4.8.9', plugins = [] } = {}) {
  const game = path.join(root, 'game');
  fs.mkdirSync(path.join(game, 'js', 'libs'), { recursive: true });
  fs.writeFileSync(path.join(game, 'js', 'rpg_core.js'), '// RPG Maker MV v1.6.1\n');
  fs.writeFileSync(path.join(game, 'js', 'rpg_managers.js'), '// managers\n');
  fs.writeFileSync(path.join(game, 'js', 'libs', 'pixi.js'),
    `PIXI.VERSION = '${pixiVersion}';\n`);
  fs.writeFileSync(path.join(game, 'js', 'plugins.js'),
    `var $plugins = ${JSON.stringify(plugins)};\n`);
  return game;
}
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

test('capability manifest composes config, base, detected adapters, port entry, and bootstrap', () => {
  const root = temporaryDirectory('pmjs-capability-');
  fs.mkdirSync(path.join(root, 'ports', 'demo', 'port', 'native'), { recursive: true });
  fs.writeFileSync(path.join(root, 'ports', 'demo', 'port', 'native', 'config.js'),
    'globalThis.PMJS_GAME_CONFIG = { title: "Demo" };\n');
  fs.writeFileSync(path.join(root, 'ports', 'demo', 'port', 'native', 'extra.js'),
    'globalThis.DEMO_EXTRA = true;\n');
  fs.writeFileSync(path.join(root, 'ports', 'demo', 'port', 'native', 'index.json'),
    JSON.stringify({ modules: ['ports/demo/port/native/extra.js'] }));
  const game = writeMvGame(root, { plugins: [
    { name: 'YED_Tiled', status: true },
    { name: 'Missing_No', status: true },
  ] });
  const manifestPath = path.join(root, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify({
    port: {
      id: 'demo',
      config: 'ports/demo/port/native/config.js',
      entry: 'ports/demo/port/native/index.json',
    },
  }));
  const out = path.join(root, 'out.js');
  const output = childProcess.execFileSync(process.execPath,
    [tool, '--root', root, '--manifest', 'manifest.json',
      '--game', game, '--output', 'out.js']).toString();
  assert.match(output, /\[pmjs-build\] engine: mv/);
  assert.match(output, /YED_Tiled -> js\/pmjs-plugins\/yed\/tiled\.js/);
  assert.match(output, /unmatched enabled plugins: 1/);
  assert.match(output, /\[pmjs-build\] port: demo \(1 module\)/);
  const bundleContent = fs.readFileSync(out, 'utf8');
  const order = [
    'BEGIN ports/demo/port/native/config.js',
    'BEGIN js/pmjs-core/optimizations.js',
    'BEGIN js/pmjs-plugins/yed/tiled.js',
    'BEGIN ports/demo/port/native/extra.js',
    'BEGIN js/pmjs-mv/bootstrap.js',
  ].map(marker => bundleContent.indexOf(marker));
  assert.ok(order.every(index => index >= 0));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
});

test('capability manifest rejects port entry modules outside the port directory', () => {
  const root = temporaryDirectory('pmjs-port-owner-');
  const manifest = path.join(root, 'manifest.json');
  fs.mkdirSync(path.join(root, 'ports', 'demo'), { recursive: true });
  fs.writeFileSync(path.join(root, 'ports', 'demo', 'index.json'), JSON.stringify({
    modules: ['ports/other/port/native/extra.js'],
  }));
  fs.writeFileSync(manifest, JSON.stringify({
    adapters: 'none',
    port: { id: 'demo', entry: 'ports/demo/index.json' },
  }));
  assert.throws(() => childProcess.execFileSync(process.execPath,
    [tool, '--root', root, '--manifest', manifest, '--game', writeMvGame(root),
      '--output', 'out.js']),
  /entry module .* must live under ports\/demo\//);
});

test('port containment checks resolved paths instead of string prefixes', () => {
  const root = temporaryDirectory('pmjs-port-traversal-');
  const game = writeMvGame(root);
  fs.mkdirSync(path.join(root, 'ports', 'demo'), { recursive: true });
  fs.writeFileSync(path.join(root, 'outside.js'), '// outside\n');
  fs.writeFileSync(path.join(root, 'ports', 'demo', 'index.json'), JSON.stringify({
    modules: ['ports/demo/../../outside.js'],
  }));
  const manifest = path.join(root, 'manifest.json');
  fs.writeFileSync(manifest, JSON.stringify({
    port: { id: 'demo', entry: 'ports/demo/index.json' },
  }));
  assert.throws(() => childProcess.execFileSync(process.execPath,
    [tool, '--root', root, '--manifest', manifest, '--game', game, '--output', 'out.js']),
  /entry module .* must live under ports\/demo\//);

  fs.writeFileSync(manifest, JSON.stringify({
    port: {
      id: 'demo',
      config: 'ports/demo/../../outside.js',
      entry: 'ports/demo/index.json',
    },
  }));
  assert.throws(() => childProcess.execFileSync(process.execPath,
    [tool, '--root', root, '--manifest', manifest, '--game', game, '--output', 'out.js']),
  /port config must live under ports\/demo\//);
});

test('capability manifest supports explicit adapter selection', () => {
  const root = temporaryDirectory('pmjs-adapters-explicit-');
  const game = writeMvGame(root);
  const manifest = path.join(root, 'manifest.json');
  fs.writeFileSync(manifest, JSON.stringify({
    adapters: ['Aetherflow_PreloadEverything'],
  }));
  const out = path.join(root, 'out.js');
  childProcess.execFileSync(process.execPath,
    [tool, '--root', root, '--manifest', manifest, '--game', game, '--output', out]);
  const bundleContent = fs.readFileSync(out, 'utf8');
  assert.match(bundleContent, /BEGIN js\/pmjs-plugins\/aetherflow\/image-cache\.js/);
  assert.match(bundleContent, /BEGIN js\/pmjs-plugins\/aetherflow\/audio-cache\.js/);
  fs.writeFileSync(manifest, JSON.stringify({
    adapters: ['No_Such_Plugin'],
  }));
  assert.throws(() => childProcess.execFileSync(process.execPath,
    [tool, '--root', root, '--manifest', manifest, '--game', game, '--output', out]),
  /unknown plugin/);
});

test('adapter modes are deterministic with and without game evidence', () => {
  const root = temporaryDirectory('pmjs-adapter-modes-');
  const game = writeMvGame(root);
  const manifest = path.join(root, 'manifest.json');
  const out = path.join(root, 'out.js');
  const run = (...extra) => childProcess.execFileSync(process.execPath,
    [tool, '--root', root, '--manifest', manifest, ...extra]).toString();

  fs.writeFileSync(manifest, '{}');
  assert.throws(() => run('--output', out), /requires --game/);

  fs.writeFileSync(manifest, JSON.stringify({ adapters: 'all' }));
  run('--game', game, '--output', out);
  const allBundle = fs.readFileSync(out, 'utf8');
  assert.match(allBundle, /BEGIN js\/pmjs-plugins\/yed\/tiled\.js/);
  assert.match(allBundle, /BEGIN js\/pmjs-plugins\/aetherflow\/audio-cache\.js/);

  fs.writeFileSync(manifest, JSON.stringify({ adapters: 'none' }));
  run('--game', game, '--output', out);
  assert.doesNotMatch(fs.readFileSync(out, 'utf8'), /BEGIN js\/pmjs-plugins\/yed\/tiled\.js/);
});

test('print-modules writes only JSON to stdout', () => {
  const root = temporaryDirectory('pmjs-machine-output-');
  const game = writeMvGame(root);
  const manifest = path.join(root, 'manifest.json');
  fs.writeFileSync(manifest, JSON.stringify({ adapters: 'all' }));
  const output = childProcess.execFileSync(process.execPath,
    [tool, '--root', root, '--manifest', manifest, '--game', game,
      '--print-modules']).toString();
  const modules = JSON.parse(output);
  assert.ok(Array.isArray(modules));
  assert.ok(modules.some(entry => entry.module === 'js/pmjs-plugins/yed/tiled.js'));
});

test('--game composes the default capability bundle without a manifest', () => {
  const root = temporaryDirectory('pmjs-game-only-');
  const game = writeMvGame(root, {
    plugins: [{ name: 'YED_Tiled', status: true }],
  });
  const output = childProcess.execFileSync(process.execPath,
    [tool, '--root', root, '--game', game, '--print-modules']).toString();
  const modules = JSON.parse(output);
  assert.ok(modules.some(entry => entry.module === 'js/pmjs-plugins/yed/tiled.js'));
  assert.equal(modules.at(-1).module, 'js/pmjs-mv/bootstrap.js');
});

test('auto adapter overrides and Pixi compatibility use inspected evidence', () => {
  const root = temporaryDirectory('pmjs-auto-overrides-');
  const game = writeMvGame(root, {
    plugins: [{ name: 'YED_Tiled', status: true }],
  });
  const manifest = path.join(root, 'manifest.json');
  fs.writeFileSync(manifest, JSON.stringify({
    adapters: {
      mode: 'auto',
      include: ['Aetherflow_PreloadEverything'],
      exclude: ['YED_Tiled'],
    },
  }));
  const out = path.join(root, 'out.js');
  childProcess.execFileSync(process.execPath,
    [tool, '--root', root, '--manifest', manifest, '--game', game, '--output', out]);
  const bundle = fs.readFileSync(out, 'utf8');
  assert.doesNotMatch(bundle, /BEGIN js\/pmjs-plugins\/yed\/tiled\.js/);
  assert.match(bundle, /BEGIN js\/pmjs-plugins\/aetherflow\/image-cache\.js/);

  fs.writeFileSync(path.join(game, 'js', 'libs', 'pixi.js'), "PIXI.VERSION = '5.3.0';\n");
  assert.throws(() => childProcess.execFileSync(process.execPath,
    [tool, '--root', root, '--manifest', manifest, '--game', game, '--output', out]),
  /engine mv requires Pixi 4\.x; detected 5\.3\.0/);
});

test('auto composition requires a known Pixi version and terminal bootstrap', () => {
  const root = temporaryDirectory('pmjs-profile-invariants-');
  const game = writeMvGame(root);
  const pixi = path.join(game, 'js', 'libs', 'pixi.js');
  fs.writeFileSync(pixi, '// Pixi build without readable version metadata\n');
  assert.throws(() => childProcess.execFileSync(process.execPath,
    [tool, '--root', root, '--game', game, '--output', 'out.js']),
  /could not determine Pixi version/);

  fs.writeFileSync(pixi, "PIXI.VERSION = '4.8.9';\n");
  fs.mkdirSync(path.join(root, 'profiles'), { recursive: true });
  fs.writeFileSync(path.join(root, 'profiles', 'mv.json'), JSON.stringify({
    modules: ['js/pmjs-mv/bootstrap.js', 'after-bootstrap.js'],
  }));
  assert.throws(() => childProcess.execFileSync(process.execPath,
    [tool, '--root', root, '--game', game, '--output', 'out.js']),
  /bootstrap\.js exactly once as its final module/);
});
