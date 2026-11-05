'use strict';

(function() {
  var id = 'plugins.yanfly.core-number-format';
  var localeString = Number.prototype.toLocaleString;
  var NumberFormat = Intl.NumberFormat;
  var formatGetter = Object.getOwnPropertyDescriptor(NumberFormat.prototype, 'format').get;
  PMJS.plugins.registerOptimization('YEP_CoreEngine', {
    id: id, owner: 'pmjs-plugins/yanfly', fallback: 'ordinary numeric locale formatting'
  });
  PMJS.plugins.onLoaded('YEP_CoreEngine', id, function() {
    PMJS.phases.on('afterGuestPlugins', id, function() {
      if (!PMJS.optimizations.isEnabled(id)) return;
      var original = Yanfly.Util.toGroup;
      var expected = ['dd7535c98792b225ccac00208f5db22411fde8d1ea79fbf5025b37c51756f850'];
      if (!PMJS.methods.matchesSource(original, expected)) {
        PMJS.optimizations.refuse(id, 'unrecognized numeric grouping method'); return;
      }
      var format, calls = 0;
      PMJS.plugins.numberFormat = { diagnostics: function() { return { formatted: calls }; } };
      Yanfly.Util.toGroup = function(value) {
        if (typeof value === 'string' || !Yanfly.Param.DigitGroup) return value;
        if (typeof value !== 'number' || Number.prototype.toLocaleString !== localeString ||
            Intl.NumberFormat !== NumberFormat) return original.apply(this, arguments);
        if (!format) format = formatGetter.call(new NumberFormat('en'));
        calls++;
        return format(value);
      };
    });
  });
})();
