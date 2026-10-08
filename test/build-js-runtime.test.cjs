'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { temporaryDirectory } = require('./helpers/temp.cjs');
const { writerSources } = require('./helpers/scene-encoder-harness.cjs');

const tool = path.resolve(__dirname, '../tools/build-js-runtime.mjs');

function writeMvGame(root, { pixiVersion = '4.8.9', plugins = [] } = {}) {
  const game = path.join(root, 'game');
  fs.mkdirSync(path.join(game, 'js', 'libs'), { recursive: true });
  fs.writeFileSync(path.join(game, 'js', 'rpg_core.js'), '// RPG Maker MV v1.6.1\n');
  fs.writeFileSync(path.join(game, 'js', 'rpg_managers.js'), '// managers\n');
  fs.writeFileSync(path.join(game, 'js', 'libs', 'pixi.js'),
    `PIXI.VERSION = '${pixiVersion}';\n`);
  fs.writeFileSync(path.join(game, 'js', 'libs', 'pixi-tilemap.js'),
    '// Pixi tilemap\n');
  fs.writeFileSync(path.join(game, 'js', 'plugins.js'),
    `var $plugins = ${JSON.stringify(plugins)};\n`);
  return game;
}

function writeMzGame(root, { pixiVersion = '5.3.12', plugins = [] } = {}) {
  const game = path.join(root, 'game');
  fs.mkdirSync(path.join(game, 'js', 'libs'), { recursive: true });
  fs.writeFileSync(path.join(game, 'js', 'rmmz_core.js'), '// RPG Maker MZ v1.8.1\n');
  fs.writeFileSync(path.join(game, 'js', 'libs', 'pixi.js'),
    `PIXI.VERSION = '${pixiVersion}';\n`);
  fs.writeFileSync(path.join(game, 'js', 'plugins.js'),
    `var $plugins = ${JSON.stringify(plugins)};\n`);
  return game;
}
test('bundle generation is deterministic and resolves modules from its own checkout', () => {
  const root = temporaryDirectory('pmjs-bundle-');
  const game = writeMvGame(root);
  fs.mkdirSync(path.join(root, 'profiles'));
  fs.writeFileSync(path.join(root, 'profiles/mv.json'), JSON.stringify({ modules: ['foreign.js'] }));
  const out = path.join(root, 'out.js');
  const args = [tool, '--game', game, '--output', out];
  childProcess.execFileSync(process.execPath, args, { cwd: root });
  const first = fs.readFileSync(out, 'utf8');
  const stamp = fs.statSync(out, { bigint: true }).mtimeNs;
  childProcess.execFileSync(process.execPath, args, { cwd: root });
  assert.equal(fs.statSync(out, { bigint: true }).mtimeNs, stamp);
  childProcess.execFileSync(process.execPath, [...args, '--check'], { cwd: root });
  assert.equal(fs.readFileSync(out, 'utf8'), first);
  assert.match(first, /BEGIN js\/pmjs-mv\/bootstrap.js/);
  assert.doesNotMatch(first, /foreign.js/);
});

test('scene harness sources follow the production profile and selected adapter order', () => {
  const root = temporaryDirectory('pmjs-scene-composition-');
  const game = writeMvGame(root, { plugins: [{ name: 'MPP_EncounterEffect', status: true }] });
  const out = path.join(root, 'out.js');
  childProcess.execFileSync(process.execPath, [tool, '--game', game, '--output', out]);
  const bundle = fs.readFileSync(out, 'utf8');
  const modules = Array.from(bundle.matchAll(/^\/\/ BEGIN (js\/[^\n]+)$/gm), match => match[1]);
  assert.deepEqual(modules.filter(source => writerSources.includes(source)), writerSources);
});

test('profile bundles accept configuration data without external code insertion', () => {
  const root = temporaryDirectory('pmjs-profile-');
  const config = path.join(root, 'config.json');
  const out = path.join(root, 'out.js');
  fs.writeFileSync(config, JSON.stringify({ title: 'JSON Title', display: { width: 960, height: 540 } }));
  childProcess.execFileSync(process.execPath, [tool, '--profile', 'mv', '--config', config, '--output', out]);
  const bundle = fs.readFileSync(out, 'utf8');
  assert.ok(bundle.indexOf('"title": "JSON Title"') < bundle.indexOf('BEGIN js/pmjs-core/config.js'));
  for (const argument of ['--root', '--compat']) {
    assert.throws(() => childProcess.execFileSync(process.execPath,
      [tool, '--profile', 'mv', argument, root, '--output', out]), /invalid argument/);
  }
  fs.writeFileSync(config, 'globalThis.PMJS_GAME_CONFIG = { title: "Code" };');
  assert.throws(() => childProcess.execFileSync(process.execPath,
    [tool, '--profile', 'mv', '--config', config, '--output', out]), /invalid JSON/);
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
  const configModuleIndex = bundleContent.indexOf('BEGIN js/pmjs-core/config.js');
  const registryIndex = bundleContent.indexOf('BEGIN js/pmjs-core/optimizations.js');
  const lifecycleIndex = bundleContent.indexOf(
    'BEGIN js/pmjs-rpgmaker/lifecycle.js');
  const setupIndex = bundleContent.indexOf('BEGIN js/pmjs-core/intl-warmup.js');
  assert.ok(configIndex >= 0 && configModuleIndex > configIndex &&
    registryIndex > configModuleIndex,
  'registry must follow the injected config and core config module');
  assert.ok(lifecycleIndex > registryIndex && setupIndex > configModuleIndex &&
    setupIndex < registryIndex,
    'core intl warmup must follow config and precede the registry');

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

test('capability manifest selects only runtime-owned adapters before bootstrap', () => {
  const root = temporaryDirectory('pmjs-capability-');
  const game = writeMvGame(root, { plugins: [{ name: 'YED_Tiled', status: true }, { name: 'Missing_No', status: true }] });
  const manifest = path.join(root, 'manifest.json');
  fs.writeFileSync(manifest, JSON.stringify({ adapters: 'auto' }));
  const out = path.join(root, 'out.js');
  const report = childProcess.execFileSync(process.execPath,
    [tool, '--manifest', manifest, '--game', game, '--output', out]).toString();
  assert.match(report, /unmatched enabled plugins: 1/);
  const bundle = fs.readFileSync(out, 'utf8');
  const adapter = bundle.indexOf('BEGIN js/pmjs-plugins/yed/tiled.js');
  assert.ok(adapter > bundle.indexOf('BEGIN js/pmjs-core/optimizations.js'));
  assert.ok(adapter < bundle.indexOf('BEGIN js/pmjs-mv/bootstrap.js'));
  for (const key of ['port', 'modules', 'append', 'prepend']) {
    fs.writeFileSync(manifest, JSON.stringify({ [key]: {} }));
    assert.throws(() => childProcess.execFileSync(process.execPath,
      [tool, '--manifest', manifest, '--game', game, '--output', out]), /unsupported manifest key/);
  }
});

test('alternate Pixi paths from inspection are used by MV setup', () => {
  const root = temporaryDirectory('pmjs-alternate-pixi-');
  const game = writeMvGame(root);
  fs.renameSync(path.join(game, 'js', 'libs', 'pixi.js'),
    path.join(game, 'js', 'pixi.js'));
  fs.renameSync(path.join(game, 'js', 'libs', 'pixi-tilemap.js'),
    path.join(game, 'js', 'pixi-tilemap.js'));
  const out = path.join(root, 'out.js');
  childProcess.execFileSync(process.execPath,
    [tool, '--game', game, '--output', out]);
  const bundle = fs.readFileSync(out, 'utf8');
  const metadata = bundle.match(/globalThis\.PMJS_RUNTIME_GAME = (\{[^\n]+\});/);
  assert.ok(metadata);
  const paths = [];
  const context = {
    PMJS_RUNTIME_GAME: JSON.parse(metadata[1]),
    nativeBootPhase() {},
    NativeHost: { runtime: { loadScript(relative) {
      paths.push(relative);
      if (relative === 'js/pixi.js' && !context.PIXI) {
        context.PIXI = { VERSION: '4.8.9', Container: function() {} };
      }
    } } }
  };
  context.globalThis = context;
  const setup = fs.readFileSync(path.join(__dirname,
    '../js/pmjs-pixi4/setup.js'), 'utf8');
  vm.runInNewContext(setup, context);
  assert.deepEqual(paths.slice(0, 2), ['js/pixi.js', 'js/pixi-tilemap.js']);

  context.PIXI.VERSION = '4.8.8';
  assert.throws(() => vm.runInNewContext(setup, context),
    /inspected Pixi 4\.8\.9 but loaded 4\.8\.8/);
});

test('MV inspection rejects a missing tilemap library before bundle generation', () => {
  const root = temporaryDirectory('pmjs-missing-tilemap-');
  const game = writeMvGame(root);
  fs.unlinkSync(path.join(game, 'js', 'libs', 'pixi-tilemap.js'));
  assert.throws(() => childProcess.execFileSync(process.execPath,
    [tool, '--game', game, '--output', path.join(root, 'out.js')]),
  /could not find pixi-tilemap\.js/);
});

test('MZ setup uses the inspected Pixi path and version', () => {
  const root = temporaryDirectory('pmjs-mz-alternate-pixi-');
  const game = writeMzGame(root);
  fs.renameSync(path.join(game, 'js', 'libs', 'pixi.js'),
    path.join(game, 'js', 'pixi.js'));
  const out = path.join(root, 'out.js');
  childProcess.execFileSync(process.execPath,
    [tool, '--game', game, '--output', out]);
  const bundle = fs.readFileSync(out, 'utf8');
  const metadata = bundle.match(/globalThis\.PMJS_RUNTIME_GAME = (\{[^\n]+\});/);
  assert.ok(metadata);
  const paths = [];
  const context = {
    PMJS_RUNTIME_GAME: JSON.parse(metadata[1]),
    nativeBootPhase() {},
    NativeHost: { runtime: { loadScript(relative) {
      paths.push(relative);
      context.PIXI = { VERSION: '5.3.12', Container: function() {} };
    } } }
  };
  context.globalThis = context;
  const setup = fs.readFileSync(path.join(__dirname,
    '../js/pmjs-pixi5/setup.js'), 'utf8');
  vm.runInNewContext(setup, context);
  assert.deepEqual(paths, ['js/pixi.js']);
  assert.equal(context.PMJS_RUNTIME_GAME.engineVersion, '1.8.1');
});



test('capability manifest supports explicit adapter selection', () => {
  const root = temporaryDirectory('pmjs-adapters-explicit-');
  const game = writeMvGame(root);
  const manifest = path.join(root, 'manifest.json');
  fs.writeFileSync(manifest, JSON.stringify({
    adapters: ['YED_Tiled'],
  }));
  const out = path.join(root, 'out.js');
  childProcess.execFileSync(process.execPath,
    [tool, '--manifest', manifest, '--game', game, '--output', out]);
  const bundleContent = fs.readFileSync(out, 'utf8');
  assert.match(bundleContent, /BEGIN js\/pmjs-plugins\/yed\/tiled\.js/);
  assert.doesNotMatch(bundleContent, /BEGIN js\/pmjs-plugins\/aetherflow\//);
  fs.writeFileSync(manifest, JSON.stringify({
    adapters: ['No_Such_Plugin'],
  }));
  assert.throws(() => childProcess.execFileSync(process.execPath,
    [tool, '--manifest', manifest, '--game', game, '--output', out]),
  /unknown plugin/);
});

test('adapter modes are deterministic with and without game evidence', () => {
  const root = temporaryDirectory('pmjs-adapter-modes-');
  const game = writeMvGame(root);
  const manifest = path.join(root, 'manifest.json');
  const out = path.join(root, 'out.js');
  const run = (...extra) => childProcess.execFileSync(process.execPath,
    [tool, '--manifest', manifest, ...extra]).toString();

  fs.writeFileSync(manifest, '{}');
  assert.throws(() => run('--output', out), /--game DIR/);

  fs.writeFileSync(manifest, JSON.stringify({ adapters: 'all' }));
  run('--game', game, '--output', out);
  const allBundle = fs.readFileSync(out, 'utf8');
  assert.match(allBundle, /BEGIN js\/pmjs-plugins\/yed\/tiled\.js/);
  assert.doesNotMatch(allBundle, /BEGIN js\/pmjs-plugins\/aetherflow\//);

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
    [tool, '--manifest', manifest, '--game', game,
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
    [tool, '--game', game, '--print-modules']).toString();
  const modules = JSON.parse(output);
  assert.ok(modules.some(entry => entry.module === 'js/pmjs-plugins/yed/tiled.js'));
  assert.equal(modules.at(-1).module, 'js/pmjs-mv/bootstrap.js');
});

test('--game composes the MZ profile with authored engine order and terminal bootstrap', () => {
  const root = temporaryDirectory('pmjs-mz-game-');
  const game = writeMzGame(root, {
    plugins: [{ name: 'MZ_Only_Plugin', status: true }],
  });
  const output = childProcess.execFileSync(process.execPath,
    [tool, '--game', game, '--print-modules']).toString();
  const modules = JSON.parse(output).map(entry => entry.module);
  const order = [
    'js/pmjs-pixi5/setup.js',
    'js/pmjs-mz/engine.js',
    'js/pmjs-rpgmaker/input.js',
    'js/pmjs-mz/plugin-loader.js',
    'js/pmjs-mz/bootstrap.js',
  ].map(module => modules.indexOf(module));
  assert.ok(order.every(index => index >= 0));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.equal(modules.at(-1), 'js/pmjs-mz/bootstrap.js');
  assert.ok(!modules.some(module => module.startsWith('js/pmjs-mv/')));
});

test('MV and MZ profiles compose only the shared input bridge', () => {
  for (const profileName of ['mv', 'mz']) {
    const profile = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..',
      'profiles', profileName + '.json'), 'utf8'));
    assert.equal(profile.modules.filter(module => module.endsWith('/input.js'))
      .join(','), 'js/pmjs-rpgmaker/input.js');
  }
});

test('MZ composition requires Pixi 5 and rejects MV plugin adapters', () => {
  const root = temporaryDirectory('pmjs-mz-version-');
  const game = writeMzGame(root, { pixiVersion: '4.8.9' });
  assert.throws(() => childProcess.execFileSync(process.execPath,
    [tool, '--game', game, '--output', path.join(root, 'out.js')]),
  /engine mz requires Pixi 5\.x; detected 4\.8\.9/);

  fs.writeFileSync(path.join(game, 'js', 'libs', 'pixi.js'), "PIXI.VERSION = '5.3.12';\n");
  const manifest = path.join(root, 'manifest.json');
  fs.writeFileSync(manifest, JSON.stringify({ adapters: 'all' }));
  assert.throws(() => childProcess.execFileSync(process.execPath,
    [tool, '--manifest', manifest, '--game', game, '--output', path.join(root, 'out.js')]),
  /engine mz does not yet support plugin adapter selection/);
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
      include: ['YEP_EventMiniLabel'],
      exclude: ['YED_Tiled'],
    },
  }));
  const out = path.join(root, 'out.js');
  childProcess.execFileSync(process.execPath,
    [tool, '--manifest', manifest, '--game', game, '--output', out]);
  const bundle = fs.readFileSync(out, 'utf8');
  assert.doesNotMatch(bundle, /BEGIN js\/pmjs-plugins\/yed\/tiled\.js/);
  assert.match(bundle, /BEGIN js\/pmjs-plugins\/yanfly\/event-mini-label\.js/);

  fs.writeFileSync(path.join(game, 'js', 'libs', 'pixi.js'), "PIXI.VERSION = '5.3.0';\n");
  assert.throws(() => childProcess.execFileSync(process.execPath,
    [tool, '--manifest', manifest, '--game', game, '--output', out]),
  /engine mv requires Pixi 4\.x; detected 5\.3\.0/);
});

test('auto composition requires a readable Pixi version', () => {
  const root = temporaryDirectory('pmjs-profile-invariants-');
  const game = writeMvGame(root);
  fs.writeFileSync(path.join(game, 'js/libs/pixi.js'), '// Pixi build without readable version metadata');
  assert.throws(() => childProcess.execFileSync(process.execPath,
    [tool, '--game', game, '--output', path.join(root, 'out.js')]), /could not determine Pixi version/);
});

test('a standalone source copy builds without the surrounding workspace', () => {
  const root = temporaryDirectory('pmjs-standalone-');
  const clone = path.join(root, 'runtime');
  for (const directory of ['js', 'profiles']) fs.cpSync(path.join(__dirname, '..', directory), path.join(clone, directory), { recursive: true });
  fs.mkdirSync(path.join(clone, 'tools'));
  for (const file of ['build-js-runtime.mjs', 'game-inspect.mjs']) fs.copyFileSync(path.join(__dirname, '../tools', file), path.join(clone, 'tools', file));
  const game = writeMvGame(root, { plugins: [{ name: 'YED_Tiled', status: true }] });
  const output = path.join(root, 'standalone.js');
  childProcess.execFileSync(process.execPath, [path.join(clone, 'tools/build-js-runtime.mjs'), '--game', game, '--output', output], { cwd: root });
  assert.match(fs.readFileSync(output, 'utf8'), /BEGIN js\/pmjs-plugins\/yed\/tiled.js/);
});

test('primitive recording ships with the selected Terrax adapter', () => {
  const root = temporaryDirectory('pmjs-terrax-bundle-');
  const game = writeMvGame(root, { plugins: [{ name: 'Terrax_Lighting', status: true }] });
  fs.mkdirSync(path.join(game, 'js/plugins'));
  fs.writeFileSync(path.join(game, 'js/plugins/Terrax_Lighting.js'), '// plugin\n');
  const output = path.join(root, 'runtime.js');
  childProcess.execFileSync(process.execPath, [tool, '--game', game, '--output', output]);
  const bundle = fs.readFileSync(output, 'utf8');
  const recorder = '// BEGIN js/pmjs-web/canvas-primitives.js';
  const bridge = '// BEGIN js/pmjs-plugins/terrax/bitmap-primitives.js';
  assert.ok(bundle.includes(recorder));
  assert.ok(bundle.indexOf(recorder) < bundle.indexOf(bridge));
  assert.ok(bundle.indexOf(bridge) < bundle.indexOf('// BEGIN js/pmjs-plugins/terrax/lighting.js'));
  for (const profile of ['mv', 'mz']) {
    childProcess.execFileSync(process.execPath, [tool, '--profile', profile, '--output', output]);
    assert.ok(!fs.readFileSync(output, 'utf8').includes(recorder));
  }
});
