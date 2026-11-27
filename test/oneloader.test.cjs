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
    readDirectory: name => fs.readdirSync(path.join(gameRoot, name)),
    isDirectory: name => fs.statSync(path.join(gameRoot, name)).isDirectory(),
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

test('encrypted startup prepares settings without eagerly decoding maps or plugins', () => {
  const f = fixture(), crypto = require('node:crypto'), key = 'a'.repeat(32);
  const encrypt = text => {
    const iv = Buffer.alloc(16, 7), cipher = crypto.createCipheriv('aes-256-ctr', key, iv);
    return Buffer.concat([iv, cipher.update(text), cipher.final()]);
  };
  f.write('js/main.js', 'const key = "' + key + '";');
  f.write('data/System.KEL', encrypt('{"encryptionKey":"media-key"}'));
  f.write('data/Map001.KEL', encrypt('{"events":[]}'));
  f.write('data/Map999.KEL', 'unreadable unused map');
  f.write('js/plugins/Example.OMORI', encrypt('globalThis.example = true;'));
  const roots = f.prepare();
  assert.deepEqual(fs.readdirSync(path.join(roots[0], 'data')), ['System.json']);
  assert.equal(fs.existsSync(path.join(roots[0], 'js')), false);
  assert.equal(f.native.runtime.readGameScript('js/plugins/Example.js'), 'globalThis.example = true;');
  assert.equal(f.native.runtime.gameFiles.canonical('data/Map001.KEL'), 'data/Map001.json');
  assert.equal(Buffer.from(f.native.runtime.gameFiles.readBytes('data/Map001.json')).toString(), '{"events":[]}');
  assert.throws(() => JSON.parse(Buffer.from(f.native.runtime.gameFiles.readBytes('data/Map999.json')).toString()));
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
    'modloader/vfs_node.js': 'async function _modLoader_install_node_vfs() { throw new Error("duplicate filesystem"); }',
    'modloader/early_loader.js': 'globalThis.$modLoader = { overlayFS: {}, $runScripts: async name => events.push(name) }; _modLoader_install_node_vfs().then(_modLoader_install_debugger_vfs).then(_start_game);',
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

test('mod qualification pins hooks and loader code while normalizing randomized plugin identities', async () => {
  const source = `globalThis.$modLoader = { knownMods: new Map([['helper', {json: {id:'helper',version:'1',_flags:['randomize_plugin_name']},plugins:['js/plugins/'+randomPlugin+'.js']}]]),
    $execScripts: {pre_window_onload:[{req:false,data:hookBody}]}, overlayFS:{}, $runScripts:async()=>{} };
    _modLoader_install_debugger_vfs().then(_start_game);`;
  async function qualify(randomPlugin, hookBody = 'known hook', dependency = '', metadata = {}, data = '', target = 'data/CommonEvents.json') {
    const f = guestFixture(source);
    f.scope.__pmjsBuiltinRequire = require;
    f.scope.readGameBytes = name => f.native.fs.readBytes(name);
    f.scope.resolveGameFile = name => f.native.runtime.gameFiles.resolve(name) || name;
    f.scope.$plugins = [];
    Object.assign(f.scope, { randomPlugin, hookBody });
    if (dependency) f.write('modloader/dependency.js', dependency);
    await f.start();
    if (data) {
      f.write('data/CommonEvents.json', data);
      f.scope.$modLoader.knownMods.get('helper').files = [{injectionPoint:target}];
    }
    Object.assign(f.scope.$modLoader.knownMods.get('helper').json, metadata);
    return { ...f, identity: f.scope.PMJS.omori.modSourceIdentity() };
  }
  const first = await qualify('random-first'), second = await qualify('random-second');
  assert.equal(first.identity.digest, second.identity.digest);
  assert.equal(first.identity.pluginNames['random-first'], '@helper/0');
  assert.equal(second.identity.pluginNames['random-second'], '@helper/0');
  assert.notEqual((await qualify('random-first', 'changed hook')).identity.digest, first.identity.digest);
  assert.notEqual((await qualify('random-first', 'known hook', 'changed loader')).identity.digest, first.identity.digest);
  assert.notEqual((await qualify('random-first', 'known hook', '', {version:'2'})).identity.digest, first.identity.digest);
  await assert.rejects(qualify('random-first', 'known hook', '', {asyncExec:[{file:'early.js',runat:'when_discovered'}]}), /discovery hooks/);
  assert.notEqual((await qualify('random-first', 'known hook', '', {}, '[null]')).identity.digest,
    (await qualify('random-first', 'known hook', '', {}, '[null,{"trigger":1}]')).identity.digest);
  assert.equal((await qualify('random-first', 'known hook', '', {}, '[null]')).identity.digest,
    (await qualify('random-first', 'known hook', '', {}, '[null]', 'data/CommonEvents.KEL')).identity.digest);
  first.scope.$modLoader.$execScripts.pre_window_onload.push({req:false,data:'late hook'});
  await first.scope.$modLoader.$runScripts('pre_window_onload', {});
  assert.equal(first.identity.valid, false);
});

test('test-mode startup preserves loader flags and avoids duplicate test arguments', async () => {
  for (const args of [['--no-mods', '--trace-vfs'], ['test', '--dump-overlay']]) {
    const f = guestFixture('globalThis.receivedArguments = nw.App.argv.slice(); _start_game();', '', args);
    await f.start();
    assert.deepEqual(Array.from(f.scope.receivedArguments), ['test', ...args.filter(argument => argument !== 'test')]);
  }
});

test('encrypted startup obtains the shared game key and preserves loader flags', async () => {
  const key = 'a'.repeat(32), explicit = '--' + 'b'.repeat(32);
  for (const args of [[], ['--no-mods'], ['--trace-vfs', explicit]]) {
    const f = guestFixture('globalThis.receivedArguments = nw.App.argv.slice(); _start_game();', '', args);
    f.scope.PMJS.config.omori.decrypted = false;
    f.write('js/main.js', 'const key = "' + key + '";');
    await f.start();
    assert.deepEqual(Array.from(f.scope.receivedArguments), args.includes(explicit)
      ? [explicit, '--trace-vfs'] : ['--' + key, ...args]);
  }
  const f = guestFixture('globalThis.receivedArguments = nw.App.argv.slice(); _start_game();');
  f.scope.PMJS.config.omori.decrypted = false;
  f.write('runtime-config.json', JSON.stringify({ omori: { encryptionKeyFile: 'key.txt' } }));
  f.options.config = path.join(f.gameRoot, 'runtime-config.json');
  f.write('key.txt', key + '\n');
  f.prepare();
  await f.start();
  assert.equal(f.scope.receivedArguments[0], '--' + key);
  const testMode = guestFixture('globalThis.receivedArguments = nw.App.argv.slice(); _start_game();', '', ['--no-mods', 'test']);
  testMode.scope.PMJS.config.omori.decrypted = false;
  await testMode.start();
  assert.deepEqual(Array.from(testMode.scope.receivedArguments), ['test', '--no-mods']);
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

test('overlay publication replaces ASCII case variants and preserves Unicode names', async () => {
  const f = fixture(); f.install(); f.prepare();
  const root = await f.native.runtime.oneLoader.publish([
    { path: 'img/Characters/$DW_SleepingChars.png', bytes: Buffer.from('backport') },
    { path: 'IMG/characters/$dw_sleepingchars.png', bytes: Buffer.from('mod') },
    { path: 'img/characters/É.png', bytes: Buffer.from('upper accent') },
    { path: 'img/characters/é.png', bytes: Buffer.from('lower accent') }
  ]);
  assert.deepEqual(fs.readdirSync(root), ['img']);
  assert.deepEqual(fs.readdirSync(path.join(root, 'img')), ['Characters']);
  const directory = path.join(root, 'img/Characters');
  assert.deepEqual(fs.readdirSync(directory).sort(), ['$DW_SleepingChars.png', 'É.png', 'é.png']);
  assert.equal(fs.readFileSync(path.join(directory, '$DW_SleepingChars.png'), 'utf8'), 'mod');
  assert.equal(fs.readFileSync(path.join(directory, 'É.png'), 'utf8'), 'upper accent');
  assert.equal(fs.readFileSync(path.join(directory, 'é.png'), 'utf8'), 'lower accent');
});

test('plaintext loader mode exposes canonical YAML names for encrypted and mixed language files', async () => {
  const f = guestFixture('globalThis.$modLoader = { overlayFS: {}, $runScripts: async () => {} }; _modLoader_install_debugger_vfs().then(_start_game);');
  f.scope.PMJS.config.virtualFiles = { directoryEntryAliases: { languages: { '.yaml': '.HERO', '.custom': '.yaml' } } };
  await f.scope.PMJS.rpgmaker.start();
  assert.deepEqual(JSON.parse(JSON.stringify(f.scope.PMJS.config.virtualFiles.directoryEntryAliases.languages)), { '.custom': '.yaml', '.hero': '.yaml' });
});

test('installed encryption constructors receive the same content-aware decoder as later reads', () => {
  const f = fixture(); f.install();
  f.write('modloader/encryption.js', 'window._modloader_encryption = new (class Encryption { constructor() { this.system = JSON.parse(this.decrypt(require("fs").readFileSync("data/System.KEL")).toString()); } decrypt() { throw new Error("raw-only decoder"); } })();');
  f.prepare();
  const scope = { NativeHost: f.native, require: () => ({ readFileSync: () => Buffer.from('{"encryptionKey":"fixture"}') }) };
  scope.window = scope;
  vm.runInNewContext(f.native.runtime.readGameScript('modloader/encryption.js'), scope);
  assert.equal(scope._modloader_encryption.system.encryptionKey, 'fixture');
});

test('publication preserves authored language filenames rather than folded lookup keys', async () => {
  const f = guestFixture('globalThis.$modLoader = { overlayFS: { languages: { type: "dir", ogName: "Languages", children: { en: { type: "dir", children: { "system.hero": { ogName: "System.HERO" } } } } } }, $runScripts: async () => {} }; function _vfs_resolve_file() { return Buffer.from("confirm: OK"); } _modLoader_install_debugger_vfs().then(_start_game);');
  await f.start();
  assert.equal(fs.readFileSync(path.join(f.mounts.at(-1), 'Languages/en/System.yaml'), 'utf8'), 'confirm: OK');
});

test('test-mode assistant menus receive updater defaults without overwriting saved preferences', async () => {
  const source = 'globalThis.$modLoader = { isInTestMode: true, knownMods: new Map([["oneloader", {json:{version:"1.5"}}]]), config: {}, overlayFS: {}, $runScripts: async () => {} }; _modLoader_install_debugger_vfs().then(_start_game);';
  const f = guestFixture(source); await f.start();
  assert.equal(f.scope.$modLoader.config._autoUpdater.check, 'deny');
  assert.equal(f.scope.$modLoader.config._autoUpdater.lastCheckVersion, '1.5');
  const g = guestFixture(source.replace('config: {}', 'config: {_autoUpdater:{check:"allow"}}')); await g.start();
  assert.equal(g.scope.$modLoader.config._autoUpdater.check, 'allow');
});

test('plaintext non-JSON .json files pass through without failing AES decryption', () => {
  const f = fixture();
  f.write('js/main.js', 'const key = "' + 'a'.repeat(32) + '";');
  f.write('mods/example/data/Quests.json', 'quests:\n  Aubergine:\n    world: 1\n');
  f.write('mods/example/data/Short.json', 'short: 1\n');
  f.prepare();
  assert.equal(Buffer.from(f.native.runtime.gameFiles.readBytes('mods/example/data/Quests.json')).toString(), 'quests:\n  Aubergine:\n    world: 1\n');
  assert.equal(Buffer.from(f.native.runtime.gameFiles.readBytes('mods/example/data/Short.json')).toString(), 'short: 1\n');
  assert.throws(() => f.native.runtime.gameFiles.decode('data/Broken.KEL', Buffer.alloc(32, 0xff)), /cannot decode OMORI game file/);
  assert.throws(() => f.native.runtime.gameFiles.decode('data/Tiny.KEL', Buffer.from([0xff, 0xfe, 0xfd])), /truncated OMORI game file/);
});
