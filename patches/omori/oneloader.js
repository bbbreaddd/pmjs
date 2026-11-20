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
          pmjsMvStart();
          resolve();
        } catch (error) { reject(error); }
      }
      async function* files(directory, prefix) {
        for (var name of Object.keys(directory)) {
          var entry = directory[name], logical = prefix + name;
          if (entry.type === 'dir') {
            yield* files(entry.children, logical + '/');
          } else {
            var bytes = Buffer.from(await _vfs_resolve_file(logical));
            yield { path: logical, bytes: bytes };
            var steam = logical.match(/\.(kel|hero|omori|aubrey|pluto)$/i);
            var asset = logical.match(/\.(rpgmvp|rpgmvo|rpgmvm)$/i);
            if (steam) {
              var extension = /^(hero|pluto)$/i.test(steam[1]) ? '.yaml' : /^omori$/i.test(steam[1]) ? '.js' : '.json';
              yield { path: logical.slice(0, -steam[0].length) + extension, bytes: _modloader_encryption.decrypt(bytes) };
            } else if (asset) {
              var suffix = /^rpgmvp$/i.test(asset[1]) ? '.png' : /^rpgmvo$/i.test(asset[1]) ? '.ogg' : '.m4a';
              yield { path: logical.slice(0, -asset[0].length) + suffix, bytes: _modloader_encryption.decryptAsset(Buffer.from(bytes)) };
            }
          }
        }
      }
      function adapt(path) {
        if (path === 'modloader/lib/rollup.js') {
          window._loadRollup = async function() { return (await host.importModule('modloader/lib/rollup.browser.js')).rollup; };
        } else if (path === 'modloader/lib/imagediff2.js') {
          var original = wasm_bindgen;
          var initialize = function(input) {
            if (typeof input === 'string') input = NativeHost.fs.readBytes(input.replace(/^\.\//, ''));
            return original(input);
          };
          Object.assign(initialize, original);
          wasm_bindgen = initialize;
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
        if (options.decrypted) {
          nw.App.argv = ['test'].concat(nw.App.argv.filter(function(argument) { return argument !== 'test'; }));
          var virtualFiles = PMJS.config.virtualFiles = PMJS.config.virtualFiles || {};
          virtualFiles.extensionAliases = Object.assign({}, virtualFiles.extensionAliases,
            { '.rpgmvp': '.png', '.rpgmvo': '.ogg', '.rpgmvm': '.m4a' });
        }
        else if (!nw.App.argv.length && options.encryptionKeyFile) nw.App.argv = ['--' + NativeHost.fs.readText(options.encryptionKeyFile).trim()];
        for (var script of host.scripts) {
          if (script.path) { NativeHost.runtime.loadScript(script.path); adapt(script.path); }
          else if (script.source.trim()) NativeHost.runtime.runScript(script.source);
        }
      } catch (error) { reject(error); }
    });
  };
})();
