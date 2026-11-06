'use strict';

(function() {
  var stats = { skipped: 0, ordinary: 0 };
  var installed = false;
  function install() {
    if (installed) return true;
    if (!PMJS.optimizations.isEnabled('tilemap.yed-indexed-paint-loops') ||
        typeof Tilemap !== 'function' || typeof Sprite_Base !== 'function' ||
        typeof Sprite !== 'function' || !globalThis.Olivia || !Olivia.HorrorEffects) return false;
    var base = Sprite_Base.prototype, sprite = Sprite.prototype;
    var methods = [
      [base, 'update', 'fd9d2f86de93fece0c102aac5e1bb5aec263509403dc05be6d099db79a97f263'],
      [base, 'updateVisibility', '2c3e4c95bd9c9c047755085370a835ac99d5eee56c5a30e10512d80f95efa1c7'],
      [base, 'updateAnimationSprites', '30575574c798ac1d0086edb495a72ab561e65d4ae6090978004e1ed1a426a2fd'],
      [sprite, 'update', 'afc0c175fbd5adfb4ffc57345ca0aea27ec1338fe74789c2c3599dca1c001594'],
      [sprite, 'synchronizeHorrorFiltersWithSource', 'e97a11a96fdaba2f99bfc3e769ab7dd15f7d9c152062c59a2654576da596b7ea'],
      [sprite, 'updateHorrorEffects', '9260befd5b45556ad2fa3d618ba31a782c7b84396828aad1f27a2839d2f270fe'],
      [sprite, 'updateHorrorNoise', ['5886848c86d64f40d6342cd985179c8d0f328e8d4231011f044ebcd3b8c2d686', '39ecec355e2ba9f146be450dc1db0e3383f1f8145e99bae4aa607fcb3427d751']],
      [sprite, 'updateHorrorGlitch', ['1dfffbc540671e82481f9d99431290422c72a8c1b036a25c68e52708457b406c', 'e9cd9bde2e143ff995b921da4afdaf4f1f580f2fa6340888a36e7536f5e20ea6']],
      [sprite, 'updateHorrorTV', ['f5469ca6d318fe389e00824aa5daf6f698f3e4a300b21a79372910c5434f2254', '16f0ea220202863bd97b9004f9e0645091724d5c16fd1872c1fb04057b56bd50']],
      [Olivia.HorrorEffects, '___Sprite_update___', 'ed434d771eafc138202664abed6f2c0f86e3142910c285bf9ca7efdbabf4d4ef']
    ];
    var original = Tilemap.prototype.update;
    if (!PMJS.methods.matchesSource(original, '2eeca0f4f55a476574b190fb2617db7f37a2a38df7657325ce551dc3e92164e7') ||
        !methods.every(function(entry) { return PMJS.methods.matchesSource(entry[0][entry[1]], entry[2]); })) return false;
    methods.forEach(function(entry) { entry[3] = entry[0][entry[1]]; });
    var pools = new WeakMap();
    Tilemap.prototype.update = function() {
      var pool = this._priorityTiles;
      if (!Array.isArray(pool) || !Array.isArray(this.children) || !Array.isArray(this.bitmaps) ||
          Sprite.prototype !== sprite || Sprite_Base.prototype !== base ||
          !globalThis.Olivia || Olivia.HorrorEffects !== methods[9][0] ||
          !PMJS.optimizations.isEnabled('tilemap.yed-indexed-paint-loops') ||
          !methods.every(function(entry) { return entry[0][entry[1]] === entry[3]; })) {
        return original.apply(this, arguments);
      }
      var entry = pools.get(pool);
      if (!entry || entry.length !== pool.length) {
        var members = new WeakSet();
        for (var memberIndex = 0; memberIndex < pool.length; memberIndex++) {
          if (pool[memberIndex] && typeof pool[memberIndex] === 'object') members.add(pool[memberIndex]);
        }
        entry = { length: pool.length, members: members };
        pools.set(pool, entry);
      }
      this.animationCount++;
      this.animationFrame = Math.floor(this.animationCount / 30);
      var count = this.children.length;
      for (var index = 0; index < count; index++) {
        var child = this.children[index];
        if (!child) continue;
        var filters = child._horrorFilters;
        if (entry.members.has(child) && child.layerId === -1 && child._hiding === true && child.visible === false &&
            child.children && child.children.length === 0 &&
            Array.isArray(child._animationSprites) && child._animationSprites.length === 0 &&
            !child._horrorFiltersSource && (!filters || !filters.noiseFilter && !filters.glitchFilter && !filters.tvFilter) &&
            child.update === methods[0][3] && child.updateVisibility === methods[1][3] &&
            child.updateAnimationSprites === methods[2][3] && child.synchronizeHorrorFiltersWithSource === methods[4][3] &&
            child.updateHorrorEffects === methods[5][3] && child.updateHorrorNoise === methods[6][3] &&
            child.updateHorrorGlitch === methods[7][3] && child.updateHorrorTV === methods[8][3]) {
          stats.skipped++;
        } else if (child.update) { stats.ordinary++; child.update(); }
      }
      var bitmapCount = this.bitmaps.length;
      for (var bitmapIndex = 0; bitmapIndex < bitmapCount; bitmapIndex++) {
        if (this.bitmaps[bitmapIndex]) this.bitmaps[bitmapIndex].touch();
      }
    };
    installed = true;
    return true;
  }
  PMJS.yedPriorityUpdates = { install: install, diagnostics: function() {
    return { installed: installed, skipped: stats.skipped, ordinary: stats.ordinary };
  } };
  PMJS.phases.on('beforeBoot', 'pmjs.yed-priority-updates', install);
})();
