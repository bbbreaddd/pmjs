'use strict';

(function() {
  var id = 'plugins.yanfly.independent-item-search';
  PMJS.plugins.registerOptimization('YEP_ItemCore', {
    id: id, owner: 'plugins/yanfly/item-core', fallback: 'ordinary independent-item searches'
  });
  PMJS.phases.on('beforePlugins', id, function() {
    PMJS.plugins.interceptLoad('YEP_ItemCore', 'plugins/yanfly/item-core', function(next, context) {
      if (!PMJS.optimizations.isEnabled(id)) return next();
      var source = NativeHost.fs.readText(context.path);
      if (!source || !PMJS.methods.matchesText(source,
          '26a6f756bad0d7f606a3ec3251b6dea986e415c19dda6677a048ac7790df340e')) {
        PMJS.optimizations.refuse(id, 'unrecognized independent-item source');
        return next();
      }
      var marker = '/* pmjs: stop exhausted item search */';
      var newline = source.includes('\r\n') ? '\r\n' : '\n';
      var before = 'var target = $gameParty.getMatchingBaseItem(item, includeEquip);' + newline +
        '          if (target !== null) this.removeIndependentItem(target, includeEquip);';
      if (source.split(before).length !== 2) return next();
      return NativeHost.runtime.runScript(source.replace(before,
        'var target = $gameParty.getMatchingBaseItem(item, includeEquip);' + newline +
        '          if (target === null) break; ' + marker + newline +
        '          this.removeIndependentItem(target, includeEquip);'));
    });
  });
})();
