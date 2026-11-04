;(function() {
  var keyFile = PMJS.config.omori && PMJS.config.omori.encryptionKeyFile;
  var encryptionKey;
  if (keyFile) {
    encryptionKey = NativeHost.fs.readText(keyFile);
    if (typeof encryptionKey !== 'string' || !/^[0-9a-f]{32}$/i.test(encryptionKey.trim())) {
      throw new Error('OMORI encryption key file must contain 32 hexadecimal characters');
    }
    encryptionKey = encryptionKey.trim();
    PMJS.phases.on('beforePlugins', 'port.omori.encrypted-plugins', function() {
      var ordinaryLoad = PluginManager.loadScript;
      PluginManager.loadScript = function(name) {
          var source = (this._path + name).replace(/\.js$/i, '.OMORI');
          if (!NativeHost.fs.exists(source)) return ordinaryLoad.apply(this, arguments);
          var contents = NativeHost.fs.readBytes(source);
          var crypto = __pmjsBuiltinRequire('node:crypto');
          if (!contents || contents.length < 16) throw new Error('Truncated encrypted plugin: ' + source);
          var bytes = Buffer.from(contents);
          var decipher = crypto.createDecipheriv('aes-256-ctr', encryptionKey, bytes.subarray(0,16));
          var script = document.createElement('script');
          script.src = 'file:///game/' + source;
          script.textContent = Buffer.concat([decipher.update(bytes.subarray(16)), decipher.final()]).toString('utf8');
          return pmjsExecuteScriptElement(script);
      };
    });
  }
  function decryptIdentity() {
    return function(contents) { return contents; };
  }

  PMJS.plugins.onLoaded('GTP_CoreUpdates', 'port.omori.decrypt', function() {
    if (globalThis.Encryption) {
      if (encryptionKey) Encryption._key = encryptionKey;
      else Encryption.decrypt = decryptIdentity();
    }
  });

  PMJS.plugins.onLoaded('Aries001_AnimationScreenEffects',
    'port.omori.screen-effects-option', function() {
      PMJS.phases.on('afterGuestPlugins', 'port.omori.screen-effects-option',
        function() {
          var spriteset = globalThis.Spriteset_Base && Spriteset_Base.prototype;
          if (!spriteset) return;
          var createFilters = spriteset.createScreenEffectFilters;
          var update = spriteset.update;
          if (typeof createFilters !== 'function' || typeof update !== 'function') return;
          var filterNames = [
            '_ase_blur_filter', '_ase_zblur_filter', '_ase_glow_filter',
            '_ase_wave_filter', '_ase_dist_filter'
          ];
          function disableScreenEffects(target) {
            for (var index = 0; index < filterNames.length; index++) {
              var filter = target[filterNames[index]];
              if (filter) filter.enabled = false;
            }
          }
          spriteset.createScreenEffectFilters = function() {
            var result = createFilters.apply(this, arguments);
            if (!ConfigManager.screenEffectsEnabled) disableScreenEffects(this);
            return result;
          };
          spriteset.update = function() {
            var result = update.apply(this, arguments);
            if (!ConfigManager.screenEffectsEnabled) disableScreenEffects(this);
            return result;
          };
        });
    });

  PMJS.methods.own({
    key: 'Encryption.decrypt',
    id: 'port.omori.decrypt',
    getTarget: function() { return globalThis.Encryption || null; },
    method: 'decrypt',
    replace: function(original) { return encryptionKey ? original : decryptIdentity(); }
  });
})();
