'use strict';

(function() {
  var id = 'web.text-measurement-cache';
  var original = measureCanvasText;
  var nativeMeasure = NativeHost.canvas.measureTextMetrics;
  PMJS.optimizations.register({ id: id, owner: 'pmjs-web', fallback: 'ordinary Canvas text measurement' });
  PMJS.phases.on('afterGuestPlugins', id, function() {
    if (!PMJS.optimizations.isEnabled(id)) return;
    if (measureCanvasText !== original) {
      PMJS.optimizations.refuse(id, 'guest modified text measurement');
      return;
    }
    if (NativeHost.canvas.measureTextMetrics !== nativeMeasure) {
      PMJS.optimizations.refuse(id, 'native text measurement changed');
      return;
    }
    var entries = new Map(), hits = 0, misses = 0;
    function copy(value) { return Object.assign(Object.create(Object.getPrototypeOf(value)), value); }
    function measured(font, text, style) {
      if (text.length > 256 || NativeHost.canvas.measureTextMetrics !== nativeMeasure)
        return original(font, text, style);
      var key = JSON.stringify([font.paths, font.size, style, text]);
      if (key.length > 1024) return original(font, text, style);
      var value = entries.get(key);
      if (value) {
        hits++; entries.delete(key); entries.set(key, value); return copy(value);
      }
      misses++; value = original(font, text, style);
      if (value && typeof value === 'object' && Number.isFinite(value.width)) {
        entries.set(key, copy(value));
        if (entries.size > 512) entries.delete(entries.keys().next().value);
      }
      return value;
    }
    measureCanvasText = measured;
    PMJS.web.canvas.textMeasurements = { diagnostics: function() {
      return { installed: measureCanvasText === measured, hits: hits, misses: misses, entries: entries.size };
    } };
  });
})();
