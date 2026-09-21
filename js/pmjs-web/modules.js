var moduleCache = Object.create(null);
var registeredCommonJsModules = Object.create(null);
function registerCommonJsModule(names, exports) {
  var requestedNames = Array.isArray(names) ? names : [names];
  if (!requestedNames.length) throw new Error('module registration requires a name');
  for (var index = 0; index < requestedNames.length; index++) {
    var name = requestedNames[index];
    if (typeof name !== 'string' || !name) {
      throw new Error('module registration names must be non-empty strings');
    }
    if (Object.prototype.hasOwnProperty.call(registeredCommonJsModules, name)) {
      throw new Error("module '" + name + "' is already registered");
    }
    registeredCommonJsModules[name] = exports;
  }
}
function countNwCompatibilityUse(method) {
  if (typeof nativeCompatibilityHit === 'function') {
    nativeCompatibilityHit('browser.nwGui', method);
  }
}
function compatibilityCountedNoop(method) {
  return function() { countNwCompatibilityUse(method); };
}
var nativeWindow = {
  showDevTools: compatibilityCountedNoop('Window.showDevTools'),
  closeDevTools: compatibilityCountedNoop('Window.closeDevTools'),
  isDevToolsOpen: function() { return false; },
  close: function() { NativeHost.runtime.quit(); },
  reload: compatibilityCountedNoop('Window.reload'),
  focus: compatibilityCountedNoop('Window.focus'),
  blur: compatibilityCountedNoop('Window.blur'),
  show: compatibilityCountedNoop('Window.show'),
  hide: compatibilityCountedNoop('Window.hide'),
  maximize: compatibilityCountedNoop('Window.maximize'),
  unmaximize: compatibilityCountedNoop('Window.unmaximize'),
  minimize: compatibilityCountedNoop('Window.minimize'),
  restore: compatibilityCountedNoop('Window.restore'),
  enterFullscreen: compatibilityCountedNoop('Window.enterFullscreen'),
  leaveFullscreen: compatibilityCountedNoop('Window.leaveFullscreen'),
  toggleFullscreen: compatibilityCountedNoop('Window.toggleFullscreen'),
  isFullscreen: true,
  moveTo: compatibilityCountedNoop('Window.moveTo'),
  moveBy: compatibilityCountedNoop('Window.moveBy'),
  resizeTo: compatibilityCountedNoop('Window.resizeTo'),
  resizeBy: compatibilityCountedNoop('Window.resizeBy'),
  setPosition: compatibilityCountedNoop('Window.setPosition'),
  setMaximumSize: compatibilityCountedNoop('Window.setMaximumSize'),
  setMinimumSize: compatibilityCountedNoop('Window.setMinimumSize'),
  setAlwaysOnTop: compatibilityCountedNoop('Window.setAlwaysOnTop'),
  setShowInTaskbar: compatibilityCountedNoop('Window.setShowInTaskbar'),
  setResizable: compatibilityCountedNoop('Window.setResizable'),
  on: compatibilityCountedNoop('Window.on'),
  once: compatibilityCountedNoop('Window.once'),
  removeListener: compatibilityCountedNoop('Window.removeListener'),
  removeAllListeners: compatibilityCountedNoop('Window.removeAllListeners'),
  zoomLevel: 0, X: 0, Y: 0,
  get width() {
    return nativeWindowWidth;
  },
  set width(_) {
    countNwCompatibilityUse('Window.width');
  },
  get height() {
    return nativeWindowHeight;
  },
  set height(_) {
    countNwCompatibilityUse('Window.height');
  },
  get title() {
    return (globalThis.__pmjsGameInfo && globalThis.__pmjsGameInfo.title) || pmjsGameConfig.title || 'PMJS';
  },
  set title(v) {
    globalThis.__pmjsSetWindowTitle(v);
  },
  menu: null
};
var nativeNwGui = {
  App: { argv: [], fullArgv: [], dataPath: '/save', manifest: {},
    quit: function() { NativeHost.runtime.quit(); },
    clearCache: compatibilityCountedNoop('App.clearCache'),
    crashBrowser: compatibilityCountedNoop('App.crashBrowser'),
    setCrashDumpDir: compatibilityCountedNoop('App.setCrashDumpDir'),
    on: compatibilityCountedNoop('App.on') },
  Window: { get: function() { return nativeWindow; },
    open: function() { return nativeWindow; } },
  Screen: { Init: compatibilityCountedNoop('Screen.Init'),
    on: compatibilityCountedNoop('Screen.on') },
  Shell: { openExternal: compatibilityCountedNoop('Shell.openExternal'),
    openItem: compatibilityCountedNoop('Shell.openItem'),
    showItemInFolder: compatibilityCountedNoop('Shell.showItemInFolder') },
  Menu: function() { return {
    append: compatibilityCountedNoop('Menu.append'),
    insert: compatibilityCountedNoop('Menu.insert'),
    remove: compatibilityCountedNoop('Menu.remove'),
    createMacBuiltin: compatibilityCountedNoop('Menu.createMacBuiltin'),
    items: [] }; },
  MenuItem: function(options) { return Object.assign(
    { click: compatibilityCountedNoop('MenuItem.click') }, options); },
  Tray: function() { return {
    remove: compatibilityCountedNoop('Tray.remove') }; },
  Clipboard: { get: function() { return {
    get: function() { return ''; },
    set: compatibilityCountedNoop('Clipboard.set'),
    clear: compatibilityCountedNoop('Clipboard.clear') }; } }
};
function resolveModule(request, parentDirectory) {
  var base = request.charAt(0) === '.'
    ? normalizePath(parentDirectory + '/' + request)
    : normalizePath(request);
  var candidates = [base, base + '.js', base + '/index.js'];
  for (var index = 0; index < candidates.length; index++) {
    var candidate = gamePath(candidates[index]);
    if (NativeHost.fs.exists(candidate) && !NativeHost.fs.isDirectory(candidate)) return candidate;
  }
  throw new Error("Cannot find module '" + request + "'");
}

function loadCommonJs(filename) {
  if (moduleCache[filename]) return moduleCache[filename].exports;
  var source = NativeHost.fs.readText(filename);
  if (source === null) throw new Error('Cannot read module ' + filename);
  var module = { exports: {} };
  moduleCache[filename] = module;
  var directory = dirname(filename);
  var localRequire = function(request) { return requireModule(request, directory); };
  var wrapper = Function('exports', 'require', 'module', '__filename', '__dirname', source);
  wrapper(module.exports, localRequire, module, filename, directory);
  return module.exports;
}

function requireModule(request, parentDirectory) {
  if (globalThis.__pmjsBuiltinRequire &&
      (request === 'crypto' || request === 'buffer')) {
    return globalThis.__pmjsBuiltinRequire(request);
  }
  if (request === 'path') return pathModule;
  if (request === 'fs') return fsModule;
  if (request === 'os') {
    return { platform: function() { return 'linux'; },
             homedir: function() { return '/save'; } };
  }
  if (Object.prototype.hasOwnProperty.call(registeredCommonJsModules, request)) {
    return registeredCommonJsModules[request];
  }
  if (request === 'greenworks' || request === 'greenworks.js' ||
      request === './greenworks' || request === './greenworks.js' ||
      request === './js/libs/greenworks' || request === './js/libs/greenworks.js') {
    if (globalThis.__pmjsGreenworksCompat) return globalThis.__pmjsGreenworksCompat;
  }
  if (request === 'buffer' || request === 'esprima') {
    throw new Error("Native module '" + request + "' is unavailable");
  }
  if (request === 'nw.gui') {
    return nativeNwGui;
  }
  return loadCommonJs(resolveModule(request, parentDirectory || '.'));
}

globalThis.require = function(request) { return requireModule(request, '.'); };
globalThis.nw = nativeNwGui;
var hostProcessVersions = typeof process !== 'undefined' && process.versions ? process.versions : {};
var nwCompatVersion = pmjsGameConfig.nwVersion || '0.29.0';
globalThis.process = {
  platform: nativePlatform.platform,
  arch: nativePlatform.arch,
  env: { LOCALAPPDATA: '/save/', HOME: '/save' },
  mainModule: { filename: '/game/index.html' },
  cwd: function() { return '/game'; },
  version: 'v' + (hostProcessVersions.node || '12.0.0'),
  versions: {
    node: hostProcessVersions.node || '12.0.0',
    v8: hostProcessVersions.v8 || '8.0.0',
    uv: hostProcessVersions.uv || '1.0.0',
    nw: nwCompatVersion,
    'node-webkit': nwCompatVersion
  }
};
