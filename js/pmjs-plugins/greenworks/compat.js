'use strict';
(function() {
  var noop = function() {};
  var steam = PMJS.config.steam || {};
  if (steam.provider !== 'portable') return;
  var names = ['greenworks', 'greenworks.js', './greenworks', './greenworks.js',
    './js/libs/greenworks', './js/libs/greenworks.js'];
  var initialized = false;
  function initialize() {
    try { pmjsAchievements.initialize(); initialized = true; return true; }
    catch (error) {
      if (typeof console !== 'undefined' && console.error) console.error(error);
      return false;
    }
  }
  function call(operation, success, failure) {
    try { var result = operation(); if (typeof success === 'function') success(result); return true; }
    catch (error) {
      if (typeof failure === 'function') failure(error);
      else if (typeof console !== 'undefined' && console.error) console.error(error);
      return false;
    }
  }
  var compat = {
    init: initialize, initAPI: initialize,
    isSteamRunning: function() { return initialized; },
    restartAppIfNecessary: function() { return false; },
    getAppId: function() { return steam.appId || 0; },
    getSteamId: function() { return { screenName: steam.screenName || '', steamId: steam.steamId || '0',
      accountId: steam.accountId || 0, isValid: initialized && steam.validSteamId === true }; },
    getCurrentUILanguage: function() { return steam.language || 'english'; },
    getCurrentGameLanguage: function() { return steam.language || 'english'; },
    getNumberOfAchievements: function() { return pmjsAchievements.names().length; },
    getAchievementNames: function() { return pmjsAchievements.names(); },
    getAchievement: function(id, success, failure) {
      var value = false, ok = call(function() { value = pmjsAchievements.isUnlocked(id); return value; }, success, failure);
      return ok ? value : false;
    },
    activateAchievement: function(id, success, failure) {
      return call(function() { pmjsAchievements.setUnlocked(id, true); return true; }, success, failure);
    },
    clearAchievement: function(id, success, failure) {
      return call(function() { pmjsAchievements.setUnlocked(id, false); return true; }, success, failure);
    },
    getStatInt: function(name) { return Math.trunc(pmjsAchievements.getStat(name)); },
    getStatFloat: function(name) { return pmjsAchievements.getStat(name); },
    setStat: function(name, value) { return call(function() { return pmjsAchievements.setStat(name, value); }); },
    storeStats: function(success, failure) {
      return call(function() { pmjsAchievements.flush(); return true; }, success, failure);
    },
    indicateAchievementProgress: function() { return true; },
    activateGameOverlay: noop, isGameOverlayEnabled: function() { return false; },
    activateGameOverlayToWebPage: noop, isSubscribedApp: function() { return false; },
    getDLCCount: function() { return 0; }, isDLCInstalled: function() { return false; },
    installDLC: noop, uninstallDLC: noop, isCloudEnabled: function() { return false; },
    isCloudEnabledForUser: function() { return false; }, getFriendCount: function() { return 0; },
    FriendFlags: { None: 0, Immediate: 4, All: 511 }, on: noop, once: noop,
    removeListener: noop, removeAllListeners: noop
  };
  globalThis.__pmjsGreenworksCompat = compat;
  registerCommonJsModule(names, compat);
})();
