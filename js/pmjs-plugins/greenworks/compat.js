'use strict';

(function() {
  var greenworksNoop = function() {};
  var steamConfig = (typeof pmjsGameConfig !== 'undefined' && pmjsGameConfig.steam) ||
    (globalThis.PMJS_GAME_CONFIG && globalThis.PMJS_GAME_CONFIG.steam) || null;

  var greenworksFiles = [
    'greenworks', 'greenworks.js', './greenworks', './greenworks.js',
    './js/libs/greenworks', './js/libs/greenworks.js'
  ];

  function isGreenworksRequestedOrPresent() {
    if (steamConfig) return true;
    if (typeof NativeHost !== 'undefined' && NativeHost.fs && typeof NativeHost.fs.exists === 'function') {
      var resolve = typeof gamePath === 'function' ? gamePath : function(p) { return p; };
      if (NativeHost.fs.exists(resolve('greenworks.js')) ||
          NativeHost.fs.exists(resolve('js/libs/greenworks.js'))) {
        return true;
      }
    }
    return false;
  }

  if (!isGreenworksRequestedOrPresent()) {
    return;
  }

  var greenworksCompat = {
    init: function() { return Boolean(steamConfig && steamConfig.init); },
    initAPI: function() { return Boolean(steamConfig && steamConfig.init); },
    isSteamRunning: function() { return Boolean(steamConfig && steamConfig.isSteamRunning); },
    restartAppIfNecessary: function() { return false; },
    getAppId: function() { return (steamConfig && steamConfig.appId) || 0; },
    getSteamId: function() {
      return {
        screenName: (steamConfig && steamConfig.screenName) || '',
        steamId: (steamConfig && steamConfig.steamId) || '0',
        accountId: (steamConfig && steamConfig.accountId) || 0,
        isValid: Boolean(steamConfig && (steamConfig.validSteamId || steamConfig.init))
      };
    },
    getCurrentUILanguage: function() { return (steamConfig && steamConfig.language) || 'english'; },
    getCurrentGameLanguage: function() { return (steamConfig && steamConfig.language) || 'english'; },
    getNumberOfAchievements: function() { return 0; },
    getAchievementNames: function() { return []; },
    getAchievement: function(name, callback) { if (typeof callback === 'function') callback(false); },
    activateAchievement: function(id, success) { if (typeof success === 'function') success(Boolean(steamConfig && steamConfig.enableAchievements)); },
    clearAchievement: function(id, success) { if (typeof success === 'function') success(); },
    getStatInt: function() { return 0; },
    getStatFloat: function() { return 0; },
    setStat: function() { return Boolean(steamConfig && steamConfig.enableStats); },
    storeStats: function(success) { if (typeof success === 'function') success(Boolean(steamConfig && steamConfig.enableStats)); },
    activateGameOverlay: greenworksNoop,
    isGameOverlayEnabled: function() { return Boolean(steamConfig && steamConfig.isGameOverlayEnabled); },
    activateGameOverlayToWebPage: greenworksNoop,
    isSubscribedApp: function() { return Boolean(steamConfig && (steamConfig.assumeSubscribed || steamConfig.isSubscribedApp)); },
    getDLCCount: function() { return 0; },
    isDLCInstalled: function() { return Boolean(steamConfig && steamConfig.allDLCInstalled); },
    installDLC: greenworksNoop,
    uninstallDLC: greenworksNoop,
    isCloudEnabled: function() { return false; },
    isCloudEnabledForUser: function() { return false; },
    getFriendCount: function() { return 0; },
    FriendFlags: { None: 0, Immediate: 4, All: 511 },
    on: greenworksNoop,
    once: greenworksNoop,
    removeListener: greenworksNoop,
    removeAllListeners: greenworksNoop
  };

  globalThis.__pmjsGreenworksCompat = greenworksCompat;

  if (typeof registerCommonJsModule === 'function') {
    try {
      registerCommonJsModule(greenworksFiles, greenworksCompat);
    } catch (_) {}
  }
})();
