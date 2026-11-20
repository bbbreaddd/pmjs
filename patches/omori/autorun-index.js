'use strict';
(function() {
  var id = 'omori.autorun-index';
  PMJS.optimizations.register({ id: id, owner: 'pmjs-omori', fallback: 'scan all common events in database order' });
  PMJS.phases.on('afterGuestPlugins', id, function() {
    if (!PMJS.optimizations.isEnabled(id)) return;
    var original = Game_Map.prototype.setupAutorunCommonEvent;
    if (!PMJS.methods.matchesSource(original,
        'a8a74a9b784ae7ec9e5e6e68d0e005aed7292a1c6228590052921b7bbd4ad56c')) {
      PMJS.optimizations.refuse(id, 'unrecognized autorun selector');
      return;
    }
    var modSources;
    try {
      var hash = __pmjsBuiltinRequire('node:crypto').createHash('sha256');
      var Buffer = __pmjsBuiltinRequire('node:buffer').Buffer;
      modSources = PMJS.omori && PMJS.omori.modSourceIdentity ? PMJS.omori.modSourceIdentity() : null;
      function source(file) {
        return Buffer.from(readGameBytes(file)).toString('utf8').replace(/\r\n/g, '\n');
      }
      hash.update(source('js/plugins.js'));
      $plugins.forEach(function(plugin) {
        if (plugin.status) hash.update((modSources && modSources.pluginNames[plugin.name] || plugin.name) + '\0')
          .update(source('js/plugins/' + plugin.name + '.js'));
      });
      if (modSources) hash.update('\0modloader\0' + modSources.digest);
      var digest = hash.digest('hex');
      if (![
        '84d5cde4540aa73b02d9e60fbaf636d229cc8957f9b9b28c0f00ece295591369',
        '3fa40da1c03a6bc5ec8b5406c20e81de2235bd3700329d98815eda1bf8a4b6bd',
        '49967111be0f44acf26094e21c3d23bd675a531e42b1b753f3bbaad4ce4b6e47',
        '5957dd220f5c03fae866667f2d804b0ba739a60e2570950777e02c915c7ad9e3'
      ].includes(digest)) {
        PMJS.optimizations.refuse(id, 'common event writer sources changed', { digest: digest });
        return;
      }
    } catch (_) {
      PMJS.optimizations.refuse(id, 'common event writer sources unavailable');
      return;
    }
    var database, length = -1, indices = [];
    Game_Map.prototype.setupAutorunCommonEvent = function() {
      if (modSources && !modSources.valid) {
        PMJS.optimizations.reportFallback(id, 'mod execution hooks changed');
        return original.apply(this, arguments);
      }
      var current = $dataCommonEvents;
      if (current !== database || current.length !== length) {
        if (!Array.isArray(current)) return original.apply(this, arguments);
        var next = [];
        for (var i = 0; i < current.length; i++) {
          if (current[i] && current[i].trigger === 1) next.push(i);
        }
        indices = next; database = current; length = current.length;
      }
      for (var index = 0; index < indices.length; index++) {
        var event = current[indices[index]];
        if (event && event.trigger === 1 && $gameSwitches.value(event.switchId)) {
          this._interpreter.setup(event.list);
          return true;
        }
      }
      return false;
    };
  });
})();
