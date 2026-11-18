'use strict';
(function() {
  var id = 'omori.follower-actor';
  PMJS.optimizations.register({ id:id, owner:'pmjs-omori', fallback:'ordinary follower actor lookup' });
  PMJS.phases.on('afterGuestPlugins', id, function() {
    if (!PMJS.optimizations.isEnabled(id)) return;
    var original = Game_Follower.prototype.actor, skipped = 0;
    if (!PMJS.methods.matchesSource(original, '85d13f07c8f7453aae7b01a2e0f58c092eae021c56af301cd08e6a0312dacc3e') ||
        !PMJS.methods.matchesSource(Game_Party.prototype.battleMembers, 'a3bf83f0fa677fbec56a9a8bba8c380b86bb84e6054b1e4b5f8f222b9648cd40') ||
        !PMJS.methods.matchesSource(Game_Party.prototype.allMembers, 'd6e4ca463c403519abd77855cbc5b141d6629e4ca6de0ea99eb16b91031076ff')) {
      PMJS.optimizations.refuse(id, 'unrecognized follower membership');
      return;
    }
    Game_Follower.prototype.actor = function() {
      if (this._memberIndex >= $gameParty._actors.length) {
        skipped++;
        return undefined;
      }
      return original.apply(this, arguments);
    };
    PMJS.omoriFollowerActor = { diagnostics:function() { return { skipped:skipped }; } };
  });
})();
