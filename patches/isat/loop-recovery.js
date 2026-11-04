'use strict';

(function() {
  var id = 'isat.loop-recovery';
  var active = false, inspected = new WeakMap();
  PMJS.optimizations.register({ id: id, owner: 'pmjs-isat',
    fallback: 'authored per-level healing and actor refresh' });

  function methodMatches(method, expected) {
    return PMJS.methods.matchesSource(method, expected);
  }
  function matches(interpreter) {
    var event = globalThis.$dataCommonEvents && $dataCommonEvents[105];
    if (!event || event.name !== 'LOOP_PartyLvlsnSkills' ||
        !Array.isArray(event.list) || !Array.isArray(interpreter._list) ||
        event.list.length !== 245 || interpreter._list.length !== event.list.length ||
        $gameVariables.value(1) !== 1 || $gameVariables.value(2) !== 2) return false;
    var text;
    try { text = JSON.stringify(event.list); }
    catch (_) { return false; }
    if (!inspected.has(event.list)) inspected.set(event.list, {
      text: text,
      valid: [2, 3, 4].every(function(actor, i) {
        var reset = event.list[i], restore = event.list[11 + i];
        return reset && restore && reset.code === 315 && restore.code === 315 &&
          JSON.stringify(reset.parameters) === JSON.stringify([0, actor, 1, 0, 9999999, false]) &&
          JSON.stringify(restore.parameters) === JSON.stringify([0, actor, 0, 0, actor === 3 ? 112486 : 104287, false]);
      })
    });
    var reviewed = inspected.get(event.list);
    if (!reviewed.valid || reviewed.text !== text) return false;
    if (interpreter._list === event.list) return true;
    // JsonEx restores independent lists. Compare values without rebinding or resetting execution.
    try { return JSON.stringify(interpreter._list) === reviewed.text; }
    catch (_) { return false; }
  }

  PMJS.phases.on('afterGuestPlugins', 'pmjs.isat.loop-recovery', function() {
    if (!PMJS.optimizations.isEnabled(id)) return;
    var qualification = PMJS.isatSourceQualification;
    if (!qualification || qualification.verified !== true) {
      PMJS.optimizations.refuse(id, 'unqualified ISAT sources');
      return;
    }
    var actor = Game_Actor.prototype, interpreter = Game_Interpreter.prototype;
    var stress = globalThis.Olivia && Olivia.AntiPlayerStress;
    if (!stress || !methodMatches(actor.changeExp, '3dac5b8e3c39820e280b07824a16f3b48059fea943b085e2c810f0afdb6e0c62') ||
        !methodMatches(actor.levelUp, '918d2041d2ca50bb31c81a7091cd819836c1995223589a5082d97bdc2f0d17ae') ||
        !methodMatches(actor.levelUpRecover, '3d2700cd2772a2e9d6bc5c4cbcca5dd07d26a59eae01e9dfb06db201158f6f1f') ||
        !methodMatches(stress.___Game_Actor_levelUp___, 'add07b8c2c55f285642e3a6ab2421eaa2b19de0110a298c821903f0ac3ca23c5')) {
      PMJS.optimizations.refuse(id, 'unrecognized experience or level-recovery methods');
      return;
    }
    var command = interpreter.command315, changeExp = actor.changeExp;
    var levelUp = actor.levelUp, recover = actor.levelUpRecover;
    var levelUpAlias = stress.___Game_Actor_levelUp___;
    interpreter.command315 = function() {
      var previous = active;
      active = matches(this);
      try { return command.apply(this, arguments); }
      finally { active = previous; }
    };
    actor.changeExp = function(exp) {
      if (PMJS.isatSourceQualification !== qualification || !active || this._level !== 1 || [2, 3, 4].indexOf(this._actorId) < 0 ||
          !this._states || this._states.length || !(this._hp > 0) ||
          !(exp > this.currentExp()) || this._bypassLevelUpRecover ||
          this.levelUp !== levelUp || this.levelUpRecover !== recover ||
          stress.___Game_Actor_levelUp___ !== levelUpAlias) {
        return changeExp.apply(this, arguments);
      }
      var owned = Object.prototype.hasOwnProperty.call(this, '_bypassLevelUpRecover');
      var previous = this._bypassLevelUpRecover, result;
      this._bypassLevelUpRecover = true;
      try { result = changeExp.apply(this, arguments); }
      finally {
        if (owned) this._bypassLevelUpRecover = previous;
        else delete this._bypassLevelUpRecover;
      }
      // All level-up and skill-learning calls still run; publish only after recovery.
      if (this._level > 1) recover.call(this);
      return result;
    };
  });
})();
