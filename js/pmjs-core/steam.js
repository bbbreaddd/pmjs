'use strict';

(function() {
  var config = PMJS.config.steam || {};
  if (config.provider !== 'portable') return;
  var storage = NativeHost.storage;
  var initialized = false, profile = null, cloud = null;
  var events = new (globalThis.__pmjsBuiltinRequire('events').EventEmitter)();
  var quota = 1024 * 1024 * 1024;

  function unavailable(service) {
    var error = new Error(service + ' is unavailable in the local Steam provider');
    error.code = 'ERR_STEAM_UNAVAILABLE';
    return error;
  }
  function complete(callback, args) {
    if (typeof callback === 'function') PMJS.tasks.enqueue(function() {
      callback.apply(undefined, args);
    }, { errorMode: 'event' });
  }
  function call(operation, success, failure, resultArguments) {
    var result;
    try { result = operation(); }
    catch (error) {
      if (typeof failure === 'function') complete(failure, [error]);
      else console.error('[pmjs] local Steam operation failed:', error);
      return { ok: false };
    }
    complete(success, resultArguments ? resultArguments(result) : []);
    return { ok: true, value: result };
  }
  function readJson(name) {
    var text = storage.readText(name);
    return text === null ? null : JSON.parse(text);
  }
  function writeJson(name, value) { storage.writeText(name, JSON.stringify(value, null, 2) + '\n'); }
  function getProfile() {
    if (!profile) {
      var next = readJson('steam-profile.json');
      if (!next) {
        var bytes = globalThis.__pmjsBuiltinRequire('crypto').randomBytes(4);
        var accountId = bytes.readUInt32LE(0) || 1;
        next = { screenName: 'Offline Player', accountId: accountId,
          steamId: String(76561197960265728n + BigInt(accountId)), level: 0 };
        writeJson('steam-profile.json', next);
      }
      if (!Number.isInteger(next.accountId) || next.accountId <= 0 ||
          !/^\d+$/.test(String(next.steamId)) || typeof next.screenName !== 'string') {
        throw new Error('invalid local Steam profile');
      }
      profile = next;
    }
    var value = Object.assign({}, profile);
    ['screenName', 'steamId', 'accountId', 'level', 'staticAccountId'].forEach(function(key) {
      if (config[key] !== undefined) value[key] = config[key];
    });
    if (value.staticAccountId === undefined) value.staticAccountId = value.accountId;
    return value;
  }
  function steamId() {
    var user = getProfile();
    var staticKey = config.staticAccountId === undefined
      ? String(BigInt(user.steamId) & ~(0xfffffn << 32n)) : String(config.staticAccountId);
    return Object.assign({}, user, {
      isValid: config.validSteamId !== false,
      getPersonaName: function() { return user.screenName; },
      getAccountID: function() { return user.accountId; },
      getRawSteamID: function() { return user.steamId; },
      getStaticAccountKey: function() { return staticKey; },
      getSteamLevel: function() { return user.level; }
    });
  }
  function cloudState() {
    if (!cloud) {
      var next = readJson('steam-cloud.json') || { enabled: true };
      if (typeof next.enabled !== 'boolean') throw new Error('invalid local Steam cloud state');
      cloud = next;
    }
    return cloud;
  }
  function cloudPath(name) {
    if (typeof name !== 'string' || !name || name.indexOf('\0') >= 0 ||
        /^[\\/]/.test(name) || name.replace(/\\/g, '/').split('/').some(function(part) {
          return part === '..' || part === '.' || part === '';
        })) throw new TypeError('invalid Steam cloud filename');
    return 'steam-cloud/files/' + name.replace(/\\/g, '/');
  }
  function cloudStat(name) {
    try { return storage.stat(name); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  function cloudFiles() {
    var result = [];
    function visit(directory, prefix) {
      (storage.readDirectory(directory) || []).forEach(function(name) {
        var relative = directory + '/' + name;
        if (storage.isDirectory(relative)) visit(relative, prefix + name + '/');
        else result.push({ name: prefix + name, size: storage.stat(relative).size });
      });
    }
    visit('steam-cloud/files', '');
    return result.sort(function(a, b) { return a.name.localeCompare(b.name); });
  }
  function initialize() {
    if (initialized) return true;
    getProfile();
    cloudState();
    pmjsAchievements.initialize();
    initialized = true;
    return true;
  }
  globalThis.pmjsSteam = {
    initialize: initialize,
    get initialized() { return initialized; },
    profile: getProfile, steamId: steamId, events: events,
    call: call, complete: complete, unavailable: unavailable,
    flush: function() { if (pmjsAchievements.initialized) pmjsAchievements.flush(); },
    cloud: {
      enabled: function() { return cloudState().enabled; },
      accountEnabled: function() { return true; },
      enable: function(enabled) {
        var next = { enabled: !!enabled };
        writeJson('steam-cloud.json', next);
        cloud = next;
      },
      read: function(name) {
        if (!cloudState().enabled) throw unavailable('Cloud files');
        var contents = storage.readText(cloudPath(name));
        if (contents === null) throw Object.assign(new Error('Cloud file not found: ' + name), { code: 'ENOENT' });
        return contents;
      },
      write: function(name, contents) {
        if (!cloudState().enabled) throw unavailable('Cloud files');
        var target = cloudPath(name), text = String(contents);
        var old = cloudStat(target);
        var used = cloudFiles().reduce(function(total, file) { return total + file.size; }, 0);
        if (used - (old ? old.size : 0) + Buffer.byteLength(text) > quota) {
          throw Object.assign(new Error('Local cloud quota exceeded'), { code: 'ENOSPC' });
        }
        storage.writeText(target, text);
      },
      remove: function(name) {
        if (!cloudState().enabled) throw unavailable('Cloud files');
        var target = cloudPath(name);
        if (cloudStat(target) === null) throw Object.assign(new Error('Cloud file not found: ' + name), { code: 'ENOENT' });
        storage.remove(target);
      },
      files: cloudFiles,
      quota: function() {
        var used = cloudFiles().reduce(function(total, file) { return total + file.size; }, 0);
        return [String(quota), String(Math.max(0, quota - used))];
      }
    }
  };
})();
