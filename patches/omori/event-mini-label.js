'use strict';

(function() {
  var id = 'omori.event-mini-label';
  var KNOWN_SETUP = 'be2ba889d49dfa50e82f510ade4a906548a5c6cbb45b7660a239fbe750682005';
  var KNOWN_INNER = '4886f405db38cab6ea5d26fe71570958ee508727837a9211637356519451fe43';
  var KNOWN_LABEL = {
    setCharacter:'b1ea2864b07b3fd0656f89d9a2fdee00040a9808e48f83dad70acbca441d8631',
    gatherDisplayData:'5e70c813568af68a2c1acd36156f62b7298ba7169a1ae871dd211f14ee2ec8b1',
    extractNotedata:'0adafe72de12bb09833662668ee33a54a77afba2cff3463b491182175a407e87',
    setText:'5bd45d944f7ff6f9323dce7547083c3eff79111074b720c3dca4c655bb4b89f4',
    forceRefresh:'fc07bca3ad66b643f1d42d3b275c441e5f9259206b2f9ed1967679e1a8d89928'
  };
  var predecessor;
  PMJS.plugins.onLoading('GTP_OmoriFixes', id, function() {
    predecessor = globalThis.Sprite_Character && Sprite_Character.prototype.setupMiniLabel;
  });
  PMJS.plugins.installOptimization('GTP_OmoriFixes', {
    id:id, owner:'pmjs-omori', fallback:'retain guest mini-label setup',
    phaseKey:id, order:'module',
    install:function() {
      if (!PMJS.optimizations.isEnabled(id)) return;
      var prototype = globalThis.Sprite_Character && Sprite_Character.prototype;
      var windowPrototype = globalThis.Window_EventMiniLabel && Window_EventMiniLabel.prototype;
      var labels = PMJS.rpgmaker && PMJS.rpgmaker.eventMiniLabel;
      if (!prototype || !labels || !windowPrototype ||
          !Object.keys(KNOWN_LABEL).every(function(name) {
            return PMJS.methods.matchesSource(windowPrototype[name], KNOWN_LABEL[name]);
          }) ||
          !PMJS.methods.matchesSource(predecessor, KNOWN_INNER) ||
          !PMJS.methods.matchesSource(prototype.setupMiniLabel, KNOWN_SETUP)) {
        PMJS.optimizations.refuse(id, 'unrecognized delayed mini-label setup');
        return;
      }
      var original = prototype.setupMiniLabel;
      // Empty labels remain detached and never observe subsequent event pages.
      var guarded = labels.guardSetup(original, id, null, function(character) {
        return character && typeof character === 'object' ? this : undefined;
      });
      var delayed = function() {
        if (!this._miniLabel && !(this._labelDelay <= 0)) return original.apply(this, arguments);
        return guarded.apply(this, arguments);
      };
      prototype.setupMiniLabel = labels.guardSetup(delayed, id, function(character) {
        if (!character || typeof character.event !== 'function') return false;
        var data = character.event();
        return !data || !Array.isArray(data.pages) || data.pages.some(function(page) {
          return labels.listHasMiniLabel(page.list || []);
        });
      }, function(character) {
        return character && typeof character === 'object' ? character : undefined;
      });
    }
  });
})();
