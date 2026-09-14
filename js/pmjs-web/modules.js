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
var compatibilityNoop = function() {};
var nativeWindow = {
  showDevTools: compatibilityNoop, closeDevTools: compatibilityNoop,
  isDevToolsOpen: function() { return false; },
  close: function() { NativeHost.runtime.quit(); }, reload: compatibilityNoop,
  focus: compatibilityNoop, blur: compatibilityNoop, show: compatibilityNoop,
  hide: compatibilityNoop, maximize: compatibilityNoop, unmaximize: compatibilityNoop,
  minimize: compatibilityNoop, restore: compatibilityNoop,
  enterFullscreen: compatibilityNoop, leaveFullscreen: compatibilityNoop,
  toggleFullscreen: compatibilityNoop, isFullscreen: true,
  moveTo: compatibilityNoop, moveBy: compatibilityNoop,
  resizeTo: compatibilityNoop, resizeBy: compatibilityNoop,
  setPosition: compatibilityNoop, setMaximumSize: compatibilityNoop,
  setMinimumSize: compatibilityNoop, setAlwaysOnTop: compatibilityNoop,
  setShowInTaskbar: compatibilityNoop, setResizable: compatibilityNoop,
  on: compatibilityNoop, once: compatibilityNoop,
  removeListener: compatibilityNoop, removeAllListeners: compatibilityNoop,
  zoomLevel: 0, X: 0, Y: 0, width: nativeLogicalWidth,
  height: nativeLogicalHeight, title: pmjsGameConfig.title || 'pmjs', menu: null
};
var nativeNwGui = {
  App: { argv: [], fullArgv: [], dataPath: '/save', manifest: {},
    quit: function() { NativeHost.runtime.quit(); }, clearCache: compatibilityNoop,
    crashBrowser: compatibilityNoop, setCrashDumpDir: compatibilityNoop,
    on: compatibilityNoop },
  Window: { get: function() { return nativeWindow; },
    open: function() { return nativeWindow; } },
  Screen: { Init: compatibilityNoop, on: compatibilityNoop },
  Shell: { openExternal: compatibilityNoop, openItem: compatibilityNoop,
    showItemInFolder: compatibilityNoop },
  Menu: function() { return { append: compatibilityNoop, insert: compatibilityNoop,
    remove: compatibilityNoop, createMacBuiltin: compatibilityNoop, items: [] }; },
  MenuItem: function(options) { return Object.assign({ click: compatibilityNoop }, options); },
  Tray: function() { return { remove: compatibilityNoop }; },
  Clipboard: { get: function() { return { get: function() { return ''; },
    set: compatibilityNoop, clear: compatibilityNoop }; } }
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
