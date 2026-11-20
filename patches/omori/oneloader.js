;(function() {
  var host = NativeHost.runtime.oneLoader;
  if (!host) return;
  PMJS.omori = PMJS.omori || {};
  var qualifiedSources;
  function hookSources() {
    var mods = Array.from($modLoader.knownMods.keys()).sort().map(function(id) {
      var mod = $modLoader.knownMods.get(id);
      if ((mod.json.asyncExec || []).some(function(script) { return script.runat === 'when_discovered'; }))
        throw new Error('discovery hooks are not qualified');
      return [id, mod.json];
    });
    var hooks = Object.keys($modLoader.$execScripts).sort().map(function(place) {
      return [place, $modLoader.$execScripts[place].map(function(script) { return [!!script.req, script.data]; })];
    });
    return JSON.stringify([mods, hooks]);
  }
  PMJS.omori.modSourceIdentity = function() {
    if (!globalThis.$modLoader || !$modLoader.knownMods) return null;
    if (qualifiedSources) return qualifiedSources;
    var hash = __pmjsBuiltinRequire('node:crypto').createHash('sha256');
    function add(name, input) {
      var bytes = Buffer.from(input);
      hash.update(JSON.stringify([name, bytes.length]) + '\n').update(bytes);
    }
    function directory(prefix) {
      NativeHost.fs.readDirectory(prefix).sort().forEach(function(name) {
        var file = prefix + '/' + name;
        if (NativeHost.fs.isDirectory(file)) directory(file);
        else if (/\.(?:[cm]?js|wasm)$/i.test(name)) {
          var bytes = readGameBytes(file);
          add(file, /\.wasm$/i.test(name) ? bytes : Buffer.from(bytes).toString('utf8').replace(/\r\n/g, '\n'));
        }
      });
    }
    directory('modloader');
    add('index-scripts', JSON.stringify(host.scripts));
    var hooks = hookSources(), names = Object.create(null);
    add('mod-hooks', hooks);
    for (var [id, mod] of $modLoader.knownMods) {
      if ((mod.json._flags || []).includes('randomize_plugin_name'))
        mod.plugins.forEach(function(file, index) {
          var name = file.replace(/\\/g, '/').split('/').pop().replace(/\.(?:js|omori)$/i, '');
          names[name] = '@' + id + '/' + index;
        });
    }
    var activePlugins = new Set($plugins.filter(function(plugin) { return plugin.status; })
      .map(function(plugin) { return ('js/plugins/' + plugin.name + '.js').toLowerCase(); }));
    var sources = new Map();
    for (var entry of $modLoader.knownMods.values()) {
      for (var file of entry.files || []) {
        var target = resolveGameFile(file.injectionPoint);
        if (!/\.(?:[cm]?js|omori|json|kel|aubrey|ya?ml|hero|pluto|html|txt|wasm)$/i.test(target) || activePlugins.has(target.toLowerCase())) continue;
        var stem = target.split('/').pop().replace(/\.(?:js|omori)$/i, '');
        sources.set(names[stem] ? '@plugin/' + names[stem] : target, target);
      }
    }
    Array.from(sources.keys()).sort().forEach(function(name) {
      var file = sources.get(name), bytes = readGameBytes(file);
      add('mod-file/' + name, /\.wasm$/i.test(file) ? bytes : Buffer.from(bytes).toString('utf8').replace(/\r\n/g, '\n'));
    });
    qualifiedSources = { digest: hash.digest('hex'), pluginNames: names, hooks: hooks, valid: true };
    return qualifiedSources;
  };
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
              if (qualifiedSources && qualifiedSources.valid) {
                try { qualifiedSources.valid = hookSources() === qualifiedSources.hooks; }
                catch (_) { qualifiedSources.valid = false; }
              }
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
