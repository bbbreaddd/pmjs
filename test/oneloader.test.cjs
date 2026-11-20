'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { temporaryDirectory } = require('./helpers/temp.cjs');
const { prepareGameFiles } = require('../runner/game-preparation.cjs');

function fixture() {
  const root = temporaryDirectory('oneloader-installed-'), gameRoot = path.join(root, 'game');
  function write(name, bytes) {
    const file = path.join(gameRoot, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes);
  }
  const mounts = [], native = { runtime: {}, fs: {
    exists: name => fs.existsSync(path.join(gameRoot, name)),
    readBytes(name) {
      const mounted = mounts.length && path.join(mounts.at(-1), name);
      return fs.readFileSync(mounted && fs.existsSync(mounted) ? mounted : path.join(gameRoot, name));
    },
    readText(name) { try { return this.readBytes(name).toString('utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } },
    mountReadOnlyOverlay: name => mounts.push(name)
  } };
  const options = { gameRoot, saveRoot: path.join(root, 'save'), assetPreparation: { cacheRoot: path.join(root, 'cache') },
    gamePreparation: 'patches/omori/oneloader.cjs' };
  const install = html => { write('index.html', html || '<script src="modloader/early_loader.js"></script>'); write('modloader/early_loader.js', '// installed loader'); };
  return { root, gameRoot, write, native, options, mounts, install, prepare: () => prepareGameFiles(options, native) };
}

test('OneLoader integration is inactive without an installed loader', () => {
  const f = fixture(); f.write('mods/example/mod.json', 'invalid manifest is owned by OneLoader');
  assert.deepEqual(f.prepare(), []); assert.equal(f.native.runtime.oneLoader, undefined);
});

test('installed index supplies script order and user-provided modules', async () => {
  const f = fixture(); f.install('<script>globalThis.installed = true;</script><script src="./custom.js"></script><script src="modloader/early_loader.js"></script>');
  f.write('custom.js', 'export const source = "user installation";');
  assert.deepEqual(f.prepare(), []);
  assert.deepEqual(f.native.runtime.oneLoader.scripts, [{ source: 'globalThis.installed = true;' }, { path: 'custom.js' }, { path: 'modloader/early_loader.js' }]);
  assert.equal((await f.native.runtime.oneLoader.importModule('custom.js')).source, 'user installation');
  f.write('index.html', '<script src="js/main.js"></script>');
  assert.throws(f.prepare, /installation is incomplete/);
});

test('published loader output is isolated, repairs cache corruption and refreshes native assets', async () => {
  const f = fixture(); f.install(); f.prepare();
  const refreshed = []; f.native.runtime.refreshAssets = async roots => refreshed.push(roots);
  const entries = () => [{ path: 'data/Actors.json', bytes: Buffer.from('[null,{"name":"modded"}]') },
    { path: 'js/plugins/added.js', bytes: Buffer.from('globalThis.added = true;') }];
  const publish = () => f.native.runtime.oneLoader.publish(entries());
  const root = await publish();
  assert.equal(await publish(), root);
  assert.deepEqual(refreshed, [[root]]);
  assert.equal(f.mounts.at(-1), root);
  assert.equal(fs.existsSync(path.join(f.gameRoot, 'data/Actors.json')), false);
  fs.writeFileSync(path.join(root, 'unexpected.txt'), 'extra');
  const target = path.join(root, 'data/Actors.json'), outside = path.join(f.root, 'outside.json');
  fs.writeFileSync(outside, entries()[0].bytes); fs.unlinkSync(target); fs.symlinkSync(outside, target);
  assert.equal(await publish(), root);
  assert.equal(fs.existsSync(path.join(root, 'unexpected.txt')), false);
  assert.equal(fs.lstatSync(target).isSymbolicLink(), false);
  assert.deepEqual(fs.readFileSync(outside), entries()[0].bytes);
  assert.deepEqual(fs.readFileSync(target), entries()[0].bytes);
});

test('invalid native output cannot publish a partial layer', async () => {
  const f = fixture(); f.install(); f.prepare();
  await assert.rejects(f.native.runtime.oneLoader.publish([{ path: '../escape', bytes: Buffer.from('bad') }]), /invalid prepared game file path/);
  assert.deepEqual(f.mounts, []);
  assert.deepEqual(fs.readdirSync(path.join(f.options.assetPreparation.cacheRoot, 'oneloader')), []);
});

test('native startup executes installed scripts and installed plugin patching', async () => {
  const events = [], scripts = {
    'modloader/start_game.js': 'function _start_game() { throw new Error("browser startup used"); }',
    'modloader/vfs_web.js': 'function _modLoader_install_debugger_vfs() { throw new Error("Chromium required"); }',
    'modloader/early_loader.js': 'globalThis.$modLoader = { overlayFS: {}, $runScripts: async name => events.push(name) }; _modLoader_install_debugger_vfs().then(_start_game);',
    'modloader/patchplugins.js': 'events.push("installed parameter patcher");'
  };
  const scope = { events, PMJS: { config: { omori: { decrypted: true } } }, nw: { App: { argv: [] } },
    pmjsMvLoadPluginManifest() { events.push('manifest'); }, pmjsMvInitializePlugins() { events.push('plugins'); },
    pmjsMvLoadEntrypoint() { events.push('main'); }, pmjsMvStart() { events.push('start'); } };
  scope.window = scope;
  scope.NativeHost = { runtime: { oneLoader: { scripts: Object.keys(scripts).filter(name => name !== 'modloader/patchplugins.js').map(name => ({ path: name })),
    async publish(entries) { for await (const _entry of entries) assert.fail('unexpected overlay'); if (!events.includes('native VFS')) events.push('native VFS'); } },
    loadScript(name) { vm.runInContext(scripts[name], context); }, runScript(source) { vm.runInContext(source, context); } } };
  const context = vm.createContext(scope);
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../patches/omori/oneloader.js'), 'utf8'), context);
  await scope.PMJS.rpgmaker.start();
  assert.deepEqual(events, ['native VFS', 'manifest', 'installed parameter patcher', 'plugins', 'main', 'pre_window_onload', 'start']);
  assert.deepEqual(Array.from(scope.nw.App.argv), ['test']);
});

function guestFixture(early, patch = '', argv = []) {
  const f = fixture();
  const scripts = {
    'modloader/start_game.js': 'function _start_game() {}',
    'modloader/vfs_web.js': 'function _modLoader_install_debugger_vfs() {}',
    'modloader/early_loader.js': early
  };
  f.install(Object.keys(scripts).map(name => '<script src="' + name + '"></script>').join(''));
  for (const [name, source] of Object.entries(scripts)) f.write(name, source);
  f.write('modloader/patchplugins.js', patch);
  f.write('fonts/gamefont.css', '@font-face { font-family: GameFont; src: url(original.ttf); }');
  f.prepare();
  const scope = { Buffer, NativeHost: f.native, PMJS: { config: { omori: { decrypted: true } } }, nw: { App: { argv } },
    pmjsMvLoadPluginManifest() {}, pmjsMvInitializePlugins() {}, pmjsMvLoadEntrypoint() {}, pmjsMvStart() {} };
  scope.window = scope;
  const context = vm.createContext(scope);
  f.native.runtime.loadScript = name => vm.runInContext(f.native.fs.readText(name), context);
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../js/pmjs-web/fonts.js'), 'utf8'), context);
  scope.PMJS.fonts.registerStylesheet(f.native.fs.readText('fonts/gamefont.css'), 'fonts/gamefont.css');
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../patches/omori/oneloader.js'), 'utf8'), context);
  return { ...f, scope, start: () => scope.PMJS.rpgmaker.start() };
}

test('test-mode startup preserves loader flags and avoids duplicate test arguments', async () => {
  for (const args of [['--no-mods', '--trace-vfs'], ['test', '--dump-overlay']]) {
    const f = guestFixture('globalThis.receivedArguments = nw.App.argv.slice(); _start_game();', '', args);
    await f.start();
    assert.deepEqual(Array.from(f.scope.receivedArguments), ['test', ...args.filter(argument => argument !== 'test')]);
  }
});

test('async injection hooks finish before plugin setup and failures reject startup', async () => {
  for (const fail of [false, true]) {
    const f = guestFixture(`
      globalThis.$modLoader = { overlayFS: {}, async $runScripts(place) {
        if (place === 'pre_plugin_injection') {
          await Promise.resolve(); await Promise.resolve();
          ${fail ? 'throw new Error("hook failed");' : 'globalThis.parameter = "from async hook";'}
        }
      } };
      _modLoader_install_debugger_vfs().then(_start_game).catch(error => { globalThis.loaderError = error; });
    `, '$modLoader.$runScripts("pre_plugin_injection", {});');
    let setup = false;
    f.scope.pmjsMvInitializePlugins = () => { setup = true; assert.equal(f.scope.parameter, 'from async hook'); };
    if (fail) { await assert.rejects(f.start(), /hook failed/); assert.equal(setup, false); }
    else { await f.start(); assert.equal(setup, true); }
  }
});

test('late hook files and font stylesheets reach native reads before the next startup stage', async () => {
  const f = guestFixture(`
    globalThis.$modLoader = { overlayFS: {}, async $runScripts(place) {
      await Promise.resolve();
      const entries = $modLoader.overlayFS;
      if (place === 'pre_game_start') {
        entries['late.txt'] = { type: 'file', data: Buffer.from('before plugins') };
        entries.fonts = { type: 'dir', children: { 'gamefont.css': { type: 'file', data:
          Buffer.from('@font-face { font-family: GameFont; src: url(translated.ttf); }') } } };
      } else if (place === 'pre_plugin_injection') {
        entries['late.txt'].data = Buffer.from('after injection hook');
      } else if (place === 'pre_window_onload') {
        entries['late.txt'].data = Buffer.from('before window load');
      } else if (place === 'after_startup') {
        delete entries['late.txt'];
      }
    } };
    globalThis._vfs_resolve_file = async name => {
      let entry; let directory = $modLoader.overlayFS;
      for (const part of name.split('/')) { entry = directory[part]; directory = entry.children; }
      return entry.data;
    };
    _modLoader_install_debugger_vfs().then(async () => {
      await $modLoader.$runScripts('pre_game_start', {}); await _start_game();
    });
  `, '$modLoader.$runScripts("pre_plugin_injection", {});');
  f.scope.pmjsMvLoadPluginManifest = () => {
    assert.equal(f.native.fs.readText('late.txt'), 'before plugins');
    assert.equal(f.scope.PMJS.fonts.getRegisteredFaces().gamefont.path, 'fonts/translated.ttf');
  };
  f.scope.pmjsMvInitializePlugins = () => assert.equal(f.native.fs.readText('late.txt'), 'after injection hook');
  f.scope.pmjsMvStart = () => assert.equal(f.native.fs.readText('late.txt'), 'before window load');
  await f.start();
  await f.scope.$modLoader.$runScripts('after_startup', {});
  assert.equal(f.native.fs.readText('late.txt'), null);
});
