;(function() {
  var keyFile = PMJS.config.omori && PMJS.config.omori.encryptionKeyFile;
  var encryptionKey;
  if (keyFile) {
    encryptionKey = NativeHost.fs.readText(keyFile);
    if (typeof encryptionKey !== 'string' || !/^[0-9a-f]{32}$/i.test(encryptionKey.trim())) {
      throw new Error('OMORI encryption key file must contain 32 hexadecimal characters');
    }
    encryptionKey = encryptionKey.trim();
    if (!NativeHost.runtime.omoriFiles) PMJS.phases.on('beforePlugins', 'port.omori.encrypted-plugins', function() {
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
  var nativeBufferSize = typeof MvNativeWebAudio !== 'undefined' && MvNativeWebAudio.prototype.bufferSize;
  if (nativeBufferSize) PMJS.methods.own({
    key: 'WebAudio.prototype.bufferSize', id: 'port.omori.audio-cache-size',
    getTarget: function() { return MvNativeWebAudio.prototype; },
    method: 'bufferSize',
    replace: function(original) {
      if (original === nativeBufferSize) return original;
      if (!PMJS.methods.matchesSource(original,
          '88ea258eb2c2ce3d2ac48916de659d1080e2552e27ccd1360bd799d9c8b09295')) {
        PMJS.compat.hit('omori.audio-cache-size', 'unrecognized audio cache accounting');
        return original;
      }
      return nativeBufferSize;
    }
  });

  function decryptIdentity() {
    return function(contents) { return contents; };
  }

  PMJS.plugins.onLoaded('GTP_CoreUpdates', 'port.omori.decrypt', function() {
    if (globalThis.Encryption) {
      if (encryptionKey) Encryption._key = encryptionKey;
      if (NativeHost.runtime.omoriFiles) Encryption.decrypt = NativeHost.runtime.omoriFiles.decodeText;
      else if (!encryptionKey) Encryption.decrypt = decryptIdentity();
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
    replace: function(original) {
      if (NativeHost.runtime.omoriFiles) return NativeHost.runtime.omoriFiles.decodeText;
      return encryptionKey ? original : decryptIdentity();
    }
  });
  PMJS.methods.own({
    key: 'Decrypter.decryptArrayBuffer',
    id: 'port.omori.decrypt-assets',
    getTarget: function() { return globalThis.Decrypter || null; },
    method: 'decryptArrayBuffer',
    replace: function(original) {
      var files = NativeHost.runtime.omoriFiles;
      if (!files) return original;
      return function(input) {
        var bytes = files.decodeMedia(input);
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      };
    }
  });
  PMJS.methods.own({
    key: 'saveNowYouKnow',
    id: 'port.omori.photo-album-export',
    getTarget: function() { return typeof globalThis.saveNowYouKnow === 'function' ? globalThis : null; },
    method: 'saveNowYouKnow',
    replace: function(original) {
      var files = NativeHost.runtime.omoriFiles;
      if (!files || !String(original).includes('nowyouknow.rpgmvp') || !String(original).includes('decryptRPGMV')) return original;
      return function() {
        window.require('fs').writeFileSync('nowyouknow.png', files.read('img/pictures/nowyouknow.png'));
      };
    }
  });
  PMJS.methods.own({
    key: 'BattleManager.getActorInputOrder',
    id: 'port.omori.actual-turn-order',
    getTarget: function() { return typeof BattleManager === 'undefined' ? null : BattleManager; },
    method: 'getActorInputOrder',
    replace: function(original) {
      if (!/\.sort\s*\(\s*\(\s*a\s*,\s*b\s*\)\s*=>\s*b\s*\[\s*1\s*\]\s*>\s*a\s*\[\s*1\s*\]\s*\)/.test(String(original))) return original;
      return function() {
        return $gameParty.members().map(function(actor, index) { return { actor: actor, index: index }; })
          .filter(function(member) { return member.actor.isAlive() && member.actor.isBattleMember(); })
          .sort(function(a, b) { return b.actor.agi - a.actor.agi; })
          .map(function(member) { return member.index; });
      };
    }
  });
})();
