'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { runModule } = require('./helpers/runtime-context.cjs');
const { temporaryDirectory } = require('./helpers/temp.cjs');
const { createStorage } = require('../runner/storage.cjs');

function desktop(engine) {
  const root = temporaryDirectory('desktop-');
  const game = createStorage(path.join(root, 'game'));
  const save = createStorage(path.join(root, 'save'));
  const queue = [], stops = [];
  let stopped = false, clipboard = '', quits = 0, reloads = 0, released = 0;
  const state = { x: 10, y: 20, width: 640, height: 480, fullscreen: false };
  let context;
  context = vm.createContext({ Buffer, console, process, performance, PMJS_RUNTIME_ENGINE: engine, __pmjsBuiltinRequire: require,
    PMJS: { config: {}, web: {}, compat: { hit() {} }, tasks: {
      enqueue(fn, options) { if (stopped) return false; queue.push({ fn, options }); return true; },
      onStop(fn) { stops.push(fn); }
    } },
    NativeHost: { storage: save, fs: game, runtime: {
      env() { return ''; }, now: () => 0, windowState() { return { ...state }; }, isFullscreen: () => state.fullscreen,
      setFullscreen(value) { state.fullscreen = value; },
      arguments: ['test', 'flag'], quit() { quits++; }, reload() { reloads++; },
      windowSize: () => ({ width: state.width, height: state.height }),
      windowCommand(name, x, y) {
        if (name === 'move') { state.x = x; state.y = y; }
        if (name === 'resize') { state.width = x; state.height = y; }
      },
      clipboardText(...args) { if (args.length) clipboard = args[0]; return clipboard; },
      openExternal() { return true; }
    }, canvas: { captureDrawable: () => ({ handle: 1 }), encodePng: () => Buffer.from('png'),
      encodeJpeg: () => Buffer.from('jpeg'), release() { released++; } } }
  });
  game.writeText('package.json', '{"name":"test-game","version":"1.2.3"}');
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/pmjs-rpgmaker/lifecycle.js'), 'utf8'), context);
  for (const file of ['runtime', 'filesystem', 'modules']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/pmjs-web/' + file + '.js'), 'utf8'), context);
  }
  return { context, game, save, state, root, drain() {
      while (queue.length) {
        const task = queue.shift();
        try { task.fn(); }
        catch (error) {
          if (task.options?.errorMode === 'uncaught' && context.pmjsReportNodeException) context.pmjsReportNodeException(error);
          else throw error;
        }
      }
    },
    stop() { stopped = true; queue.length = 0; stops.forEach(fn => fn()); },
    get quits() { return quits; }, get reloads() { return reloads; }, get released() { return released; } };
}

test('desktop identity, manifest, arguments and CommonJS packages agree before plugins run', () => {
  const h = desktop(), c = h.context;
  h.game.writeText('node_modules/library/package.json', '{"main":"dist/main"}');
  h.game.writeText('node_modules/library/dist/main.js', 'exports.value = require("./values.json").answer; exports.file = __filename; exports.main = require.main.filename; exports.cached = require.cache[module.filename] === module;');
  h.game.writeText('node_modules/library/dist/values.json', '{"answer":42}');
  h.game.writeText('cycle/a.js', 'exports.before=true; exports.b=require("./b");');
  h.game.writeText('cycle/b.js', 'module.exports=require("./a").before;');
  const result = c.require('library');
  assert.equal(result.value, 42);
  assert.equal(result.file, '/game/node_modules/library/dist/main.js');
  assert.equal(result.main, '/game/index.html');
  assert.equal(result.cached, true);
  assert.equal(c.require('library'), result);
  assert.equal(c.require.resolve('library'), result.file);
  assert.equal(c.require('./cycle/a').b, true);
  assert.equal(c.require('events'), require('events'));
  assert.equal(c.require('node:fs'), c.require('fs'));
  assert.equal(c.require('nw.gui'), c.nw);
  assert.equal(c.nw.App.manifest.name, 'test-game');
  assert.deepEqual(Array.from(c.nw.App.argv), ['test', 'flag']);
  assert.equal(c.process.mainModule, c.require.main);
  assert.equal(c.process.versions.nw, c.process.versions['node-webkit']);
  assert.equal(c.process.versions['nw-flavor'], 'sdk');
  assert.equal(c.process.env.APPDATA, '/save/');
  assert.throws(() => c.require('absent'), { code: 'MODULE_NOT_FOUND' });
  h.game.writeText('broken.js', 'throw new Error("broken module");');
  assert.throws(() => c.require('./broken'), /broken module/);
  h.game.writeText('broken.js', 'module.exports = 99;');
  assert.equal(c.require('./broken'), 99);
});

test('filesystem metadata, directory operations, callback and Promise results preserve errors', async () => {
  const h = desktop(), guest = h.context.require('fs');
  guest.mkdirSync('/save/data');
  guest.writeFileSync('/save/data/a.txt', 'é');
  const stat = guest.statSync('/save/data/a.txt');
  assert.equal(stat.size, 2);
  assert.ok(stat.mtime instanceof Date);
  assert.equal(stat.isFile(), true);
  assert.equal(guest.lstatSync('/save/data').isDirectory(), true);
  assert.equal(guest.accessSync('/save/data/a.txt', guest.constants.R_OK), undefined);
  assert.throws(() => guest.accessSync('/save/missing'), { code: 'ENOENT', path: '/save/missing' });
  assert.equal(guest.statSync('/save/missing', { throwIfNoEntry: false }), undefined);
  assert.throws(() => guest.readdirSync('/save/data/a.txt'), { code: 'ENOTDIR' });
  assert.throws(() => guest.mkdirSync('/save/data'), { code: 'EEXIST' });
  assert.throws(() => guest.unlinkSync('/save/data'), { code: 'EISDIR' });
  assert.throws(() => guest.rmdirSync('/save/data'), { code: 'ENOTEMPTY' });
  const entries = guest.readdirSync('/save/data', { withFileTypes: true });
  assert.equal(entries[0].name, 'a.txt');
  assert.equal(entries[0].isFile(), true);
  let callback;
  guest.lstat('/save/data/a.txt', (error, result) => { assert.equal(error, null); callback = result.size; });
  assert.equal(callback, undefined);
  h.drain();
  assert.equal(callback, 2);
  const pending = guest.promises.stat('/save/data/a.txt');
  h.drain();
  assert.equal((await pending).size, 2);
  guest.rmSync('/save/data', { recursive: true });
  assert.equal(guest.existsSync('/save/data'), false);
});

test('window state, subscriptions, close interception, menus and clipboard have observable behavior', () => {
  const h = desktop(), c = h.context, win = c.nw.Window.get();
  win.resizeTo(800, 600); win.moveTo(30, 40);
  assert.equal(c.outerWidth, 800); assert.equal(win.width, 800);
  assert.equal(c.innerWidth, 800);
  assert.equal(c.nativeLogicalWidth, 640, 'physical resize preserves authored logical size');
  assert.equal(win.x, c.screenX); assert.equal(win.y, 40);
  let closes = 0, moved = [];
  const listener = () => { closes++; };
  win.on('close', listener);
  win.close(); assert.equal(closes, 1); assert.equal(h.quits, 0);
  win.close(true); assert.equal(closes, 1); assert.equal(h.quits, 1);
  win.removeListener('close', listener);
  win.once('move', (x, y) => moved.push([x, y]));
  c.__pmjsDispatchWindowEvents([{ type: 'move', x: 3, y: 4 }, { type: 'move', x: 5, y: 6 }]);
  assert.deepEqual(moved, [[3, 4]]);
  const clipboard = c.nw.Clipboard.get();
  clipboard.set('é'); assert.equal(clipboard.get(), 'é'); clipboard.clear(); assert.equal(clipboard.get(), '');
  const menu = new c.nw.Menu(), item = new c.nw.MenuItem({ label: 'Entry', checked: true });
  menu.append(item); assert.equal(menu.items[0], item); menu.remove(item); assert.equal(menu.items.length, 0);
  assert.throws(() => c.nw.Window.open('editor.html'), { code: 'ERR_NW_UNSUPPORTED_WINDOW' });
  c.location.reload(); c.chrome.runtime.reload(); win.reload(); assert.equal(h.reloads, 3);
});

test('asynchronous NW Window and Screen listener errors use guest Node delivery', () => {
  const h = desktop(), c = h.context, win = c.nw.Window.get(), screen = c.nw.Screen;
  const moveError = new Error('window listener'), displayError = new Error('screen listener');
  const handled = [], later = [];
  c.process.on('uncaughtException', error => handled.push(error));
  win.on('move', () => { throw moveError; });
  screen.on('displayAdded', () => { throw displayError; });
  c.NativeHost.runtime.screens = () => [{ id: 0, bounds: { x: 0, y: 0, width: 640, height: 480 },
    work_area: { x: 0, y: 0, width: 640, height: 480 }, scaleFactor: 1 }];
  c.PMJS.tasks.enqueue(() => c.__pmjsDispatchWindowEvents([{ type: 'move', x: 4, y: 5 }]), { errorMode: 'uncaught' });
  c.PMJS.tasks.enqueue(() => c.__pmjsDispatchWindowEvents([{ type: 'display', x: 0 }]), { errorMode: 'uncaught' });
  c.PMJS.tasks.enqueue(() => later.push('continued'));
  h.drain();
  assert.deepEqual(handled, [moveError, displayError]);
  assert.deepEqual(later, ['continued']);

  const syncError = new Error('synchronous window emit');
  win.on('manual', () => { throw syncError; });
  assert.throws(() => win.emit('manual'), error => error === syncError);
});

test('NW fullscreen methods change native state without entering DOM fullscreen', () => {
  const h = desktop(), c = h.context, win = c.nw.Window.get();
  c.setNativeFullscreen = () => assert.fail('NW window command entered DOM fullscreen');
  const events = [];
  win.on('enter-fullscreen', () => events.push('enter'));
  win.on('leave-fullscreen', () => events.push('leave'));
  win.enterFullscreen();
  assert.equal(win.isFullscreen, true);
  c.__pmjsDispatchWindowEvents([]);
  c.__pmjsDispatchWindowEvents([]);
  win.leaveFullscreen();
  assert.equal(win.isFullscreen, false);
  c.__pmjsDispatchWindowEvents([]);
  win.toggleFullscreen();
  assert.equal(win.isFullscreen, true);
  c.__pmjsDispatchWindowEvents([]);
  win.toggleFullscreen();
  assert.equal(win.isFullscreen, false);
  c.__pmjsDispatchWindowEvents([]);
  assert.deepEqual(events, ['enter', 'leave', 'enter', 'leave']);
});

test('capture waits for presentation, returns requested formats, releases resources and drops terminated callbacks', () => {
  const h = desktop(), c = h.context, win = c.nw.Window.get(), values = [];
  win.capturePage(value => values.push(value), { format: 'png', datatype: 'buffer' });
  win.capturePage(value => values.push(value), { format: 'jpeg', datatype: 'raw' });
  win.capturePage(value => values.push(value), { format: 'png' });
  assert.equal(values.length, 0); assert.equal(h.released, 0);
  c.__pmjsAfterPresent(); assert.equal(values.length, 0); assert.equal(h.released, 3);
  h.drain();
  assert.ok(Buffer.isBuffer(values[0])); assert.equal(values[0].toString(), 'png');
  assert.equal(values[1], Buffer.from('jpeg').toString('base64'));
  assert.equal(values[2], 'data:image/png;base64,' + Buffer.from('png').toString('base64'));
  const callbackError = new Error('capturePage callback');
  let handled;
  c.process.once('uncaughtException', error => { handled = error; });
  win.capturePage(() => { throw callbackError; });
  c.__pmjsAfterPresent(); h.drain();
  assert.equal(handled, callbackError);
  win.capturePage(() => assert.fail('callback after shutdown'));
  h.stop(); c.__pmjsAfterPresent(); h.drain(); assert.equal(h.released, 4);
});

test('desktop loaded and closed events fire once and unavailable developer tools preserve the original exception', () => {
  const h = desktop(), c = h.context, win = c.nw.Window.get();
  let loaded = 0, closed = 0;
  win.on('loaded', () => loaded++); win.on('closed', () => closed++);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/pmjs-rpgmaker/bootstrap.js'), 'utf8'), c);
  c.pmjsRpgMakerBootStarted(); c.pmjsRpgMakerBootStarted(); h.drain();
  assert.equal(loaded, 1);
  const observed = [];
  c.PMJS.compat.hit = () => { throw Error('strict unsupported capability'); };
  c.PMJS.compat.observed = (...args) => observed.push(args);
  const original = new Error('guest exception');
  assert.throws(() => { try { throw original; } catch (error) { win.showDevTools(); throw error; } }, error => error === original);
  assert.equal(observed.length, 1);
  c.PMJS.compat.observed = () => { throw Error('diagnostic failure'); };
  assert.equal(win.showDevTools(), false);
  win.close(true); win.close(true); assert.equal(closed, 1); assert.equal(h.quits, 1);
});

test('sequential desktop resize plugins use the current physical viewport', () => {
  const h = desktop(), c = h.context;
  c.__pmjsCommitLogicalSize(960, 864);
  c.resizeBy(480 - c.innerWidth, 432 - c.innerHeight);
  assert.equal(c.innerWidth, 480); assert.equal(c.innerHeight, 432);
  c.resizeBy(816 - c.innerWidth, 624 - c.innerHeight);
  assert.equal(c.nw.Window.get().width, 816); assert.equal(c.nw.Window.get().height, 624);
  assert.equal(c.nativeLogicalWidth, 960); assert.equal(c.nativeLogicalHeight, 864);
});

test('MV and MZ retain stock desktop detection before plugin initialization', () => {
  for (const engine of ['mv', 'mz']) {
    const h = desktop(engine), c = h.context;
    vm.runInContext('globalThis.Utils={isNwjs:function(){return typeof require === "function" && typeof process === "object";}};', c);
    const stock = c.Utils.isNwjs;
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/pmjs-rpgmaker/platform.js'), 'utf8'), c);
    assert.equal(c.Utils.isNwjs, stock); assert.equal(c.Utils.isNwjs(), true);
    assert.equal(c.process.versions.nw, engine === 'mz' ? '0.48.4' : '0.29.0');
  }
});

function runDesktopModules(context) {
  context.__pmjsBuiltinRequire ||= require;
  context.PMJS.tasks ||= { enqueue() {}, onStop() {} };
  context.NativeHost ||= {};
  context.NativeHost.fs ||= { readText() { return null; } };
  context.NativeHost.runtime ||= {};
  context.NativeHost.runtime.isFullscreen ||= () => false;
  const state = { x: 0, y: 0, width: 640, height: 480 };
  context.NativeHost.runtime.windowState ||= () => state;
  context.NativeHost.runtime.windowCommand ||= (name, x, y) => {
    if (name === 'resize') { state.width = x; state.height = y; }
    if (name === 'move') { state.x = x; state.y = y; }
  };
  context.NativeHost.runtime.clipboardText ||= () => '';
  context.location ||= {};
  context.__pmjsUpdateWindowState ||= () => {};
  runModule(context, 'js/pmjs-web/modules.js');
}

test('nw.gui unsupported calls are diagnosed and external links reach the host', () => {
  const hits = [];
  const opened = [];
  const context = {
    NativeHost: { runtime: { openExternal(url) { opened.push(url); return true; } } },
    process: { platform: 'linux', arch: 'x64', versions: {} },
    nativePlatform: { platform: 'linux', arch: 'x64' },
    nativeLogicalWidth: 800,
    nativeLogicalHeight: 600,
    PMJS: { config: {}, compat: { hit: (capability, detail) =>
      hits.push([capability, String(detail)]) } },
    nativeCompatibilityHit(capability, detail) {
      hits.push([capability, String(detail)]);
    }
  };
  vm.createContext(context);
  runDesktopModules(context);

  const gui = context.require('nw.gui');
  assert.equal(context.nw, gui);

  assert.throws(() => gui.Window.open('editor.html'), { code: 'ERR_NW_UNSUPPORTED_WINDOW' });
  assert.equal((new gui.Menu()).items.length, 0);
  assert.equal((new gui.MenuItem({ label: 'x' })).label, 'x');
  assert.equal(gui.Clipboard.get().get(), '');
  assert.equal(hits.length, 0);

  gui.Window.get().show();
  gui.Window.get().show();
  gui.Shell.openExternal('https://example.com');
  (new gui.Menu()).append({});
  gui.App.clearCache();
  assert.deepEqual(opened, ['https://example.com']);
  assert.deepEqual(hits, [
    ['browser.nwGui', 'App.clearCache']
  ]);
});

test('process.versions and process.version reflect host Node and NW.js compatibility', () => {
  const context = {
    process: {
      platform: 'linux',
      arch: 'x64',
      versions: { node: '25.4.0', v8: '14.0.0', uv: '1.48.0' }
    },
    nativePlatform: { platform: 'linux', arch: 'x64' },
    nativeLogicalWidth: 800,
    nativeLogicalHeight: 600,
    PMJS: { config: {} }
  };
  vm.createContext(context);
  runDesktopModules(context);

  assert.ok(context.process.versions);
  assert.equal(context.process.version, 'v25.4.0');
  assert.equal(context.process.versions.node, '25.4.0');
  assert.equal(context.process.versions.v8, '14.0.0');
  assert.equal(context.process.versions.nw, '0.29.0');
  assert.equal(context.process.versions['node-webkit'], '0.29.0');
});

test('guest rejection policy is independent of host Node and NW compatibility versions', () => {
  for (const [engine, nwVersion] of [['mv', undefined], ['mz', undefined], ['mz', '0.99.0']]) {
    const context = {
      process: { versions: { node: '25.4.0', v8: '14.0.0' } },
      nativePlatform: { platform: 'linux', arch: 'x64' },
      PMJS_RUNTIME_ENGINE: engine,
      PMJS: { config: { nwVersion } }
    };
    vm.createContext(context);
    runDesktopModules(context);
    const warnings = [];
    context.process.on('warning', warning => warnings.push(warning));
    context.pmjsReportUnhandledPromiseRejection('first rejection', Promise.resolve(), 'node');
    context.pmjsReportUnhandledPromiseRejection('second rejection', Promise.resolve(), 'node');
    assert.equal(context.process.versions.node, '25.4.0');
    assert.equal(context.process.version, 'v25.4.0');
    assert.equal(context.process.versions.nw, nwVersion || (engine === 'mz' ? '0.48.4' : '0.29.0'));
    assert.equal(warnings.filter(warning => warning.name === 'UnhandledPromiseRejectionWarning').length, 4);
    assert.equal(warnings.filter(warning => warning.code === 'DEP0018').length, 1);
    assert.ok(warnings.every(warning => !warning.message.includes('--unhandled-rejections')));
  }
});

test('guest OS identity queries reach Node while filesystem paths remain virtual', () => {
  const hostOs = require('node:os');
  let network;
  const context = vm.createContext({
    process,
    nativePlatform: { platform: process.platform, arch: process.arch },
    PMJS: { config: {} },
    __pmjsBuiltinRequire(name) {
      if (name !== 'os') return require(name);
      return {
        hostname: () => hostOs.hostname(),
        userInfo: options => hostOs.userInfo(options),
        networkInterfaces: () => (network = hostOs.networkInterfaces())
      };
    }
  });
  runDesktopModules(context);
  const os = context.require('os');
  assert.equal(os.hostname(), hostOs.hostname());
  assert.equal(os.networkInterfaces(), network);
  assert.equal(os.userInfo().username, hostOs.userInfo().username);
  assert.equal(Buffer.isBuffer(os.userInfo({ encoding: 'buffer' }).username), true);
  assert.equal(os.homedir(), '/save');
  assert.equal(context.process.execPath, '/game/pmjs');
  assert.equal(context.process.cwd(), '/game');
});

test('document.title and nw.Window.title read from and write to authoritative __pmjsGameInfo', () => {
  const { elementSources } = require('./helpers/web-element-sources.cjs');

  const context = {
    globalThis: {},
    PMJS: { config: {} },
    CanvasContext2D: function CanvasContext2D() {},
    nativeWindowState: { focused: true, visible: true },
    nativePlatform: { platform: 'linux', arch: 'x64' },
    nativeLogicalWidth: 816,
    nativeLogicalHeight: 624,
    NativeHost: { runtime: { env() { return ''; }, quit() {} } },
    __pmjsGameInfo: { title: 'Authoritative Game Title', width: 960, height: 720 },
    __pmjsLegacyConfigTitle: 'Fallback Config Title',
    __pmjsSetWindowTitle(value) { this.__pmjsGameInfo.title = String(value); }
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  runModule(context, 'js/pmjs-web/events.js');
  for (const relative of elementSources) runModule(context, relative);
  runDesktopModules(context);

  assert.equal(context.document.title, 'Authoritative Game Title');
  const nw = context.require('nw.gui');
  assert.equal(nw.Window.get().title, 'Authoritative Game Title');

  context.document.title = 'New Mutated Title';
  assert.equal(context.__pmjsGameInfo.title, 'New Mutated Title');
  assert.equal(nw.Window.get().title, 'New Mutated Title');
});

test('DOM and NW window dimensions agree while the authored viewport stays separate', () => {
  const { elementSources } = require('./helpers/web-element-sources.cjs');

  const windowTitles = [];
  const context = {
    globalThis: {},
    PMJS: { config: {}, compat: { hit() {} } },
    CanvasContext2D: function CanvasContext2D() {},
    NativeHost: {
      runtime: {
        now() { return 0; },
        env() { return ''; },
        quit() {},
        displaySize() { return { width: 640, height: 480 }; },
        setWindowTitle(title) { windowTitles.push(title); }
      }
    },
    __pmjsGameInfo: {
      title: 'Demo Game',
      width: 960,
      height: 720,
      displayWidth: 640,
      displayHeight: 480
    }
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  runModule(context, 'js/pmjs-web/runtime.js');
  runModule(context, 'js/pmjs-web/events.js');
  for (const relative of elementSources) runModule(context, relative);
  runDesktopModules(context);

  // Screen reports physical display
  assert.equal(context.screen.width, 640);
  assert.equal(context.screen.height, 480);

  // DOM inner dimensions report the physical window.
  assert.equal(context.innerWidth, 640);
  assert.equal(context.innerHeight, 480);

  const nw = context.require('nw.gui');
  const win = nw.Window.get();
  assert.equal(win.width, 640);
  assert.equal(win.height, 480);
  assert.equal(win.title, 'Demo Game');

  // NW setters change the window without changing the authored resolution.
  win.width = 1000;
  assert.equal(win.width, 1000);
  assert.equal(context.__pmjsGameInfo.width, 960);
  assert.equal(context.innerWidth, 1000);
  assert.equal(context.screen.width, 640, 'screen.width remains physical display');

  // Inner dimensions are observational rather than resize commands.
  assert.throws(() => { context.innerWidth = 1280; }, TypeError);
  assert.equal(context.innerWidth, 1000);
  assert.equal(win.width, 1000);
  assert.equal(context.__pmjsGameInfo.width, 960);

  // Title mutation propagates to NativeHost.runtime.setWindowTitle
  context.document.title = 'Title Changed';
  assert.equal(context.__pmjsGameInfo.title, 'Title Changed');
  assert.equal(win.title, 'Title Changed');
  assert.equal(windowTitles[windowTitles.length - 1], 'Title Changed');

  win.title = 'Title Changed via NW';
  assert.equal(context.__pmjsGameInfo.title, 'Title Changed via NW');
  assert.equal(context.document.title, 'Title Changed via NW');
  assert.equal(windowTitles[windowTitles.length - 1], 'Title Changed via NW');
});
