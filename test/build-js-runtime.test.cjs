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
const runtimeRoot = path.resolve(__dirname, '..');
const compositionApi = import('../tools/build-js-composition.mjs');

async function compose(gameDir, manifest = {}, manifestPath = '<test>') {
  const { resolveCapabilityManifest } = await compositionApi;
  return resolveCapabilityManifest({ root: runtimeRoot, gameDir, manifest, manifestPath });
}

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
  const modules = [...first.matchAll(/^\/\/ BEGIN (js\/[^\n]+)$/gm)].map(match => match[1]);
  const expected = [
    'js/pmjs-pixi4/setup.js',
    'js/pmjs-rpgmaker/input.js',
    'js/pmjs-mv/engine.js',
    'js/pmjs-mv/bootstrap.js',
  ];
  const order = expected.map(module => modules.indexOf(module));
  assert.ok(order.every(index => index >= 0));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.equal(modules.at(-1), 'js/pmjs-mv/bootstrap.js');
  const stamp = fs.statSync(out, { bigint: true }).mtimeNs;
  childProcess.execFileSync(process.execPath, args, { cwd: root });
  assert.equal(fs.statSync(out, { bigint: true }).mtimeNs, stamp);
  childProcess.execFileSync(process.execPath, [...args, '--check'], { cwd: root });
  assert.equal(fs.readFileSync(out, 'utf8'), first);
  assert.match(first, /BEGIN js\/pmjs-mv\/bootstrap.js/);
  assert.doesNotMatch(first, /foreign.js/);
});

test('scene harness sources follow the production profile and selected adapter order', async () => {
  const root = temporaryDirectory('pmjs-scene-composition-');
  const game = writeMvGame(root, { plugins: [{ name: 'MPP_EncounterEffect', status: true }] });
  const { modules } = await compose(game);
  assert.deepEqual(modules.map(item => item.module).filter(source => writerSources.includes(source)), writerSources);
});

test('SRD menu adapter is selected only for enabled plugin demand', async () => {
  const root = temporaryDirectory('pmjs-srd-menu-');
  const game = writeMvGame(root, { plugins: [{ name: 'SRD_MenuBackgrounds', status: true }] });
  let { modules } = await compose(game);
  assert.ok(modules.some(item => item.module === 'js/pmjs-plugins/srd/menu-backgrounds.js'));
  fs.writeFileSync(path.join(game, 'js/plugins.js'),
    'var $plugins = ' + JSON.stringify([{ name: 'SRD_MenuBackgrounds', status: false }]) + ';');
  ({ modules } = await compose(game));
  assert.ok(!modules.some(item => item.module === 'js/pmjs-plugins/srd/menu-backgrounds.js'));
});

test('loading and portable-achievement adapters follow enabled guest plugins', async () => {
  const root = temporaryDirectory('pmjs-loading-adapters-');
  const entries = [
    ['YEP_EventCopier', 'yanfly/event-copier'],
    ['YEP_SaveCore', 'yanfly/save-core'],
    ['YEP_CommonEventMenu', 'yanfly/common-event-menu'],
    ['Irina_VisualNovelBusts', 'irina/visual-novel-busts'],
    ['OrangeGreenworks', 'greenworks/orange']
  ];
  const game = writeMvGame(root, { plugins: entries.map(([name]) => ({ name, status: true })) });
  const enabled = (await compose(game)).modules.map(item => item.module);
  fs.writeFileSync(path.join(game, 'js/plugins.js'), 'var $plugins = ' +
    JSON.stringify(entries.map(([name]) => ({ name, status: false }))) + ';');
  const disabled = (await compose(game)).modules.map(item => item.module);
  for (const [, module] of entries) {
    assert.ok(enabled.includes('js/pmjs-plugins/' + module + '.js'));
    assert.ok(!disabled.includes('js/pmjs-plugins/' + module + '.js'));
  }
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

test('capability manifest selects only runtime-owned adapters before bootstrap', async () => {
  const root = temporaryDirectory('pmjs-capability-');
  const game = writeMvGame(root, { plugins: [{ name: 'YED_Tiled', status: true }, { name: 'Missing_No', status: true }] });
  const { modules, buildReport } = await compose(game, { adapters: 'auto' });
  assert.equal(buildReport.detected.unmatchedEnabledPlugins.length, 1);
  const names = modules.map(item => item.module);
  const adapter = names.indexOf('js/pmjs-plugins/yed/tiled.js');
  assert.ok(adapter > names.indexOf('js/pmjs-core/optimizations.js'));
  assert.ok(adapter < names.indexOf('js/pmjs-mv/bootstrap.js'));
  for (const key of ['port', 'modules', 'append', 'prepend']) {
    await assert.rejects(compose(game, { [key]: {} }), /unsupported manifest key/);
  }
});

test('alternate Pixi paths from inspection are used by MV setup', async () => {
  const root = temporaryDirectory('pmjs-alternate-pixi-');
  const game = writeMvGame(root);
  fs.renameSync(path.join(game, 'js', 'libs', 'pixi.js'),
    path.join(game, 'js', 'pixi.js'));
  fs.renameSync(path.join(game, 'js', 'libs', 'pixi-tilemap.js'),
    path.join(game, 'js', 'pixi-tilemap.js'));
  const { detectedRuntime } = await compose(game);
  const paths = [];
  const context = {
    PMJS_RUNTIME_GAME: detectedRuntime,
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

test('MV inspection rejects a missing tilemap library before bundle generation', async () => {
  const root = temporaryDirectory('pmjs-missing-tilemap-');
  const game = writeMvGame(root);
  fs.unlinkSync(path.join(game, 'js', 'libs', 'pixi-tilemap.js'));
  await assert.rejects(compose(game), /could not find pixi-tilemap\.js/);
});

test('MZ setup uses the inspected Pixi path and version', async () => {
  const root = temporaryDirectory('pmjs-mz-alternate-pixi-');
  const game = writeMzGame(root);
  fs.renameSync(path.join(game, 'js', 'libs', 'pixi.js'),
    path.join(game, 'js', 'pixi.js'));
  const { detectedRuntime } = await compose(game);
  const paths = [];
  const context = {
    PMJS_RUNTIME_GAME: detectedRuntime,
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



test('capability manifest supports explicit adapter selection', async () => {
  const root = temporaryDirectory('pmjs-adapters-explicit-');
  const game = writeMvGame(root);
  const names = (await compose(game, { adapters: ['YED_Tiled'] })).modules.map(item => item.module);
  assert.ok(names.includes('js/pmjs-plugins/yed/tiled.js'));
  assert.ok(!names.some(name => name.startsWith('js/pmjs-plugins/aetherflow/')));
  await assert.rejects(compose(game, { adapters: ['No_Such_Plugin'] }), /unknown plugin/);
});

test('adapter modes are deterministic with and without game evidence', async () => {
  const root = temporaryDirectory('pmjs-adapter-modes-');
  const game = writeMvGame(root);
  await assert.rejects(compose(undefined), /requires --game/);
  const all = (await compose(game, { adapters: 'all' })).modules.map(item => item.module);
  assert.ok(all.includes('js/pmjs-plugins/yed/tiled.js'));
  assert.ok(!all.some(name => name.startsWith('js/pmjs-plugins/aetherflow/')));
  const none = (await compose(game, { adapters: 'none' })).modules.map(item => item.module);
  assert.ok(!none.includes('js/pmjs-plugins/yed/tiled.js'));
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

test('--game composes the default capability bundle without a manifest', async () => {
  const root = temporaryDirectory('pmjs-game-only-');
  const game = writeMvGame(root, {
    plugins: [{ name: 'YED_Tiled', status: true }],
  });
  const modules = (await compose(game)).modules;
  assert.ok(modules.some(entry => entry.module === 'js/pmjs-plugins/yed/tiled.js'));
  assert.equal(modules.at(-1).module, 'js/pmjs-mv/bootstrap.js');
});

test('--game composes the MZ profile with authored engine order and terminal bootstrap', async () => {
  const root = temporaryDirectory('pmjs-mz-game-');
  const game = writeMzGame(root, {
    plugins: [{ name: 'MZ_Only_Plugin', status: true }],
  });
  const modules = (await compose(game)).modules.map(entry => entry.module);
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

test('MZ CLI emits the inspected engine order and terminal bootstrap', () => {
  const root = temporaryDirectory('pmjs-mz-cli-');
  const game = writeMzGame(root, {
    plugins: [{ name: 'MZ_Only_Plugin', status: true }],
  });
  const output = path.join(root, 'mz-bootstrap.js');
  childProcess.execFileSync(process.execPath, [tool, '--game', game, '--output', output]);
  const bundle = fs.readFileSync(output, 'utf8');
  const modules = [...bundle.matchAll(/^\/\/ BEGIN (js\/[^\n]+)$/gm)].map(match => match[1]);
  const expected = [
    'js/pmjs-pixi5/setup.js',
    'js/pmjs-mz/engine.js',
    'js/pmjs-rpgmaker/input.js',
    'js/pmjs-mz/plugin-loader.js',
    'js/pmjs-mz/bootstrap.js',
  ];
  const order = expected.map(module => modules.indexOf(module));
  assert.ok(order.every(index => index >= 0));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.equal(modules.at(-1), 'js/pmjs-mz/bootstrap.js');
  assert.ok(!modules.some(module => module.startsWith('js/pmjs-mv/')));
  assert.match(bundle, /"engine":"mz"/);
  assert.match(bundle, /"engineVersion":"1\.8\.1"/);
});

test('MV and MZ profiles compose only the shared input bridge', () => {
  for (const profileName of ['mv', 'mz']) {
    const profile = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..',
      'profiles', profileName + '.json'), 'utf8'));
    assert.equal(profile.modules.filter(module => module.endsWith('/input.js'))
      .join(','), 'js/pmjs-rpgmaker/input.js');
  }
});

test('MZ composition requires Pixi 5 and rejects MV plugin adapters', async () => {
  const root = temporaryDirectory('pmjs-mz-version-');
  const game = writeMzGame(root, { pixiVersion: '4.8.9' });
  await assert.rejects(compose(game), /engine mz requires Pixi 5\.x; detected 4\.8\.9/);

  fs.writeFileSync(path.join(game, 'js', 'libs', 'pixi.js'), "PIXI.VERSION = '5.3.12';\n");
  await assert.rejects(compose(game, { adapters: 'all' }), /engine mz does not yet support plugin adapter selection/);
});

test('auto adapter overrides and Pixi compatibility use inspected evidence', async () => {
  const root = temporaryDirectory('pmjs-auto-overrides-');
  const game = writeMvGame(root, {
    plugins: [{ name: 'YED_Tiled', status: true }],
  });
  const manifest = {
    adapters: {
      mode: 'auto',
      include: ['YEP_EventMiniLabel'],
      exclude: ['YED_Tiled'],
    },
  };
  let names = (await compose(game, manifest)).modules.map(item => item.module);
  assert.ok(!names.includes('js/pmjs-plugins/yed/tiled.js'));
  assert.ok(names.includes('js/pmjs-plugins/yanfly/event-mini-label.js'));

  fs.writeFileSync(path.join(game, 'js', 'libs', 'pixi.js'), "PIXI.VERSION = '5.3.0';\n");
  await assert.rejects(compose(game, manifest), /engine mv requires Pixi 4\.x; detected 5\.3\.0/);
});

test('auto composition requires a readable Pixi version', async () => {
  const root = temporaryDirectory('pmjs-profile-invariants-');
  const game = writeMvGame(root);
  fs.writeFileSync(path.join(game, 'js/libs/pixi.js'), '// Pixi build without readable version metadata');
  await assert.rejects(compose(game), /could not determine Pixi version/);
});

test('a standalone source copy builds without the surrounding workspace', () => {
  const root = temporaryDirectory('pmjs-standalone-');
  const clone = path.join(root, 'runtime');
  for (const directory of ['js', 'profiles']) fs.cpSync(path.join(__dirname, '..', directory), path.join(clone, directory), { recursive: true });
  fs.mkdirSync(path.join(clone, 'runner'));
  for (const file of ['plugin-manifest.cjs', 'file-overrides.cjs'])
    fs.copyFileSync(path.join(__dirname, '../runner', file), path.join(clone, 'runner', file));
  fs.mkdirSync(path.join(clone, 'tools'));
  for (const file of ['build-js-runtime.mjs', 'build-js-composition.mjs', 'game-inspect.mjs', 'achievement-discovery.mjs']) fs.copyFileSync(path.join(__dirname, '../tools', file), path.join(clone, 'tools', file));
  const game = writeMvGame(root, { plugins: [{ name: 'YED_Tiled', status: true }] });
  const output = path.join(root, 'standalone.js');
  childProcess.execFileSync(process.execPath, [path.join(clone, 'tools/build-js-runtime.mjs'), '--game', game, '--output', output], { cwd: root });
  assert.match(fs.readFileSync(output, 'utf8'), /BEGIN js\/pmjs-plugins\/yed\/tiled.js/);
});

test('primitive recording ships with the selected Terrax adapter', async () => {
  const root = temporaryDirectory('pmjs-terrax-bundle-');
  const game = writeMvGame(root, { plugins: [{ name: 'Terrax_Lighting', status: true }] });
  fs.mkdirSync(path.join(game, 'js/plugins'));
  fs.writeFileSync(path.join(game, 'js/plugins/Terrax_Lighting.js'), '// plugin\n');
  const names = (await compose(game)).modules.map(item => item.module);
  const recorder = 'js/pmjs-web/canvas-primitives.js';
  assert.ok(names.includes(recorder));
  assert.ok(names.indexOf(recorder) < names.indexOf('js/pmjs-plugins/terrax/lighting.js'));
  const { loadProfile } = await compositionApi;
  for (const profile of ['mv', 'mz']) {
    const { modules } = loadProfile(runtimeRoot, profile);
    assert.ok(!modules.includes(recorder));
  }
});


test('explicit adapter files execute in supplied order before engine bootstrap', () => {
  const root = temporaryDirectory('pmjs-explicit-adapters-');
  fs.mkdirSync(path.join(root, 'tools'));
  for (const name of ['build-js-runtime.mjs', 'build-js-composition.mjs', 'game-inspect.mjs', 'achievement-discovery.mjs']) {
    fs.copyFileSync(path.resolve(__dirname, '../tools', name), path.join(root, 'tools', name));
  }
  fs.mkdirSync(path.join(root, 'profiles'));
  fs.mkdirSync(path.join(root, 'runner'));
  fs.copyFileSync(path.resolve(__dirname, '../runner/plugin-manifest.cjs'), path.join(root, 'runner/plugin-manifest.cjs'));
  fs.mkdirSync(path.join(root, 'js/pmjs-mv'), { recursive: true });
  fs.writeFileSync(path.join(root, 'profiles/mv.json'),
    JSON.stringify({ modules: ['js/base.js', 'js/pmjs-mv/bootstrap.js'] }));
  fs.writeFileSync(path.join(root, 'js/base.js'), 'globalThis.order = ["base"];');
  fs.writeFileSync(path.join(root, 'js/pmjs-mv/bootstrap.js'), 'order.push("boot");');
  const first = path.join(root, 'first adapter.js');
  const second = path.join(root, 'second adapter.js');
  fs.writeFileSync(first, 'order.push("first");');
  fs.writeFileSync(second, 'order.push("second");');
  const output = path.join(root, 'bundle.js');
  const builder = path.join(root, 'tools/build-js-runtime.mjs');
  const args = [builder, '--profile', 'mv', '--adapter', first, '--adapter', second, '--output', output];
  childProcess.execFileSync(process.execPath, args);
  const bundle = fs.readFileSync(output, 'utf8');
  const context = {};
  vm.runInNewContext(bundle, context);
  assert.deepEqual(Array.from(context.order), ['base', 'first', 'second', 'boot']);
  childProcess.execFileSync(process.execPath, [...args, '--check']);
  fs.appendFileSync(first, 'order.push("changed");');
  assert.throws(() => childProcess.execFileSync(process.execPath, [...args, '--check']), /out of date/);
  assert.throws(() => childProcess.execFileSync(process.execPath, [...args, '--adapter', first]), /duplicate module/);
  assert.equal(fs.readFileSync(output, 'utf8'), bundle);
  assert.throws(() => childProcess.execFileSync(process.execPath,
    [builder, '--profile', 'mv', '--adapter', path.join(root, 'missing.js'), '--output', output]), /ENOENT/);
  assert.equal(fs.readFileSync(output, 'utf8'), bundle);
});


// A staged package supplies the real add-on; normal source-only runs skip this check.
test('portable indexes preserve resolved options and processor identities with or without artwork',
  { skip: !process.env.PMJS_TEST_RUNTIME && 'set PMJS_TEST_RUNTIME to a staged runtime package' }, async () => {
    const { createBundle } = await import('../tools/game-bundle.mjs');
    const root = temporaryDirectory('pmjs-portable-index-');
    const game = writeMvGame(root);
    fs.mkdirSync(path.join(game, 'img/pictures'), { recursive: true });
    const pixels = Buffer.alloc(64 * 64 * 4);
    for (let y = 16; y < 48; y++) for (let x = 16; x < 48; x++) pixels.set([255, 0, 0, 255], (y * 64 + x) * 4);
    fs.writeFileSync(path.join(game, 'img/pictures/test.png'), require('./helpers/png.cjs').png(64, 64, pixels));
    const config = path.join(root, 'config.json');
    fs.writeFileSync(config, JSON.stringify({ display: { width: 320, height: 240 }, assetPreparation: { maps: false } }));
    const indexes = [];
    for (const includeAssets of [false, true]) {
      const output = path.join(root, String(includeAssets));
      await createBundle({ root: process.env.PMJS_TEST_RUNTIME, share: path.resolve(__dirname, '..'),
        game, config, output, includeAssets });
      const index = JSON.parse(fs.readFileSync(path.join(output, 'asset-index.json')));
      assert.equal(index.width, 320); assert.equal(index.height, 240);
      assert.equal(index.images.length, 1);
      assert.ok(index.images[0].outputs.length > 0);
      for (const page of index.images[0].outputs) assert.equal(fs.existsSync(path.join(output, page.path)), includeAssets);
      indexes.push(index);
    }
    assert.deepEqual(indexes[1], indexes[0], 'processor identities, recipes and records must be identical');
  });

test('ISAT inventory remains explicit and preserves adapter order', () => {
  const output = path.join(temporaryDirectory('pmjs-isat-composition-'), 'bootstrap.js');
  const inventory = path.join(runtimeRoot, 'patches/isat/entry.json');
  const modules = require(inventory).modules.map(module => path.resolve(path.dirname(inventory), module));
  function build(adapters) {
    childProcess.execFileSync(process.execPath, [tool, '--profile', 'mv',
      ...adapters.flatMap(file => ['--adapter', file]), '--output', output]);
    const bundle = fs.readFileSync(output, 'utf8');
    assert.doesNotThrow(() => new vm.Script(bundle));
    return [...bundle.matchAll(/^\/\/ BEGIN (.+)$/gm)].map(match => match[1]);
  }
  const baseline = build([]);
  const allNames = modules.map(file => path.basename(file));
  assert.ok(baseline.every(name => !allNames.includes(name)));
  assert.equal(new Set(modules).size, modules.length);
  modules.forEach(file => assert.ok(fs.statSync(file).isFile()));
  const included = build(modules);
  const names = modules.map(file => path.basename(file));
  const positions = names.map(file => included.indexOf(file));
  assert.ok(positions.every((value, index) => value >= 0 && (!index || value > positions[index - 1])));
  assert.ok(positions.at(-1) < included.indexOf('js/pmjs-mv/bootstrap.js'));
  assert.deepEqual(included.filter(name => !baseline.includes(name)), names);
});


test('adapter selection normalizes manifest and override identities', async () => {
  const root = temporaryDirectory('pmjs-canonical-adapters-');
  const game = writeMvGame(root, { plugins: [{ name: 'yep_coreengine', status: true }] });
  const selected = async manifest => (await compose(game, manifest)).modules.some(item => item.module === 'js/pmjs-plugins/yanfly/core-engine.js');
  assert.equal(await selected({}), true);
  assert.equal(await selected({ adapters: { mode: 'auto', exclude: ['yep_coreengine.JS'] } }), false);
  assert.equal(await selected({ adapters: ['yep_coreengine.js'] }), true);
});


test('auto selection skips colliding manifest identities unless explicitly included', async t => {
  const root = temporaryDirectory('pmjs-colliding-adapters-');
  const game = writeMvGame(root, { plugins: [
    { name: 'YED_Tiled', status: true }, { name: 'yed_tiled', status: true }
  ] });
  const warnings = [];
  t.mock.method(console, 'warn', message => warnings.push(message));
  const selected = async manifest => (await compose(game, manifest)).modules.some(item => item.module === 'js/pmjs-plugins/yed/tiled.js');
  assert.equal(await selected({}), false);
  assert.equal(await selected({ adapters: { mode: 'auto', include: ['yed_tiled.js'] } }), true);
  assert.match(warnings[0], /YED_Tiled, yed_tiled/);
});


test('automatic adapter selection follows truthy plugin status', async () => {
  const root = temporaryDirectory('pmjs-adapter-status-');
  const game = writeMvGame(root, { plugins: [{ name: 'YED_Tiled', status: 1 }] });
  const selected = async () => (await compose(game)).modules.some(item => item.module === 'js/pmjs-plugins/yed/tiled.js');
  assert.equal(await selected(), true);
  fs.writeFileSync(path.join(game, 'js/plugins.js'), 'var $plugins = ' + JSON.stringify([{ name: 'YED_Tiled' }]) + ';');
  assert.equal(await selected(), false);
});

for (const [plugin, module] of [
  ['Olivia_AnimatedPictures', 'js/pmjs-plugins/olivia/animated-pictures.js'],
  ['YEP_ItemCore', 'js/pmjs-plugins/yanfly/item-core.js']
]) {
  test(`${plugin} selects its shared adapter without game patches`, async () => {
    const root = temporaryDirectory('pmjs-shared-plugin-');
    const game = writeMvGame(root, { plugins: [{ name: plugin, status: true }] });
    const selected = async manifest => (await compose(game, manifest)).modules.some(item => item.module === module);
    assert.equal(await selected({}), true);
    assert.equal(await selected({ adapters: { mode: 'auto', exclude: [plugin] } }), false);
  });
}
