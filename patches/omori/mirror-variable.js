'use strict';
(function() {
  var id = 'omori.mirror-variable';
  PMJS.optimizations.register({ id:id, owner:'pmjs-omori', fallback:'ordinary variable writes' });
  PMJS.phases.on('afterGuestPlugins', id, function() {
    if (!PMJS.optimizations.isEnabled(id)) return;
    var original = Game_Variables.prototype.setValue, skipped = 0;
    Game_Variables.prototype.setValue = function(variableId, value) {
      if (variableId === 17 && Number.isInteger(value) && value >= 0 && value <= 8 && this._data[17] === value) {
        skipped++;
        return;
      }
      return original.apply(this, arguments);
    };
    PMJS.omoriMirrorVariable = { diagnostics:function() { return { skipped:skipped }; } };
  });
})();
