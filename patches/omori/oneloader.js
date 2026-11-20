;(function() {
  var host = NativeHost.runtime.oneLoader;
  if (!host) return;
  PMJS.rpgmaker = PMJS.rpgmaker || {};
  PMJS.rpgmaker.start = function() {
    return new Promise(function(resolve, reject) {
      var started = false, installed = false, pluginInjection = Promise.resolve();
      var publication = Promise.resolve(), lastStylesheet;
      function synchronize() {
        publication = publication.then(async function() {
          if (installed) await host.publish(files($modLoader.overlayFS, ''));
          if (PMJS.fonts) {
            var stylesheet = NativeHost.fs.readText('fonts/gamefont.css');
            if (stylesheet !== null && stylesheet !== lastStylesheet) {
              PMJS.fonts.registerStylesheet(stylesheet, 'fonts/gamefont.css');
              lastStylesheet = stylesheet;
            }
          }
        });
        return publication;
      }
      async function startGame() {
        if (started) return;
        started = true;
        try {
          await synchronize();
          pmjsMvLoadPluginManifest();
          NativeHost.runtime.loadScript('modloader/patchplugins.js');
          await pluginInjection;
          pmjsMvInitializePlugins();
          pmjsMvLoadEntrypoint();
          if (globalThis.$modLoader && $modLoader.$runScripts) await $modLoader.$runScripts('pre_window_onload', {});
          if (globalThis.$modLoader && $modLoader.isInTestMode && $modLoader.knownMods && $modLoader.knownMods.has('oneloader') && !$modLoader.config._autoUpdater) {
            $modLoader.config._autoUpdater = { askedYet: false, check: 'deny', lastCheck: Date.now(),
              lastCheckVersion: $modLoader.knownMods.get('oneloader').json.version };
          }
          pmjsMvStart();
          resolve();
        } catch (error) { reject(error); }
      }
      async function* files(directory, prefix) {
        for (var name of Object.keys(directory)) {
          var entry = directory[name], logical = prefix + (entry.ogName || name);
          if (entry.type === 'dir') {
            yield* files(entry.children, logical + '/');
          } else {
            var bytes = Buffer.from(await _vfs_resolve_file(logical));
            yield { path: logical, bytes: bytes };
          }
        }
      }
      function adapt(path) {
        if (path === 'modloader/encryption.js' && NativeHost.runtime.omoriFiles) {
          _modloader_encryption.decrypt = NativeHost.runtime.omoriFiles.decodeText;
          _modloader_encryption.decryptAsset = NativeHost.runtime.omoriFiles.decodeMedia;
        } else if (path === 'modloader/lib/rollup.js') {
          window._loadRollup = async function() { return (await host.importModule('modloader/lib/rollup.browser.js')).rollup; };
        } else if (path === 'modloader/lib/imagediff2.js') {
          var original = wasm_bindgen;
          var initialize = function(input) {
            if (typeof input === 'string') input = NativeHost.fs.readBytes(input.replace(/^\.\//, ''));
            return original(input);
          };
          Object.assign(initialize, original);
          wasm_bindgen = initialize;
        } else if (path === 'modloader/vfs_node.js') {
          _modLoader_install_node_vfs = async function() {};
        } else if (path === 'modloader/vfs_web.js') {
          _modLoader_install_debugger_vfs = async function() {
            installed = true;
            var runScripts = $modLoader.$runScripts;
            $modLoader.$runScripts = function(place, params) {
              var result = Promise.resolve(runScripts.call(this, place, params)).then(function() { return synchronize(); });
              if (place === 'pre_plugin_injection') pluginInjection = result;
              return result;
            };
            await synchronize();
          };
        } else if (path === 'modloader/stage2.js') {
          _safe_prompt = function(first, second, message) {
            return Promise.resolve(confirm(message + '\n\nYes: ' + first + '\nNo: ' + second) ? 1 : 2);
          };
        } else if (path === 'modloader/start_game.js') {
          _start_game = startGame;
        }
      }
      try {
        var options = PMJS.config.omori || {};
        if (options.decrypted || nw.App.argv.indexOf('test') >= 0) {
          nw.App.argv = ['test'].concat(nw.App.argv.filter(function(argument) { return argument !== 'test'; }));
          var virtualFiles = PMJS.config.virtualFiles = PMJS.config.virtualFiles || {};
          virtualFiles.extensionAliases = Object.assign({}, virtualFiles.extensionAliases,
            { '.rpgmvp': '.png', '.rpgmvo': '.ogg', '.rpgmvm': '.m4a' });
          virtualFiles.directoryEntryAliases = Object.assign({}, virtualFiles.directoryEntryAliases);
          var languages = Object.assign({}, virtualFiles.directoryEntryAliases.languages, { '.hero': '.yaml' });
          delete languages['.yaml'];
          virtualFiles.directoryEntryAliases.languages = languages;
        }
        else {
          var keyArgument = nw.App.argv.find(function(argument) { return /^(?:--)?[a-f0-9]{32}$/i.test(argument); });
          if (!keyArgument) keyArgument = '--' + NativeHost.runtime.omoriFiles.getEncryptionKey();
          nw.App.argv = [keyArgument].concat(nw.App.argv.filter(function(argument) { return argument !== keyArgument; }));
        }
        for (var script of host.scripts) {
          if (script.path) { NativeHost.runtime.loadScript(script.path); adapt(script.path); }
          else if (script.source.trim()) NativeHost.runtime.runScript(script.source);
        }
      } catch (error) { reject(error); }
    });
  };
})();
