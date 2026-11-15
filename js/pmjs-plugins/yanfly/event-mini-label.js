'use strict';

// Shared Yanfly Event Mini Label guard: YEP_EventMiniLabel
// Sprite_Character.setupMiniLabel constructs a Window_EventMiniLabel for
// every sprite without one, even when the current page carries no Mini
// Label directives.
// Classify the current page once via pageHasMiniLabel and skip construction
// while the page is untagged and no label exists. Every reader of
// sprite._miniLabel guards on falsy, so leaving it undefined for
// never-labeled pages is observationally identical. Labeled pages, page
// transitions, classifier errors, and unrecognized method shapes all take
// the original path.
(function() {

  // Reviewed YEP_EventMiniLabel 1.12 constructor path.
  var KNOWN_BODY = ['4886f405db38cab6ea5d26fe71570958ee508727837a9211637356519451fe43'];

  function defaultPageHasMiniLabel(character) {
    if (!character || !character._eventId || typeof character.list !== 'function') {
      return false;
    }
    if (typeof character.event === 'function') {
      var event = character.event();
      if (!event || !Array.isArray(event.pages) ||
          !event.pages[character._pageIndex]) return false;
    }
    var expression = /<(?:MINI WINDOW|MINI LABEL):[ ](.+)>/i;
    var list = character.list() || [];
    for (var i = 0; i < list.length; i++) {
      var command = list[i];
      if ((command.code === 108 || command.code === 408) &&
          expression.test(String(command.parameters && command.parameters[0] || ''))) {
        return true;
      }
    }
    return false;
  }

  function classify(character) {
    try {
      return defaultPageHasMiniLabel(character);
    } catch (error) {
      PMJS.optimizations.reportFallback('plugins.yanfly.event-mini-label',
        'event page classification failed', error);
      return null;
    }
  }

  function pageKey(character) {
    try {
      if (!character || typeof character.event !== 'function' ||
          typeof character.page !== 'function') return undefined;
      var event = character.event();
      if (!event || !Array.isArray(event.pages)) return undefined;
      return event.pages[character._pageIndex];
    } catch (error) {
      PMJS.optimizations.reportFallback('plugins.yanfly.event-mini-label',
        'event page lookup failed', error);
      return undefined;
    }
  }

  function install() {
    if (!PMJS.optimizations.isEnabled('plugins.yanfly.event-mini-label')) return false;

    var spriteProto = typeof Sprite_Character !== 'undefined' &&
      Sprite_Character.prototype ? Sprite_Character.prototype : null;
    if (!spriteProto || typeof spriteProto.setupMiniLabel !== 'function') {
      PMJS.optimizations.refuse('plugins.yanfly.event-mini-label',
        'Yanfly setupMiniLabel method unavailable');
      return false;
    }
    if (spriteProto.__pmjsMiniLabelCache) return true;
    if (!PMJS.methods.matchesSource(spriteProto.setupMiniLabel, KNOWN_BODY)) {
      PMJS.optimizations.refuse('plugins.yanfly.event-mini-label',
        'unrecognized Yanfly setupMiniLabel method composition');
      return false;
    }

    var original = spriteProto.setupMiniLabel;

    spriteProto.setupMiniLabel = function() {
      if (!this._miniLabel) {
        var key = pageKey(this._character);
        if (key !== undefined) {
          var state = this._pmjsMiniLabelState;
          if (!state || state.key !== key) {
            var tagged = classify(this._character);
            if (tagged === null) return original.apply(this, arguments);
            state = this._pmjsMiniLabelState = { key: key, tagged: tagged };
          }
          if (state.tagged === false) return;
        }
      }
      return original.apply(this, arguments);
    };

    spriteProto.setupMiniLabel._pmjsMiniLabelCacheGuard = true;
    spriteProto.__pmjsMiniLabelCache = true;

    return true;
  }

  PMJS.plugins.installOptimization('YEP_EventMiniLabel', {
    id: 'plugins.yanfly.event-mini-label',
    owner: 'plugins/yanfly/event-mini-label',
    fallback: 'construct Window_EventMiniLabel for every event without checking page tags',
    phaseKey: 'pmjs.adapter.yanfly-event-mini-label',
    install: install
  });
})();
