'use strict';
(function() {
  var steam = (typeof pmjsGameConfig !== 'undefined' && pmjsGameConfig.steam) ||
    (globalThis.PMJS_GAME_CONFIG && globalThis.PMJS_GAME_CONFIG.steam) || {};
  if (steam.provider !== 'portable') return;
  function createClient(appId) {
    var effectiveAppId = appId || steam.appId || 0;
    return {
      achievement: {
        activate: function(id) { pmjsAchievements.setUnlocked(id, true); return true; },
        isActivated: function(id) { return pmjsAchievements.isUnlocked(id); },
        clear: function(id) { pmjsAchievements.setUnlocked(id, false); return true; },
        names: function() { return pmjsAchievements.names(); }
      },
      stats: {
        getInt: function(name) { return Math.trunc(pmjsAchievements.getStat(name)); },
        setInt: function(name, value) {
          pmjsAchievements.setStat(name, Math.trunc(value));
          return true;
        },
        store: function() { pmjsAchievements.flush(); return true; },
        resetAll: function(withAchievements) { return pmjsAchievements.resetStats(withAchievements); }
      },
      localplayer: {
        getName: function() { return steam.screenName || ''; },
        getSteamId: function() { return steam.steamId || '0'; },
        getLevel: function() { return 0; }
      },
      utils: { getAppId: function() { return effectiveAppId; } }
    };
  }
  var compat = {
    init: function(appId) { pmjsAchievements.initialize(); return createClient(appId); },
    restartAppIfNecessary: function() { return false; }, runCallbacks: function() {},
    electronEnableSteamOverlay: function() {}
  };
  globalThis.__pmjsSteamworksCompat = compat;
  registerCommonJsModule('steamworks.js', compat);
})();
