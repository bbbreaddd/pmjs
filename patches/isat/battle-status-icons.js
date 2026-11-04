'use strict';

(function() {
  var id = 'isat.battle-status-icons';
  PMJS.optimizations.register({
    id: id,
    owner: 'pmjs-isat',
    fallback: 'authored battle status refresh checks'
  });

  PMJS.phases.on('afterGuestPlugins', 'pmjs.isat.battle-status-icons', function() {
    if (!PMJS.optimizations.isEnabled(id)) return;
    var qualification = PMJS.isatSourceQualification;
    if (!qualification || qualification.verified !== true) {
      PMJS.optimizations.refuse(id, qualification && qualification.reason || 'unqualified battle status sources');
      return;
    }
    var status = globalThis.Window_BattleStatusUpgrade;
    var prototype = status && status.prototype;
    var update = prototype && prototype.updateRefreshes;
    var drawIcons = prototype && prototype.drawActorIconsScale;
    if (!PMJS.methods.matchesSource(update, 'ffd96184669de4d75cdbcd5ba90ccca6f0c5fa033941f1d020eead313f466154') ||
        !PMJS.methods.matchesSource(drawIcons, '5079c41aea8d86f452570edc42bfd1d5463dca629bf0e68eb3dafc34578ee1d1')) {
      PMJS.optimizations.refuse(id, 'unrecognized battle status icon refresh');
      return;
    }

    prototype.updateRefreshes = function() {
      var actor = this._actor;
      var length = this._checkForRefresh.length;
      for (var i = 0; i < length; i++) {
        var info = this._checkForRefresh[i];
        var current = eval(info[1]);
        if (info[0] === current) continue;
        if (info[1] === 'actor.allIcons()' &&
            Array.isArray(info[0]) && Array.isArray(current) &&
            info[0].length === current.length &&
            info[0].every(function(icon, index) { return icon === current[index]; })) {
          continue;
        }
        this.refresh();
        break;
      }
    };
  });
})();
