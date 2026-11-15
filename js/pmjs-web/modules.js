var moduleCache = Object.create(null);
var registeredCommonJsModules = Object.create(null);
var guestTimersModule;
function registerCommonJsModule(names, exports) {
  var requestedNames = Array.isArray(names) ? Array.prototype.slice.call(names) : [names];
  if (!requestedNames.length) throw new Error('module registration requires a name');
  var seen = new Set();
  for (var index = 0; index < requestedNames.length; index++) {
    var name = requestedNames[index];
    if (typeof name !== 'string' || !name) {
      throw new Error('module registration names must be non-empty strings');
    }
    if (seen.has(name) || Object.prototype.hasOwnProperty.call(registeredCommonJsModules, name)) {
      throw new Error("module '" + name + "' is already registered");
    }
    seen.add(name);
  }
  for (var alias of requestedNames) registeredCommonJsModules[alias] = exports;
}
function countNwCompatibilityUse(method) {
  PMJS.compat.hit('browser.nwGui', method);
}
function compatibilityCountedNoop(method) {
  return function() { countNwCompatibilityUse(method); };
}
function unavailableDevTools() {
  // Error reporting must preserve the game exception.
  try { PMJS.compat.observed('browser.devtools', 'Developer tools are unavailable'); } catch (_) {}
  return false;
}
var NwEventEmitter = globalThis.__pmjsBuiltinRequire('events').EventEmitter;
var nativeWindow = new NwEventEmitter();
var guestNativeWindow = typeof PMJS.tasks.wrapNodeEmitter === 'function'
  ? PMJS.tasks.wrapNodeEmitter(nativeWindow, ['emit']) : nativeWindow;
if (NativeHost.runtime.interceptWindowClose) NativeHost.runtime.interceptWindowClose(true);
function dispatchNodeEmitterEvent(emitter, event, args) {
  try { return emitter.emit.apply(emitter, [event].concat(args || [])); }
  catch (error) {
    if (typeof PMJS.tasks.nodeListenerException === 'function') {
      throw PMJS.tasks.nodeListenerException(error);
    }
    if (typeof pmjsReportNodeException === 'function') pmjsReportNodeException(error);
    else console.error('[pmjs] uncaught exception in Node callback:', error);
    return false;
  }
}
function windowState() { return NativeHost.runtime.windowState(); }
function windowCommand(name, x, y) {
  NativeHost.runtime.windowCommand(name, Number(x) || 0, Number(y) || 0);
  globalThis.__pmjsUpdateWindowState(windowState());
}
var nativeWindowClosed = false;
function closeNativeWindow(force, nodeEvent) {
  if (nativeWindowClosed) return;
  if (!force && nativeWindow.listenerCount('close')) {
    if (nodeEvent) dispatchNodeEmitterEvent(nativeWindow, 'close');
    else nativeWindow.emit('close');
  }
  else {
    nativeWindowClosed = true;
    NativeHost.runtime.quit();
    if (nodeEvent) dispatchNodeEmitterEvent(nativeWindow, 'closed');
    else nativeWindow.emit('closed');
  }
}
function reloadNativeSession() { return NativeHost.runtime.reload(); }
Object.assign(nativeWindow, {
  showDevTools: unavailableDevTools, closeDevTools: unavailableDevTools,
  isDevToolsOpen: function() { return false; },
  close: closeNativeWindow, reload: reloadNativeSession, reloadIgnoringCache: reloadNativeSession,
  focus: function() { windowCommand('focus'); },
  blur: function() { countNwCompatibilityUse('Window.blur'); },
  show: function() { windowCommand('show'); }, hide: function() { windowCommand('hide'); },
  maximize: function() { windowCommand('maximize'); },
  unmaximize: function() { windowCommand('restore'); },
  minimize: function() { windowCommand('minimize'); }, restore: function() { windowCommand('restore'); },
  enterFullscreen: function() { NativeHost.runtime.setFullscreen(true); },
  leaveFullscreen: function() { NativeHost.runtime.setFullscreen(false); },
  toggleFullscreen: function() { NativeHost.runtime.setFullscreen(!NativeHost.runtime.isFullscreen()); },
  moveTo: function(x, y) { windowCommand('move', x, y); },
  moveBy: function(x, y) { var state = windowState(); windowCommand('move', state.x + x, state.y + y); },
  resizeTo: function(width, height) { windowCommand('resize', width, height); },
  resizeBy: function(width, height) { var state = windowState(); windowCommand('resize', state.width + width, state.height + height); },
  setPosition: function(position) {
    if (position !== 'center') throw new RangeError('unsupported window position: ' + position);
    var state = windowState();
    windowCommand('move', (screen.availWidth - state.width) / 2, (screen.availHeight - state.height) / 2);
  },
  setMaximumSize: function(width, height) { windowCommand('maximum', width, height); },
  setMinimumSize: function(width, height) { windowCommand('minimum', width, height); },
  setAlwaysOnTop: function(enabled) { windowCommand('alwaysOnTop', enabled ? 1 : 0); },
  setShowInTaskbar: compatibilityCountedNoop('Window.setShowInTaskbar'),
  setResizable: function(enabled) { windowCommand('resizable', enabled ? 1 : 0); },
  capturePage: function(callback, options) {
    if (typeof callback !== 'function') throw new TypeError('capturePage requires a callback');
    options = typeof options === 'string' ? { format: options } : options || {};
    var format = options.format || 'jpeg', datatype = options.datatype || 'datauri';
    if (['png', 'jpeg', 'jpg'].indexOf(format) < 0 || ['buffer', 'raw', 'datauri'].indexOf(datatype) < 0) {
      throw new TypeError('unsupported capturePage format or datatype');
    }
    captureRequests.push({ callback: callback, format: format, datatype: datatype });
  },
  zoomLevel: 0, menu: null
});
Object.defineProperties(nativeWindow, {
  isFullscreen: { get: function() { return NativeHost.runtime.isFullscreen(); } },
  x: { get: function() { return windowState().x; }, set: function(value) { this.moveTo(value, this.y); } },
  y: { get: function() { return windowState().y; }, set: function(value) { this.moveTo(this.x, value); } },
  width: { get: function() { return nativeWindowWidth; }, set: function(value) { this.resizeTo(value, this.height); } },
  height: { get: function() { return nativeWindowHeight; }, set: function(value) { this.resizeTo(this.width, value); } },
  title: { get: function() { return globalThis.__pmjsGameInfo && globalThis.__pmjsGameInfo.title || PMJS.config.title || 'PMJS'; },
    set: function(value) { globalThis.__pmjsSetWindowTitle(value); } }
});
var nativeApp = new NwEventEmitter();
Object.assign(nativeApp, { argv: [], fullArgv: [], dataPath: '/save', manifest: {},
  quit: function() { closeNativeWindow(true); },
  clearCache: compatibilityCountedNoop('App.clearCache'),
  crashBrowser: compatibilityCountedNoop('App.crashBrowser'),
  setCrashDumpDir: compatibilityCountedNoop('App.setCrashDumpDir') });
var nativeScreen = new NwEventEmitter();
var guestNativeScreen = typeof PMJS.tasks.wrapNodeEmitter === 'function'
  ? PMJS.tasks.wrapNodeEmitter(nativeScreen, ['emit']) : nativeScreen;
nativeScreen.Init = function() {
  nativeScreen.screens = typeof NativeHost.runtime.screens === 'function' ? NativeHost.runtime.screens() : [{ id: 0, bounds: { x: 0, y: 0, width: screen.width, height: screen.height },
    work_area: { x: 0, y: 0, width: screen.availWidth, height: screen.availHeight }, scaleFactor: 1 }];
};
var nativeNwGui = {
  App: nativeApp,
  Window: { get: function() { return guestNativeWindow; }, open: function(url) {
    if (/^(https?:\/\/|mailto:)/i.test(String(url))) { openNativeExternal(url); return; }
    var error = new Error('Secondary HTML windows are unavailable');
    error.code = 'ERR_NW_UNSUPPORTED_WINDOW';
    throw error;
  } },
  Screen: guestNativeScreen,
  Shell: { openExternal: function(url) { return openNativeExternal(url); },
    openItem: compatibilityCountedNoop('Shell.openItem'),
    showItemInFolder: compatibilityCountedNoop('Shell.showItemInFolder') },
  Menu: function(options) {
    this.type = options && options.type || 'contextmenu';
    this.items = [];
    this.append = function(item) { this.items.push(item); };
    this.insert = function(item, index) { this.items.splice(index, 0, item); };
    this.remove = function(item) { var index = this.items.indexOf(item); if (index >= 0) this.items.splice(index, 1); };
    this.removeAt = function(index) { this.items.splice(index, 1); };
    this.popup = compatibilityCountedNoop('Menu.popup');
    this.createMacBuiltin = compatibilityCountedNoop('Menu.createMacBuiltin');
  },
  MenuItem: function(options) { Object.assign(this, { type: 'normal', label: '', enabled: true, checked: false }, options); },
  Tray: function() { this.remove = compatibilityCountedNoop('Tray.remove'); },
  Clipboard: { get: function() { return {
    get: function(type) {
      if (type && type !== 'text') throw new TypeError('only text clipboard data is supported');
      return NativeHost.runtime.clipboardText();
    },
    set: function(text, type) {
      if (type && type !== 'text') throw new TypeError('only text clipboard data is supported');
      NativeHost.runtime.clipboardText(String(text));
    }, clear: function() { NativeHost.runtime.clipboardText(''); }
  }; } }
};
if (PMJS.phases) PMJS.phases.on('windowLoaded', 'pmjs.desktop.loaded', function() {
  PMJS.tasks.enqueue(function() { dispatchNodeEmitterEvent(nativeWindow, 'loaded'); }, { errorMode: 'event' });
});
var captureRequests = [];
PMJS.tasks.onStop(function() { captureRequests.length = 0; });
globalThis.__pmjsAfterPresent = function() {
  if (!captureRequests.length) return;
  var pending = captureRequests.splice(0);
  pending.forEach(function(request) {
    var canvas = NativeHost.canvas.captureDrawable().handle, data;
    try {
      var png = request.format === 'png';
      data = Buffer.from(png ? NativeHost.canvas.encodePng(canvas) : NativeHost.canvas.encodeJpeg(canvas, 0.9));
      if (request.datatype !== 'buffer') data = (request.datatype === 'datauri' ? 'data:image/' + (png ? 'png' : 'jpeg') + ';base64,' : '') + data.toString('base64');
    } finally { NativeHost.canvas.release(canvas); }
    PMJS.tasks.enqueue(function() { return request.callback(data); }, { errorMode: 'uncaught' });
  });
};
var previousNwFullscreen = NativeHost.runtime.isFullscreen();
globalThis.__pmjsDispatchWindowEvents = function(events) {
  events.forEach(function(event) {
    if (event.type === 'display') {
      var old = nativeScreen.screens || [];
      nativeScreen.Init();
      var current = nativeScreen.screens;
      if (current.length > old.length) dispatchNodeEmitterEvent(nativeScreen, 'displayAdded', [current[event.x]]);
      else if (current.length < old.length) dispatchNodeEmitterEvent(nativeScreen, 'displayRemoved', [event.x]);
      else dispatchNodeEmitterEvent(nativeScreen, 'displayBoundsChanged', [current[event.x]]);
    } else if (event.type === 'enter-fullscreen' || event.type === 'leave-fullscreen') {
      previousNwFullscreen = event.type === 'enter-fullscreen';
      dispatchNodeEmitterEvent(nativeWindow, event.type);
    } else if (event.type === 'close') closeNativeWindow(false, true);
    else if (event.type === 'move' || event.type === 'resize') dispatchNodeEmitterEvent(nativeWindow, event.type, [event.x, event.y]);
    else dispatchNodeEmitterEvent(nativeWindow, event.type);
  });
  var fullscreen = NativeHost.runtime.isFullscreen();
  if (fullscreen !== previousNwFullscreen) {
    previousNwFullscreen = fullscreen;
    dispatchNodeEmitterEvent(nativeWindow, fullscreen ? 'enter-fullscreen' : 'leave-fullscreen');
  }
};
globalThis.moveTo = nativeWindow.moveTo;
globalThis.moveBy = nativeWindow.moveBy;
globalThis.resizeTo = nativeWindow.resizeTo;
globalThis.resizeBy = nativeWindow.resizeBy;
globalThis.focus = nativeWindow.focus;
['screenX', 'screenY', 'outerWidth', 'outerHeight'].forEach(function(name, index) {
  Object.defineProperty(globalThis, name, { configurable: true, get: function() {
    return windowState()[['x', 'y', 'width', 'height'][index]];
  } });
});
globalThis.location.reload = reloadNativeSession;
globalThis.chrome = { runtime: { reload: reloadNativeSession } };
function registeredModule(request, parentDirectory) {
  if (Object.prototype.hasOwnProperty.call(registeredCommonJsModules, request)) return request;
  if (request.charAt(0) === '.' || request.charAt(0) === '/') {
    var absolute = pathModule.resolve(parentDirectory || '/game', request);
    var names = Object.keys(registeredCommonJsModules);
    for (var index = 0; index < names.length; index++) {
      if (names[index].charAt(0) !== '.') continue;
      var candidate = pathModule.resolve('/game', names[index]);
      if (candidate === absolute || candidate.replace(/\.js$/, '') === absolute.replace(/\.js$/, '')) return names[index];
    }
  }
  return null;
}
function resolveModule(request, parentDirectory) {
  function file(base) {
    var candidates = [base, base + '.js', base + '.json'];
    for (var index = 0; index < candidates.length; index++) {
      if (fsModule.existsSync(candidates[index]) && !fsModule.statSync(candidates[index]).isDirectory()) return candidates[index];
    }
    return null;
  }
  function directory(base) {
    if (!fsModule.existsSync(base) || !fsModule.statSync(base).isDirectory()) return null;
    var manifest = pathModule.join(base, 'package.json');
    if (fsModule.existsSync(manifest)) {
      var entry = JSON.parse(fsModule.readFileSync(manifest, 'utf8')).main;
      if (typeof entry === 'string' && entry) {
        var target = pathModule.resolve(base, entry);
        var resolved = file(target) || file(pathModule.join(target, 'index'));
        if (resolved) return resolved;
      }
    }
    return file(pathModule.join(base, 'index'));
  }
  var registered = registeredModule(request, parentDirectory);
  if (registered !== null) return registered;
  if (request.charAt(0) === '.' || request.charAt(0) === '/') {
    var base = pathModule.resolve(parentDirectory, request);
    var resolved = file(base) || directory(base);
    if (resolved) return resolved;
  } else {
    var parent = pathModule.resolve(parentDirectory);
    for (;;) {
      var candidate = pathModule.join(parent, 'node_modules', request);
      var found = file(candidate) || directory(candidate);
      if (found) return found;
      if (parent === '/game' || parent === '/') break;
      parent = pathModule.dirname(parent);
    }
    // Older desktop plugins also resolve bare game-relative scripts.
    var local = pathModule.resolve('/game', request);
    var fallback = file(local) || directory(local);
    if (fallback) return fallback;
  }
  var error = new Error("Cannot find module '" + request + "'");
  error.code = 'MODULE_NOT_FOUND';
  throw error;
}

var guestMainModule = { id: '.', filename: '/game/index.html', exports: {}, loaded: true, children: [] };
function createGuestRequire(directory, parent) {
  var localRequire = function(request) { return requireModule(request, directory, parent); };
  localRequire.resolve = function(request) {
    var builtin = guestBuiltin(request);
    return builtin !== undefined ? request : resolveModule(request, directory);
  };
  localRequire.cache = moduleCache;
  localRequire.main = guestMainModule;
  return localRequire;
}
function loadCommonJs(filename, parent) {
  if (moduleCache[filename]) return moduleCache[filename].exports;
  var source = fsModule.readFileSync(filename, 'utf8').replace(/^\uFEFF/, '');
  var module = { id: filename, filename: filename, exports: {}, loaded: false,
    parent: parent || guestMainModule, children: [], paths: [] };
  module.require = createGuestRequire(dirname(filename), module);
  moduleCache[filename] = module;
  module.parent.children.push(module);
  try {
    if (filename.endsWith('.json')) module.exports = JSON.parse(source);
    else {
      var wrapper = Function('exports', 'require', 'module', '__filename', '__dirname',
        source.replace(/^#![^\n]*\n/, '\n'));
      wrapper.call(module.exports, module.exports, module.require, module, filename, dirname(filename));
    }
    module.loaded = true;
  } catch (error) {
    delete moduleCache[filename];
    module.parent.children.splice(module.parent.children.indexOf(module), 1);
    throw error;
  }
  return module.exports;
}
function guestBuiltin(request) {
  var name = request.replace(/^node:/, '');
  if (name === 'path') return pathModule;
  if (name === 'fs') return fsModule;
  if (name === 'fs/promises') return fsModule.promises;
  if (name === 'nw.gui' || name === 'nw') return nativeNwGui;
  if (name === 'child_process') return NativeHost.runtime.childProcess;
  if (name === 'timers' && globalThis.__pmjsBuiltinRequire) {
    if (!guestTimersModule) {
      guestTimersModule = {
        setTimeout: globalThis.setTimeout,
        clearTimeout: globalThis.clearTimeout,
        setInterval: globalThis.setInterval,
        clearInterval: globalThis.clearInterval,
        setImmediate: globalThis.setImmediate,
        clearImmediate: globalThis.clearImmediate
      };
    }
    return guestTimersModule;
  }
  if (name === 'os') {
    var os = globalThis.__pmjsBuiltinRequire('os');
    return Object.assign({}, os, { homedir: function() { return '/save'; } });
  }
  if (['crypto', 'buffer', 'zlib', 'events', 'util', 'stream', 'string_decoder', 'assert', 'dns',
    'url', 'querystring'].indexOf(name) >= 0 && globalThis.__pmjsBuiltinRequire) {
    return globalThis.__pmjsBuiltinRequire(name);
  }
}
function requireModule(request, parentDirectory, parent) {
  if (typeof request !== 'string' || !request) throw new TypeError('module name must be a non-empty string');
  var builtin = guestBuiltin(request);
  if (builtin !== undefined) return builtin;
  var filename = resolveModule(request, parentDirectory || '/game');
  if (Object.prototype.hasOwnProperty.call(registeredCommonJsModules, filename)) return registeredCommonJsModules[filename];
  if (filename.endsWith('.node')) throw new Error('Native guest addons are unavailable: ' + filename);
  return loadCommonJs(filename, parent);
}

globalThis.require = createGuestRequire('/game', guestMainModule);
guestMainModule.require = globalThis.require;
guestMainModule.paths = ['/game/node_modules'];
globalThis.nw = nativeNwGui;
var hostProcessVersions = typeof process !== 'undefined' && process.versions ? process.versions : {};
var hostProcessHrtime = typeof process !== 'undefined' ? process.hrtime : undefined;
var hostProcessPid = typeof process !== 'undefined' ? process.pid : undefined;
var guestArguments = NativeHost.runtime.arguments || [];
var nwCompatVersion = PMJS.config.nwVersion || (globalThis.PMJS_RUNTIME_ENGINE === 'mz' ? '0.48.4' : '0.29.0');
var guestProcess = new NwEventEmitter();
Object.assign(guestProcess, {
  pid: hostProcessPid,
  platform: nativePlatform.platform,
  arch: nativePlatform.arch,
  env: { APPDATA: '/save/', LOCALAPPDATA: '/save/', HOME: '/save' },
  mainModule: guestMainModule,
  argv: ['/game/pmjs', '/game/index.html'].concat(guestArguments),
  cwd: function() { return '/game'; },
  nextTick: function(callback) {
    var args = Array.prototype.slice.call(arguments, 1);
    PMJS.tasks.nextTick(callback, args);
  },
  hrtime: hostProcessHrtime,
  execPath: '/game/pmjs',
  version: 'v' + (hostProcessVersions.node || '12.0.0'),
  versions: Object.assign({}, hostProcessVersions, { nw: nwCompatVersion, 'node-webkit': nwCompatVersion, 'nw-flavor': 'sdk' })
});
globalThis.process = guestProcess;
globalThis.pmjsReportNodeException = function(error) {
  if (guestProcess.listenerCount('uncaughtException')) {
    guestProcess.emit('uncaughtException', error);
  } else {
    console.error('[pmjs] uncaught exception in Node callback:', error);
  }
};
var guestUnhandledPromiseIds = new WeakMap();
var guestUnhandledPromiseId = 0;
var guestUnhandledDeprecationWarned = false;
function emitGuestPromiseWarning(name, message, code, stack) {
  var warning = new Error(message);
  warning.name = name;
  if (code) warning.code = code;
  if (stack) warning.stack = stack;
  if (!guestProcess.emit('warning', warning)) {
    console.warn((warning.code ? '[' + warning.code + '] ' : '') + (warning.stack || warning));
  }
}
function rejectedValueText(reason) {
  try { return reason && reason.stack ? reason.stack : String(reason); }
  catch (_) { return '<unprintable rejection reason>'; }
}
function rejectedValueStack(reason) {
  try { return reason && reason.stack; }
  catch (_) { return undefined; }
}
globalThis.pmjsReportUnhandledPromiseRejection = function(reason, promise, origin) {
  if (origin === 'browser') {
    var event = { type: 'unhandledrejection', reason: reason, promise: promise,
      cancelable: true, defaultPrevented: false,
      preventDefault: function() { this.defaultPrevented = true; } };
    if (typeof globalThis.dispatchEvent === 'function') globalThis.dispatchEvent(event);
    if (!event.defaultPrevented) console.error('[pmjs] unhandled promise rejection:', reason);
    return;
  }
  var id = ++guestUnhandledPromiseId;
  guestUnhandledPromiseIds.set(promise, id);
  if (guestProcess.emit('unhandledRejection', reason, promise)) return;
  emitGuestPromiseWarning('UnhandledPromiseRejectionWarning', rejectedValueText(reason));
  emitGuestPromiseWarning('UnhandledPromiseRejectionWarning',
    'Unhandled promise rejection. This error originated either by throwing inside of an async function without a catch block, ' +
    'or by rejecting a promise which was not handled with .catch(). (rejection id: ' + id + ')', null,
    rejectedValueStack(reason));
  if (!guestUnhandledDeprecationWarned) {
    guestUnhandledDeprecationWarned = true;
    emitGuestPromiseWarning('DeprecationWarning', 'Unhandled promise rejections are deprecated. In the future, promise ' +
      'rejections that are not handled will terminate the Node.js process with a non-zero exit code.', 'DEP0018');
  }
};
globalThis.pmjsReportHandledPromiseRejection = function(promise, origin) {
  if (origin === 'browser') {
    var event = { type: 'rejectionhandled', promise: promise };
    if (typeof globalThis.dispatchEvent === 'function') globalThis.dispatchEvent(event);
    return;
  }
  var id = guestUnhandledPromiseIds.get(promise);
  guestUnhandledPromiseIds.delete(promise);
  if (!guestProcess.emit('rejectionHandled', promise) && id !== undefined) {
    emitGuestPromiseWarning('PromiseRejectionHandledWarning',
      'Promise rejection was handled asynchronously (rejection id: ' + id + ')');
  }
};
var packageText = NativeHost.fs.readText('package.json');
nativeNwGui.App.manifest = packageText === null ? NativeHost.runtime.manifest || {} : JSON.parse(packageText);
nativeNwGui.App.argv = guestArguments.slice();
nativeNwGui.App.fullArgv = process.argv.slice();

function openNativeExternal(url) {
  var address = String(url);
  if (!/^(https?:\/\/|mailto:)/i.test(address) || /[\x00-\x20]/.test(address)) {
    return false;
  }
  var opened = !!NativeHost.runtime.openExternal(address);
  if (!opened) console.warn('[pmjs] system browser could not open URL: ' + address);
  return opened;
}

globalThis.open = function(url) {
  // An external browser has no guest WindowProxy to return.
  if (url !== undefined && String(url) !== '') openNativeExternal(url);
  return null;
};
globalThis.close = closeNativeWindow;
