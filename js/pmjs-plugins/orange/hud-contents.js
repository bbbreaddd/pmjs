'use strict';

(function() {
  var id = 'plugins.orange-hud.compact-contents';

  function install() {
    if (!PMJS.optimizations.isEnabled(id) || typeof Window_OrangeHud !== 'function' ||
        typeof OrangeHudDefaultLine === 'undefined' || typeof OrangeHudVariableIcon === 'undefined') return;
    var prototype = Window_OrangeHud.prototype;
    var reviewed = {
      refresh: { name: 'Window_OrangeHud.refresh', method: prototype.refresh, hash: 'e7466e3e6c5677d8cca3dc0ef6c99caca7bc18c9950b15d52ddf3ddbb7a2b24e' },
      hud: { name: 'Window_OrangeHud.drawHud', method: prototype.drawHud, hash: 'cc912db5761746c12877c758cc327d0be30d6938bed4512af509cb1cb42cf5df' },
      text: { name: 'Window_OrangeHud.drawTextEx', method: prototype.drawTextEx, hash: 'bb13fc2904c33710ef381e51b451fbd694a8b517d4f846fcb6007087c60dcf18' },
      line: { name: 'OrangeHudDefaultLine.drawLine', method: OrangeHudDefaultLine.drawLine, hash: '64568cb082e3f33f7a50c9dbe5c26e400292157a6142ce485683505ab0ebf2f1' },
      icon: { name: 'OrangeHudVariableIcon.drawLine', method: OrangeHudVariableIcon.drawLine, hash: '848307224df9db45d99389ca78c5adc4fdabaaf6776b74788ae0c0cda264e495' }
    };
    var mismatch = null;
    if (!Object.values(reviewed).every(function(record) {
      var recognized = PMJS.methods.matchesSource(record.method, record.hash);
      if (!recognized) mismatch = record.name;
      return recognized;
    })) {
      PMJS.optimizations.refuse(id, 'unrecognized HUD drawing pipeline', mismatch); return;
    }
    var originalRefresh = reviewed.refresh.method, originalIcon = prototype.drawIcon;
    var states = new WeakMap(), recording = new WeakMap();
    var styles = ['fontFace', 'fontSize', 'fontItalic', 'textColor', 'outlineColor',
      'outlineWidth', 'paintOpacity', '_allowTextTranslation'];
    var stats = { refreshes: 0, replacements: 0, fallbacks: 0 };
    function replace(window, state, width, height) {
      var old = window.contents, bitmap = new Bitmap(width, height);
      styles.forEach(function(key) { if (old[key] !== undefined) bitmap[key] = old[key]; });
      window.contents = bitmap;
      state.bitmap = bitmap;
      stats.replacements++;
    }
    function mark(window, x, y, width, height) {
      var bounds = recording.get(window);
      if (!bounds) return;
      if (![x, y, width, height].every(Number.isFinite) || width < 0 || height < 0) {
        bounds.unsupported = true; return;
      }
      bounds.right = Math.max(bounds.right, x + width);
      bounds.bottom = Math.max(bounds.bottom, y + height);
    }
    function drawText(text, x, y) {
      var result = reviewed.text.method.apply(this, arguments), bounds = recording.get(this);
      if (bounds) {
        if (typeof text !== 'string' || /[\\\x1b\r\n\f]/.test(text)) bounds.unsupported = true;
        else if (text) {
          var margin = Math.max(this.contents.fontSize, this.contents.outlineWidth * 2 + 2);
          mark(this, x, y, result + margin, Math.max(this.lineHeight(), this.contents.fontSize * 1.5) + margin);
        }
      }
      return result;
    }
    function drawIcon(_index, x, y) {
      var result = originalIcon.apply(this, arguments);
      mark(this, x, y, Window_Base._iconWidth, Window_Base._iconHeight);
      return result;
    }
    function supported(window) {
      return window.drawHud === reviewed.hud.method && window.drawTextEx === drawText && window.drawIcon === drawIcon &&
        Object.keys(OrangeHud._addons).every(function(key) {
          var addon = OrangeHud._addons[key];
          if (addon.params.some(function(line) { return !!line.ScriptPattern; })) return false;
          return key === 'OrangeHudLine' && addon.manager === OrangeHudDefaultLine && addon.manager.drawLine === reviewed.line.method ||
            key === 'OrangeHudVariableIcon' && addon.manager === OrangeHudVariableIcon && addon.manager.drawLine === reviewed.icon.method;
        });
    }
    prototype.drawTextEx = drawText;
    prototype.drawIcon = drawIcon;
    prototype.refresh = function() {
      if (!this.contents || recording.has(this)) return originalRefresh.apply(this, arguments);
      var state = states.get(this);
      if (!state || state.bitmap !== this.contents) {
        state = { bitmap: this.contents, width: this.contents.width, height: this.contents.height,
          layoutWidth: this.contentsWidth(), layoutHeight: this.contentsHeight(), grownWidth: 1, grownHeight: 1 };
        states.set(this, state);
      }
      if (state.layoutWidth !== this.contentsWidth() || state.layoutHeight !== this.contentsHeight()) {
        state.width = state.layoutWidth = Math.max(1, this.contentsWidth());
        state.height = state.layoutHeight = Math.max(1, this.contentsHeight());
        state.unsupported = true;
      }
      if (state.unsupported || this.contents.constructor !== Bitmap || !supported(this)) {
        if (this.contents.width !== state.width || this.contents.height !== state.height) replace(this, state, state.width, state.height);
        stats.fallbacks++;
        return originalRefresh.apply(this, arguments);
      }
      var bounds = { right: 1, bottom: 1, unsupported: false }, result;
      recording.set(this, bounds);
      try { result = originalRefresh.apply(this, arguments); }
      finally { recording.delete(this); }
      stats.refreshes++;
      if (bounds.unsupported) {
        state.unsupported = true;
        if (this.contents.width !== state.width || this.contents.height !== state.height) {
          replace(this, state, state.width, state.height);
          return originalRefresh.apply(this, arguments);
        }
        return result;
      }
      state.grownWidth = Math.max(state.grownWidth, Math.ceil(bounds.right));
      state.grownHeight = Math.max(state.grownHeight, Math.ceil(bounds.bottom));
      var width = Math.min(state.width, state.grownWidth), height = Math.min(state.height, state.grownHeight);
      if (width !== this.contents.width || height !== this.contents.height) {
        // Retained references to the previous contents remain valid.
        replace(this, state, width, height);
        return originalRefresh.apply(this, arguments);
      }
      return result;
    };
    PMJS.plugins.orangeHudContents = { diagnostics: function() { return Object.assign({}, stats); } };
  }
  PMJS.plugins.installOptimization('OrangeHud', {
    id: id, owner: 'pmjs-plugins/orange', fallback: 'authored HUD contents dimensions',
    phaseKey: 'pmjs.adapter.orange-hud-contents', phase: 'beforeBoot',
    install: install
  });
})();
