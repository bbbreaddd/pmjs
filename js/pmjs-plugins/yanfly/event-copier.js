'use strict';

PMJS.plugins.onLoaded('YEP_EventCopier', 'pmjs.adapter.event-copier', function() {
  PMJS.phases.on('afterGuestPlugins', 'pmjs.adapter.event-copier', function() {
    var isMapLoaded = DataManager.isMapLoaded;
    DataManager.isMapLoaded = function() {
      // Event initialization never retries a copy whose template is still loading.
      if (!isMapLoaded.apply(this, arguments)) return false;
      return Object.keys(Yanfly.PreloadedMaps).every(function(id) {
        return !!Yanfly.PreloadedMaps[id];
      });
    };
  });
});

(function() {
  var id = 'plugins.yanfly.event-copier-preload';
  PMJS.plugins.registerOptimization('YEP_EventCopier', {
    id: id, owner: 'plugins/yanfly/event-copier', fallback: 'retain guest template map requests'
  });
  PMJS.phases.on('beforePlugins', id, function() {
    PMJS.plugins.interceptLoad('YEP_EventCopier', id, function(next) {
      if (!PMJS.optimizations.isEnabled(id)) return next();
      return next(function(source) {
        if (!PMJS.methods.matchesText(source, [
          'a79788cc022caf920b7de7cc7b4fd25a5c299a9f012d49f6b3ca037d219df430',
          '9e8452454a926079589ebec9e8f7647c66eacc796429e2afec2fad1208af7b48'
        ])) {
          PMJS.optimizations.refuse(id, 'unrecognized template map preload source');
          return source;
        }
        return source.replace('Yanfly.SetupParameters();', [
          '(function() {',
          '  var loadMapData = Yanfly.loadMapData;',
          '  var requested = new Set();',
          '  Yanfly.loadMapData = function(mapId) {',
          '    var key = mapId.clamp(1, 999);',
          '    if (requested.has(key)) return;',
          '    var result = loadMapData.apply(this, arguments);',
          '    requested.add(key);',
          '    return result;',
          '  };',
          '  try { Yanfly.SetupParameters(); }',
          '  finally { Yanfly.loadMapData = loadMapData; }',
          '})();'
        ].join('\n'));
      });
    });
  });
})();
