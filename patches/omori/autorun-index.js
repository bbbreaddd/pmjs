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
    try {
      var hash = __pmjsBuiltinRequire('node:crypto').createHash('sha256');
      var Buffer = __pmjsBuiltinRequire('node:buffer').Buffer;
      function source(file) {
        return Buffer.from(NativeHost.fs.readBytes(file)).toString('utf8').replace(/\r\n/g, '\n');
      }
      hash.update(source('js/plugins.js'));
      $plugins.forEach(function(plugin) {
        if (plugin.status) hash.update(plugin.name + '\0').update(source('js/plugins/' + plugin.name + '.js'));
      });
      if (hash.digest('hex') !== '84d5cde4540aa73b02d9e60fbaf636d229cc8957f9b9b28c0f00ece295591369') {
        PMJS.optimizations.refuse(id, 'common event writer sources changed');
        return;
      }
    } catch (_) {
      PMJS.optimizations.refuse(id, 'common event writer sources unavailable');
      return;
    }
    var database, length = -1, indices = [];
    Game_Map.prototype.setupAutorunCommonEvent = function() {
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
