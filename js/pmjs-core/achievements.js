'use strict';

(function() {
  var FILE = 'achievements.json';
  var VERSION = 1;
  function own(object, key) { return Object.prototype.hasOwnProperty.call(object, key); }
  function progress(value) {
    return value && typeof value.stat === 'string' && value.stat &&
      typeof value.target === 'number' && isFinite(value.target)
      ? { stat: value.stat, target: value.target } : null;
  }
  function achievement(id, value) {
    value = value && typeof value === 'object' ? value : {};
    return {
      name: typeof value.name === 'string' && value.name ? value.name : id,
      description: typeof value.description === 'string' ? value.description : '',
      hidden: value.hidden === true,
      icon: typeof value.icon === 'string' && value.icon ? value.icon : null,
      progress: progress(value.progress),
      unlocked: value.unlocked === true,
      unlockedAt: value.unlocked === true && typeof value.unlockedAt === 'string'
        ? value.unlockedAt : null
    };
  }
  function createPortableAchievements(options) {
    options = options || {};
    var storage = options.storage;
    var catalog = Array.isArray(options.catalog) ? options.catalog : [];
    var now = options.now || function() { return new Date().toISOString(); };
    var nowMs = options.nowMilliseconds || function() { return Date.now(); };
    var warn = options.warn || function(message) {
      if (typeof console !== 'undefined' && console.warn) console.warn(message);
    };
    var state = null;
    var dirty = false;
    if (!storage || typeof storage.readText !== 'function' || typeof storage.writeText !== 'function')
      throw new Error('portable achievements require NativeHost.storage');
    function empty() { return { schemaVersion: VERSION, achievements: {}, stats: {} }; }
    function mergeCatalog(target) {
      var changed = false;
      catalog.forEach(function(configured) {
        if (!configured || typeof configured.id !== 'string' || !configured.id) {
          warn('Ignoring achievement catalog entry without a non-empty id'); return;
        }
        var id = configured.id;
        var previous = own(target.achievements, id) ? achievement(id, target.achievements[id]) : achievement(id, {});
        var merged = achievement(id, Object.assign({}, previous, configured, {
          unlocked: previous.unlocked, unlockedAt: previous.unlockedAt
        }));
        if (JSON.stringify(target.achievements[id]) !== JSON.stringify(merged)) changed = true;
        target.achievements[id] = merged;
      });
      return changed;
    }
    function normalize(parsed) {
      if (!parsed || parsed.schemaVersion !== VERSION || !parsed.achievements ||
          typeof parsed.achievements !== 'object' || Array.isArray(parsed.achievements) ||
          !parsed.stats || typeof parsed.stats !== 'object' || Array.isArray(parsed.stats))
        throw new Error('unsupported achievements file schema');
      var result = empty();
      Object.keys(parsed.achievements).forEach(function(id) {
        result.achievements[id] = achievement(id, parsed.achievements[id]);
      });
      Object.keys(parsed.stats).forEach(function(name) {
        var value = parsed.stats[name];
        if (typeof value === 'number' && isFinite(value)) result.stats[name] = value;
      });
      return result;
    }
    function clone(value) { return JSON.parse(JSON.stringify(value)); }
    function persist(value) { storage.writeText(FILE, JSON.stringify(value, null, 2) + '\n'); }
    function initialize() {
      if (state) return state;
      var text = storage.readText(FILE);
      var write = text === null || typeof text === 'undefined';
      var next;
      if (write) next = empty();
      else try { next = normalize(JSON.parse(text)); }
      catch (error) {
        if (typeof storage.rename === 'function') {
          var base = FILE + '.corrupt-' + nowMs();
          var backup = base;
          var suffix = 1;
          while (typeof storage.exists === 'function' && storage.exists(backup))
            backup = base + '-' + suffix++;
          storage.rename(FILE, backup); warn('Preserved unreadable achievements data as ' + backup);
        }
        warn('Rebuilding achievements data: ' + error.message); next = empty(); write = true;
      }
      if (mergeCatalog(next)) write = true;
      if (write) persist(next);
      state = next;
      dirty = false;
      return state;
    }
    function validateId(id) {
      if (typeof id !== 'string' || !id) throw new TypeError('achievement id must be a non-empty string');
    }
    function names() { initialize(); return Object.keys(state.achievements); }
    function isUnlocked(id) {
      validateId(id); initialize();
      return own(state.achievements, id) && state.achievements[id].unlocked;
    }
    function setUnlocked(id, unlocked) {
      validateId(id); initialize();
      var learned = !own(state.achievements, id);
      var desired = unlocked === true;
      if (!learned && state.achievements[id].unlocked === desired) return false;
      var next = clone(state);
      if (learned) next.achievements[id] = achievement(id, {});
      next.achievements[id].unlocked = desired;
      next.achievements[id].unlockedAt = desired ? now() : null;
      persist(next);
      state = next;
      dirty = false;
      return true;
    }
    function getStat(name) {
      if (typeof name !== 'string' || !name) throw new TypeError('stat name must be a non-empty string');
      initialize(); return own(state.stats, name) ? state.stats[name] : 0;
    }
    function setStat(name, value) {
      if (typeof name !== 'string' || !name) throw new TypeError('stat name must be a non-empty string');
      if (typeof value !== 'number' || !isFinite(value)) throw new TypeError('stat value must be finite');
      initialize();
      if (own(state.stats, name) && state.stats[name] === value) return false;
      var next = clone(state);
      var unlockedAchievement = false;
      next.stats[name] = value;
      Object.keys(next.achievements).forEach(function(id) {
        var entry = next.achievements[id];
        if (!entry.unlocked && entry.progress && entry.progress.stat === name && value >= entry.progress.target) {
          entry.unlocked = true; entry.unlockedAt = now();
          unlockedAchievement = true;
        }
      });
      if (unlockedAchievement) {
        persist(next);
        dirty = false;
      } else {
        dirty = true;
      }
      state = next;
      return true;
    }
    function resetStats(clearAchievements) {
      initialize();
      var next = clone(state);
      next.stats = {};
      if (clearAchievements === true) Object.keys(next.achievements).forEach(function(id) {
        next.achievements[id].unlocked = false; next.achievements[id].unlockedAt = null;
      });
      state = next;
      dirty = true;
      return true;
    }
    function flush() {
      initialize();
      if (!dirty) return false;
      persist(state);
      dirty = false;
      return true;
    }
    return { initialize: initialize, names: names, isUnlocked: isUnlocked,
      setUnlocked: setUnlocked, getStat: getStat, setStat: setStat,
      resetStats: resetStats, flush: flush };
  }
  globalThis.createPortableAchievements = createPortableAchievements;
  var config = (typeof pmjsGameConfig !== 'undefined' && pmjsGameConfig.achievements) ||
    (globalThis.PMJS_GAME_CONFIG && globalThis.PMJS_GAME_CONFIG.achievements) || {};
  globalThis.pmjsAchievements = createPortableAchievements({ storage: NativeHost.storage, catalog: config.catalog });
})();
