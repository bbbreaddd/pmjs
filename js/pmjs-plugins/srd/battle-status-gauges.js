'use strict';

(function() {
  var id = 'plugins.srd.battle-status-atb';
  PMJS.plugins.registerOptimization('SRD_BattleStatusCustomizer', {
    id: id, owner: 'pmjs-plugins/srd', fallback: 'authored complete battle status refresh'
  });

  // Exact reviewed drawing pipeline; unknown plugin compositions keep full refreshes.
  var knownMethods = {
    "refresh": "12f3f65a6f4325c0b64102976ca10653727f48865de7007ac382fab0e78df437",
    "drawItem": "bb6471d0e665817d51c21d6bd596541635b378ba58fc45bf0201ee4ae4d4e493",
    "drawAllImages": "67f7e85eaa88dfd1a938fe04f94f3e0dbd9cb833ae0b0b316ebf1354ac856e54",
    "drawAllTexts": "f46bc3ec932384c4a7ca497eaccb880d8f1b3fd09a7c5b043eb1812eb92154e3",
    "drawAllGauges": "b179edf14d74785a4632fd3ad535d1b62fb6945c672fd675fcb4d8af7d6e03ce",
    "drawBasicGauge": "cc83dc7fa2b960e8465e3f23ed0be9d5d6bb3e5dc1679545a5a429fad5fe899a",
    "drawGaugeUpgrade": "6c1a454402d1738caa29e93447d6a364f0036f93d0c8a08927027b763e3e8f81",
    "drawIcons": "f16041bc14f21d1237f4eef9670bd8f1c3803a59fd2e4e69d43a2af04a21b83b"
};
  var knownUpdates = ["ffd96184669de4d75cdbcd5ba90ccca6f0c5fa033941f1d020eead313f466154", "08c883b0fc84ea7a10655de81f00fde0b04ffde26ac66013291c2761625ce86a"];
  var knownConfig = {
    "faceX": "(boxWidth - 144) / 2",
    "faceY": "0",
    "faceWidth": "144",
    "faceHeight": "144",
    "iconX": "0",
    "iconY": "93",
    "iconWidth": "boxWidth",
    "iconScale": "1",
    "gaugeX": "0",
    "gaugeY": "0",
    "gaugeTextX": "x + 4",
    "gaugeTextY": "y + 5",
    "gaugeFont": "Gamefont",
    "gaugeFontSize": "18",
    "gaugeItalic": false,
    "gaugeTextColor": "#ffffff",
    "gaugeOutlineColor": "rgba(0, 0, 0, 0.5)",
    "gaugeOutlineWidth": 4
};
  var knownGauges = {
    "1": {
        "text": "TextManager.hpA",
        "cur": "actor.hp",
        "max": "actor.mhp",
        "x": "0",
        "y": "boxHeight - 42",
        "width": "boxWidth",
        "height": "23",
        "color1": "\"#CECECE\"",
        "color2": "this.hpGaugeColor2()",
        "back": "\"#000000\"",
        "cm": true
    },
    "5": {
        "text": "",
        "cur": "actor._atbSpeed",
        "max": "Math.max(5000, BattleManager.highestBaseAgi() * 100)",
        "x": "0",
        "y": "boxHeight - 32",
        "width": "boxWidth",
        "height": "10",
        "color1": "\"#393939\"",
        "color2": "\"#818181\"",
        "back": "\"#000000\"",
        "cm": false
    }
};
  var styles = ['fontFace', 'fontSize', 'fontBold', 'fontItalic', 'textColor',
    'outlineColor', 'outlineWidth', 'paintOpacity'];

  function matches(object, expected) {
    return object && Object.keys(expected).every(function(key) {
      var value = object[key];
      return (typeof value === 'string' ? value.trim() : value) === expected[key];
    });
  }
  function equal(a, b) {
    return a.length === b.length && a.every(function(value, index) { return value === b[index]; });
  }
  function state(window) {
    var actor = window._actor;
    // Status-counter offsets can extend over the bar. Keep their full draw order.
    if (actor.allIcons().length) return null;
    var face = ImageManager.loadFace(actor.faceName()), icons = ImageManager.loadSystem('IconSet');
    if (!face.isReady() || !icons.isReady() || face.width <= 0 || icons.width <= 0) return null;
    var values = [actor.hp, actor.mhp, actor.faceName(), actor.faceIndex(),
      window.hpGaugeColor2(), TextManager.hpA, window.lineHeight(),
      globalThis.Yanfly && Yanfly.Param && Yanfly.Param.BSCShowTurns];
    ['_states', '_stateTurns', '_stateCounter', '_buffs', '_buffTurns'].forEach(function(key) {
      var object = actor[key] || {};
      var keys = Object.keys(object);
      values.push(key, keys.length);
      keys.forEach(function(name) { values.push(name, object[name]); });
    });
    [face, icons, window.windowskin].filter(Boolean).forEach(function(bitmap) {
      var canvas = bitmap._canvas, image = bitmap._image;
      values.push(bitmap, bitmap.width, bitmap.height, canvas, canvas && canvas.__pmjsContentRevision,
        image, image && image._nativeImage && image._nativeImage.handle);
    });
    return values.concat(actor.allIcons());
  }

  function install() {
    if (!PMJS.optimizations.isEnabled(id)) return;
    var prototype = globalThis.Window_BattleStatusUpgrade && Window_BattleStatusUpgrade.prototype;
    var config = globalThis.SRD && SRD.BattleStatusCustomizer;
    var methods = {};
    var mismatch = null;
    if (!prototype || !config || !Object.keys(knownMethods).every(function(name) {
      var fn = prototype[name];
      if (typeof fn !== 'function') { mismatch = name; return false; }
      methods[name] = fn;
      var recognized = PMJS.methods.matchesSource(fn, knownMethods[name]);
      if (!recognized) mismatch = name;
      return recognized;
    })) {
      PMJS.optimizations.refuse(id, 'unrecognized battle status drawing pipeline', mismatch || 'Window_BattleStatusUpgrade/SRD.BattleStatusCustomizer');
      return;
    }
    var originalUpdate = prototype.updateRefreshes;
    if (typeof originalUpdate !== 'function' || !PMJS.methods.matchesSource(originalUpdate, knownUpdates)) {
      PMJS.optimizations.refuse(id, 'battle status refresh checks unavailable', 'updateRefreshes');
      return;
    }
    var cached = new WeakMap(), updating = new WeakSet();
    var helpers = {};
    ['drawActorFace', 'drawFace', 'drawActorIconsScale', 'drawActorIconsTurns',
      'drawIconScale', 'drawText', 'drawCurrentAndMax', 'systemColor', 'normalColor', 'textColor', 'hpGaugeColor2',
      'contentsWidth', 'contentsHeight', 'lineHeight'].forEach(function(name) {
      helpers[name] = prototype[name];
    });

    function eligible(window, previous) {
      var actor = window._actor, bitmap = window.contents;
      if (!previous || actor !== previous.actor || bitmap !== previous.bitmap ||
          window.windowskin !== previous.skin || window._redrawForLoad <= 4 ||
          !bitmap._canvas || bitmap._canvas.__pmjsContentRevision !== previous.revision ||
          !Number.isFinite(previous.revision) || bitmap.width !== previous.width || bitmap.height !== previous.height ||
          !equal(styles.map(function(key) { return bitmap[key]; }), previous.style) ||
          !supported(window) || window.lineHeight() !== 36 ||
          window.contentsWidth() !== bitmap.width || window.contentsHeight() !== bitmap.height ||
          globalThis.SRD.BattleStatusCustomizer !== config) return false;
      if (window._isMaster && (!previous.masterCanvas ||
          window._statusWindow.contents._canvas !== previous.masterCanvas ||
          previous.masterCanvas.__pmjsContentRevision !== previous.masterRevision)) return false;
      var current = state(window);
      return current && equal(current, previous.state);
    }

    function optimizedRefresh() {
      var actor = this._actor, bitmap = this.contents, dependency, hpCheck = false, iconCheck = false;
      // HP and icon changes return before configuration/state comparisons.
      var speedOnly = updating.has(this) && actor && this.updateRefreshes === optimizedUpdate;
      if (speedOnly) {
        var checks = this._checkForRefresh;
        speedOnly = Array.isArray(checks) && checks.length === 3;
        for (var i = 0; speedOnly && i < checks.length; i++) {
          var check = checks[i];
          if (!Array.isArray(check) || check.length !== 2) speedOnly = false;
          else if (check[1] === 'actor._atbSpeed' && !dependency) dependency = check;
          else if (check[1] === 'actor.hp' && !hpCheck) {
            hpCheck = true;
            speedOnly = check[0] === actor.hp;
          } else if (check[1] === 'actor.allIcons()' && !iconCheck) {
            iconCheck = true;
            speedOnly = Array.isArray(check[0]) && equal(check[0], actor.allIcons());
          } else speedOnly = false;
        }
      }
      var previous = speedOnly && cached.get(this);
      if (speedOnly && dependency && hpCheck && iconCheck && eligible(this, previous)) {
        var max = Math.max(5000, BattleManager.highestBaseAgi() * 100);
        var current = actor._atbSpeed;
        if (Number.isFinite(current) && Number.isFinite(max) && max > 0 && current >= 0 && current <= max) {
          var saved = styles.map(function(key) { return bitmap[key]; });
          try {
            // Opaque backing overwrites the previous fill. Use the original gradient
            // at its current width, preserving clipping and rasterizer dithering.
            methods.drawBasicGauge.call(this, '', 0, bitmap.height - 32, bitmap.width, 10,
              current, max, '#393939', '#818181', '#000000', false);
          } finally {
            styles.forEach(function(key, index) { bitmap[key] = saved[index]; });
            cached.delete(this);
          }
          dependency[0] = current;
          previous.revision = bitmap._canvas.__pmjsContentRevision;
          cached.set(this, previous);
          return;
        }
      }
      cached.delete(this);
      var result = methods.refresh.apply(this, arguments);
      remember(this);
      return result;
    }
    function supported(window) {
      var bitmap = window.contents, context = bitmap && bitmap._context;
      return bitmap && bitmap.paintOpacity === 255 && context && context.globalAlpha === 1 &&
        context.globalCompositeOperation === 'source-over' && context._clipPaths && !context._clipPaths.length &&
        equal(context._transform, [1, 0, 0, 1, 0, 0]) && window._useFace && window._useIcon &&
        !window._texts.length && equal(window._gauges, [1, 5]) &&
        config.texts && !config.texts[undefined] && !config.gauges[undefined] &&
        matches(config, knownConfig) && matches(config.gauges[1], knownGauges[1]) &&
        matches(config.gauges[5], knownGauges[5]) && !config.gauges[1].absorb && !config.gauges[5].absorb &&
        Object.keys(helpers).every(function(name) { return window[name] === helpers[name]; }) &&
        Object.keys(methods).every(function(name) { return window[name] === (name === 'refresh' ? optimizedRefresh : methods[name]); });
    }
    function remember(window) {
      var bitmap = window.contents;
      if (!window._actor || !bitmap || !bitmap._canvas) return;
      if (!supported(window)) {
        PMJS.optimizations.reportFallback(id, 'battle status layout, Canvas state or drawing methods unsupported');
        return;
      }
      var snapshot = state(window);
      if (!snapshot) return;
      var masterCanvas = window._isMaster && window._statusWindow.contents._canvas;
      cached.set(window, { actor: window._actor, bitmap: bitmap, skin: window.windowskin,
        revision: bitmap._canvas.__pmjsContentRevision, width: bitmap.width, height: bitmap.height,
        masterCanvas: masterCanvas, masterRevision: masterCanvas && masterCanvas.__pmjsContentRevision,
        style: styles.map(function(key) { return bitmap[key]; }), state: snapshot });
    }
    function optimizedUpdate() {
      updating.add(this);
      try { return originalUpdate.apply(this, arguments); }
      finally { updating.delete(this); }
    }
    prototype.refresh = optimizedRefresh;
    prototype.updateRefreshes = optimizedUpdate;
  }

  PMJS.plugins.onLoaded('SRD_BattleStatusCustomizer', 'pmjs.adapter.srd-battle-status-atb', function() {
    // Wrap refresh checks after adapters that stabilize icon-array comparisons.
    PMJS.phases.on('beforeBoot', 'pmjs.adapter.srd-battle-status-atb', install);
  });
})();
