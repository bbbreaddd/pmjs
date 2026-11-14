'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { performance } = require('node:perf_hooks');
const { createGameFilesystem } = require('./storage.cjs');
const { resolveFileOverride } = require('./file-overrides.cjs');
const { TextEncoder, TextDecoder } = require('node:util');

function installWeb(runtime, { native, storage, gameRoot, settings, config = {} }) {
  const adjacent = path.join(__dirname, 'js');
  const scripts = fs.existsSync(adjacent) ? adjacent : path.join(__dirname, '../js');
  const filesystem = typeof native.fs.stat === 'function' || !storage ? native.fs : createGameFilesystem(native.fs, storage.resolvePath('game-files'));
  Object.assign(runtime.scope, {
    TextEncoder, TextDecoder, resolveFileOverride,
    NativeHost: { ...native, fs: filesystem, storage, runtime: { ...native.runtime, now: () => performance.now(),
      evalScript: (source, filename) => runtime.runScript(source, filename) } }, __pmjsBuiltinRequire: createRequire(path.join(gameRoot, 'package.json')),
    __pmjsNativeRuntime: true, PMJS_GAME_CONFIG: config,
    __pmjsGameInfo: { title: config.title || '', width: settings.width, height: settings.height,
      displayWidth: settings.width, displayHeight: settings.height }, console
  });
  for (const file of [
    'pmjs-core/config.js', 'pmjs-core/compatibility.js', 'pmjs-core/methods.js', 'pmjs-rpgmaker/lifecycle.js', 'pmjs-rpgmaker/plugins.js', 'pmjs-web/runtime.js', 'pmjs-web/scheduler.js', 'pmjs-web/events.js',
    'pmjs-web/fonts.js', 'pmjs-web/canvas.js', 'pmjs-web/object-urls.js', 'pmjs-web/images.js',
    'pmjs-web/elements.js', 'pmjs-web/video-element.js', 'pmjs-web/image-element.js',
    'pmjs-web/document.js', 'pmjs-web/requests.js', 'pmjs-web/script-loader.js',
    'pmjs-web/filesystem.js', 'pmjs-web/modules.js',
    'pmjs-rpgmaker/native-audio.js', 'pmjs-core/achievements.js', 'pmjs-core/steam.js', 'pmjs-plugins/greenworks/compat.js', 'pmjs-plugins/steamworks/compat.js'
  ]) runtime.runScript(fs.readFileSync(path.join(scripts, file), 'utf8'), file);
  const html = fs.readFileSync(path.join(gameRoot, 'index.html'), 'utf8');
  for (const match of html.matchAll(/<script\b[^>]*\bsrc\s*=\s*(["'])(.*?)\1/gi)) {
    const file = match[2];
    if (/^js\/(?:rpg_(?:core|managers|objects|scenes|sprites|windows)|plugins|main)\.js$/.test(file)) continue;
    if (!file.startsWith('js/libs/') || file.split('/').includes('..')) throw new Error('Unsupported startup library: ' + file);
    runtime.runScript(fs.readFileSync(path.join(gameRoot, file), 'utf8'), file);
  }
  return () => {
    runtime.scope.__pmjsUpdateWindowState(native.runtime.windowState());
    return runtime.scope.pmjsDrainScheduler(runtime.scope.performance.now());
  };
}

module.exports = { installWeb };
