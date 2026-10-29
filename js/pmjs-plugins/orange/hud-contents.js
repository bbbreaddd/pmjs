'use strict';

(function() {
  var id = 'plugins.orange-hud.compact-contents';
  PMJS.plugins.registerOptimization('OrangeHud', {
    id: id, owner: 'pmjs-plugins/orange', fallback: 'authored HUD contents dimensions'
  });
  function install() {
    if (!PMJS.optimizations.isEnabled(id) || typeof Window_OrangeHud !== 'function' ||
        typeof OrangeHudDefaultLine === 'undefined' || typeof OrangeHudVariableIcon === 'undefined') return;
    var prototype = Window_OrangeHud.prototype;
    var crypto = __pmjsBuiltinRequire('node:crypto');
    var methods = [prototype.refresh, prototype.drawHud, prototype.drawTextEx,
      OrangeHudDefaultLine.drawLine, OrangeHudVariableIcon.drawLine];
    var hashes = ['e7466e3e6c5677d8cca3dc0ef6c99caca7bc18c9950b15d52ddf3ddbb7a2b24e',
      'cc912db5761746c12877c758cc327d0be30d6938bed4512af509cb1cb42cf5df',
      'bb13fc2904c33710ef381e51b451fbd694a8b517d4f846fcb6007087c60dcf18',
      '64568cb082e3f33f7a50c9dbe5c26e400292157a6142ce485683505ab0ebf2f1',
      '848307224df9db45d99389ca78c5adc4fdabaaf6776b74788ae0c0cda264e495'];
    if (!methods.every(function(method, index) {
      return typeof method === 'function' && crypto.createHash('sha256')
        .update(Function.prototype.toString.call(method).replace(/\r\n/g, '\n'))
        .digest('hex') === hashes[index];
    })) {
      PMJS.optimizations.refuse(id, 'unrecognized HUD drawing pipeline'); return;
    }
    var originalRefresh = methods[0], originalIcon = prototype.drawIcon;
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
      var result = methods[2].apply(this, arguments), bounds = recording.get(this);
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
      return window.drawHud === methods[1] && window.drawTextEx === drawText && window.drawIcon === drawIcon &&
        Object.keys(OrangeHud._addons).every(function(key) {
          var addon = OrangeHud._addons[key];
          if (addon.params.some(function(line) { return !!line.ScriptPattern; })) return false;
          return key === 'OrangeHudLine' && addon.manager === OrangeHudDefaultLine && addon.manager.drawLine === methods[3] ||
            key === 'OrangeHudVariableIcon' && addon.manager === OrangeHudVariableIcon && addon.manager.drawLine === methods[4];
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
  PMJS.plugins.onLoaded('OrangeHud', 'pmjs.adapter.orange-hud-contents', function() {
    PMJS.phases.on('beforeBoot', 'pmjs.adapter.orange-hud-contents', install);
  });
})();
