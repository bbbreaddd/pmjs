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
  if (typeof PMJS !== 'undefined' && PMJS.optimizations &&
      typeof PMJS.optimizations.register === 'function') {
    PMJS.optimizations.register({
      id: 'plugins.yanfly.event-mini-label',
      owner: 'plugins/yanfly/event-mini-label',
      fallback: 'construct Window_EventMiniLabel for every event without checking page tags'
    });
  }

  function fnBody(fn) {
    var str = Function.prototype.toString.call(fn);
    var start = str.indexOf('{');
    var end = str.lastIndexOf('}');
    var body = start < 0 || end < 0 ? str : str.slice(start + 1, end);
    return body
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1 ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // YEP_EventMiniLabel setupMiniLabel body, whitespace/comment insensitive.
  var KNOWN_BODY = 'if (this._miniLabel) { ' +
    'if(this._miniLabel._text !== "") { ' +
    'if(!this._miniLabel.parent) { ' +
    'SceneManager._scene._spriteset.addChild(this._miniLabel); } } ' +
    'else if(this._miniLabel._text === "") { ' +
    'if(!!this._miniLabel.parent) { ' +
    'this._miniLabel.parent.removeChild(this._miniLabel); } } return; } ' +
    'if (!SceneManager._scene._spriteset) return; ' +
    'this._miniLabel = new Window_EventMiniLabel(); ' +
    'this._miniLabel.setCharacter(this._character); ' +
    'if(this._miniLabel._text === "") {return;} ' +
    'SceneManager._scene._spriteset.addChild(this._miniLabel);';

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

  var classifier = null;
  var classifierResolved = false;

  function classify(character) {
    if (!classifierResolved) {
      classifierResolved = true;
      try {
        var fastPaths = globalThis.__pmjsBuiltinRequire &&
          typeof NativeHost !== 'undefined' && NativeHost &&
          NativeHost.runtime &&
          typeof NativeHost.runtime.env === 'function' ?
          globalThis.__pmjsBuiltinRequire(
            NativeHost.runtime.env('PMJS_NATIVE_FASTPATHS')) : null;
        if (fastPaths && typeof fastPaths.pageHasMiniLabel === 'function') {
          classifier = fastPaths.pageHasMiniLabel;
        }
      } catch (_) { classifier = null; }
      if (!classifier) {
        classifier = defaultPageHasMiniLabel;
      }
    }
    if (!classifier) return null;
    try {
      return classifier(character) ? true : false;
    } catch (_) { return null; }
  }

  function pageKey(character) {
    try {
      if (!character || typeof character.event !== 'function' ||
          typeof character.page !== 'function') return undefined;
      var event = character.event();
      if (!event || !Array.isArray(event.pages)) return undefined;
      return event.pages[character._pageIndex];
    } catch (_) { return undefined; }
  }

  function isOptimizationEnabled() {
    if (typeof pmjsOptimizationEnabled === 'function') {
      if (!pmjsOptimizationEnabled('plugins.yanfly.event-mini-label')) return false;
    }
    try {
      if (typeof NativeHost !== 'undefined' && NativeHost &&
          NativeHost.runtime &&
          typeof NativeHost.runtime.env === 'function') {
        if (NativeHost.runtime.env('PMJS_YEP_MINI_LABEL') === '0') {
          return false;
        }
      }
    } catch (_) {}
    return true;
  }

  function install() {
    if (!isOptimizationEnabled()) return false;

    var spriteProto = typeof Sprite_Character !== 'undefined' &&
      Sprite_Character.prototype ? Sprite_Character.prototype : null;
    if (!spriteProto || spriteProto.__pmjsMiniLabelCache ||
        typeof spriteProto.setupMiniLabel !== 'function' ||
        fnBody(spriteProto.setupMiniLabel) !== KNOWN_BODY) return false;

    var original = spriteProto.setupMiniLabel;
    var negative = { key: null, fresh: false };

    spriteProto.setupMiniLabel = function() {
      if (!this._miniLabel) {
        var key = pageKey(this._character);
        if (key !== undefined) {
          if (!negative.fresh || negative.key !== key) {
            var tagged = classify(this._character);
            if (tagged === null) return original.apply(this, arguments);
            negative = { key: key, fresh: true, tagged: tagged };
          }
          if (negative.tagged === false) return;
        }
      }
      return original.apply(this, arguments);
    };

    spriteProto.setupMiniLabel._pmjsMiniLabelCacheGuard = true;
    spriteProto.__pmjsMiniLabelCache = true;

    return true;
  }

  install();

  if (typeof globalThis.pmjsRegisterHook === 'function') {
    globalThis.pmjsRegisterHook('pluginLoaded', function(name) {
      if (name === 'YEP_EventMiniLabel') install();
    });
    globalThis.pmjsRegisterHook('beforeBoot', install);
  }

  globalThis.pmjsInstallEventMiniLabelFastPath = install;
})();
