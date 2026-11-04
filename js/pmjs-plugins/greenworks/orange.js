'use strict';

PMJS.plugins.onLoaded('OrangeGreenworks', 'pmjs.adapter.orange-greenworks', function() {
  var plugin = Hudell.OrangeGreenworks;
  if (!PMJS.methods.matchesSource(plugin.storeStats,
      'd45217042bfd56bf2e124ae34da13ea7a153155d86793c69ed6571a81cd35b1a')) {
    PMJS.compat.hit('plugins.orange-greenworks.store-stats', 'unrecognized OrangeGreenworks.storeStats');
    return;
  }
  plugin.storeStats = function() {
    if (!plugin.isSteamRunning()) return false;
    return plugin.greenworks.storeStats(plugin._storeStatsSuccess, plugin._storeStatsError);
  };
});
