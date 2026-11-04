'use strict';

(function() {
  var id = 'omori.logic-timing';
  PMJS.plugins.registerOptimization('GTP_OmoriFixes', {
    id: id, owner: 'pmjs-omori', fallback: 'retain guest repeat timing'
  });

  PMJS.phases.on('afterGuestPlugins', id, function() {
    if (!PMJS.optimizations.isEnabled(id)) return;
    var manager = globalThis.SceneManager;
    var sources = ['f7bd76b11be965ea38a28a82c19ff331e4c924d02c37f9c57a904b31d540ef2a'];
    if (!manager || typeof manager.resume !== 'function' ||
        !PMJS.methods.matchesSource(manager.determineRepeatNumber, sources)) {
      PMJS.optimizations.refuse(id, 'unrecognized repeat timing or missing resume');
      return;
    }
    var debt = 0;
    var lastTime = null;
    PMJS.methods.wrap({
      key: 'SceneManager.determineRepeatNumber', id: id,
      getTarget: function() { return manager; }, method: 'determineRepeatNumber',
      wrap: function(original) {
        if (!PMJS.methods.matchesSource(original, sources)) {
          PMJS.optimizations.refuse(id, 'repeat timing changed after plugin setup');
          return original;
        }
        return function(deltaTime) {
          if (!Number.isFinite(deltaTime) || deltaTime < 0) {
            debt = 0;
            lastTime = null;
            return original.apply(this, arguments);
          }
          var now = performance.now();
          var total = debt + deltaTime;
          // Pixi caps deltaTime before dispatch; wall time still exposes long stalls.
          if ((lastTime !== null && now - lastTime >= 250) || total >= 15) {
            total = Math.min(total, 2);
          }
          lastTime = now;
          var steps = Math.min(2, Math.floor(total + 1e-7));
          debt = Math.max(0, total - steps);
          return steps;
        };
      }
    });
    PMJS.methods.wrap({
      key: 'SceneManager.resume', id: id,
      getTarget: function() { return manager; }, method: 'resume',
      wrap: function(original) {
        return function() {
          debt = 0;
          lastTime = null;
          return original.apply(this, arguments);
        };
      }
    });
  });
})();
