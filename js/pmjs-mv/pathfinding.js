'use strict';

(function() {
  var id = 'mv.pathfinding';
  var workspaces = new WeakMap();
  var geometryMethods = null;
  if (globalThis.Game_Map) {
    geometryMethods = {};
    ['distance','deltaX','deltaY','isLoopHorizontal','isLoopVertical','roundXWithDirection','roundYWithDirection','roundX','roundY'].forEach(function(name) {
      geometryMethods[name] = Game_Map.prototype[name];
    });
  }
  var geometrySources = {
    distance: ["51ddec98a1105adc223e0c0814ddd8f842da6eda0ba181d615143dbea5da0c0b", "43c3cd1488e5867bb84efef9dd34c80b2188f059c84ae51a38d54130583da633"],
    deltaX: ["14f167453d62b45505d0cf334c8f7312bf96ad6cd02b16ea99d4fead951bbc28", "eeb9f2f081f006fb454a4fea62ba901389e50ce90786eda98877279e2c9c64a0"],
    deltaY: ["05ce0da3b1d0c85013877a5af78c06b7d40803fdc099ede4819eb8e658e89b11", "7bef86fa8d9cd80e927193c7d680015bb36b3181c036af5f90f1cd2167b6b508"],
    isLoopHorizontal: ["369db5889f3b0759aa27e5b3a94831e9d56f992ed28a604fce96623f798dccdd", "7409de3936eeb8f67bfc66ed1424fcb7a6daa3b29479beeb6c762b9ec0c8d965"],
    isLoopVertical: ["1b1a504f6ea6d9ae0c9f8d3391d3b49f4685c9231a8925f067c385d5bf9cf2cd", "b24925db4326d5453bb1d6cc5200cc8273a4d82ae2e488b49c587d8f04430153"],
    roundXWithDirection: ["93185ee86bbdb4a017135071a610b77f9137c640cf7bf37c57ecb77bf3d8219e", "d295c20c80f223ee545cb684ff9a9f0d88bad3e10203204ced46645a6d016142"],
    roundYWithDirection: ["9261e284ffd6c42c4b4ddfa580659ad72c6212a342b74d19a136b96873bdcd9d", "ea788c0f6f466ae457e8b4b072fbd5731a0f08958b697c543e5a90933f299ed3"],
    roundX: ["4d9f1f3eecb93e030c2bb91553fd4645f8bae09a27edb30ea8680cd5449bbb42", "db4470d9a5060d49e36544f3e7b2bb321477f19a0a3f567d60aa3029a8a8f8ed"],
    roundY: ["237ac8ee961b028e9354f8a4d58a872bbaee56c19980d55005c1833e18843c39", "2b6f8bbb91373b5546dfadca8a37d29c6ffa4515069a2bc73c5f5ea26bc1f4ca"]
  };
  var modulo = Number.prototype.mod;
  if (!geometryMethods || !Object.keys(geometryMethods).every(function(name) {
    return PMJS.methods.matchesSource(geometryMethods[name], geometrySources[name]);
  }) || !PMJS.methods.matchesSource(modulo, ["8af4e6c0190f098f5e79fb8fdacfeff39552e6248436dda26098db4945dacb9d", "81f33747890eff75e8f1f98ba7409c5560afa9901618aabba34a4e9778680ab5"])) geometryMethods = null;
  var ordinaryPassSources = ["c4e5a41faf7d52f73306eec25cb8a82f7bcd4616a628af7a507930b7c569b2f7", "3157b43e6bf024acf6f594c99319d77784c00c263650d4f174e5da5007072167"];
  var hitboxPassSources = ["63d998290245adc33eb6a2ee728f14bc97e1d45a1088822f9caa51b183ed6e98"];
  var ordinaryPass = globalThis.Game_CharacterBase && Game_CharacterBase.prototype.canPass;
  var valid = globalThis.Game_Map && Game_Map.prototype.isValid;
  if (!PMJS.methods.matchesSource(valid, ["e487e7663ad7cd409dd438999f2cc98afc81af6402e3d4a6d47e930ee719149e", "2cf19d9703caeaed1463afffd690e44303a523a2d8b3494c9c00ac657ace1f9b"])) valid = null;
  var stats = { calls: 0, accelerated: 0, fallback: 0, expanded: 0, finalized: 0, blockedGoals: 0 };
  PMJS.mv = PMJS.mv || {};
  PMJS.mv.pathfinding = { diagnostics: function() { return Object.assign({}, stats); } };
  PMJS.optimizations.register({ id: id, owner: 'pmjs-mv', fallback: 'original findDirectionTo' });
  PMJS.methods.own({
    key: 'Game_Character.findDirectionTo', id: id,
    getTarget: function() { return globalThis.Game_Character && Game_Character.prototype; },
    method: 'findDirectionTo',
    replace: function(original) {
      var pass = Game_Character.prototype.canPass;
      var hitboxes = globalThis.Yanfly && Yanfly.EvHbRs;
      if (!PMJS.methods.matchesSource(ordinaryPass, ordinaryPassSources) && hitboxes &&
          PMJS.methods.matchesSource(hitboxes.Game_CharacterBase_canPass, ordinaryPassSources)) {
        ordinaryPass = hitboxes.Game_CharacterBase_canPass;
      }
      var wrappedHitboxes = pass !== ordinaryPass && PMJS.methods.matchesSource(pass, hitboxPassSources);
      var passSupported = PMJS.methods.matchesSource(ordinaryPass, ordinaryPassSources) &&
        (pass === ordinaryPass || wrappedHitboxes && hitboxes && hitboxes.Game_CharacterBase_canPass === ordinaryPass);
      if (!PMJS.methods.matchesSource(original, [
        '88b7b1f4204a78d1a7f3c0d2291b19da1f58c50af232f1cbe878b5e76ea5c174',
        '1a68fbcc938667b583852455b20c276ffc988539f4cabbc850b72cd16e7a21d2'
      ])) {
        PMJS.optimizations.refuse(id, 'unrecognized findDirectionTo');
        return original;
      }
      return function(goalX, goalY) {
        stats.calls++;
        var map = globalThis.$gameMap;
        var work = map && workspaces.get(map);
        if (!PMJS.optimizations.isEnabled(id) || !map || !passSupported || this.canPass !== pass ||
            !valid || map.isValid !== valid || this._addedHitboxUp || this._addedHitboxDown ||
            this._addedHitboxLeft || this._addedHitboxRight ||
            wrappedHitboxes && hitboxes.Game_CharacterBase_canPass !== ordinaryPass || !geometryMethods || Number.prototype.mod !== modulo ||
            !Object.keys(geometryMethods).every(function(name) { return map[name] === geometryMethods[name]; }) || work && work.busy) {
          stats.fallback++;
          return original.apply(this, arguments);
        }
        var width = map.width(), height = map.height(), size = width * height;
        if (!Number.isInteger(width) || !Number.isInteger(height) || size <= 0 || size > 1048576 ||
            !Number.isInteger(this.x) || !Number.isInteger(this.y) || this.x < 0 || this.y < 0 ||
            this.x >= width || this.y >= height) {
          stats.fallback++;
          return original.apply(this, arguments);
        }
        if (!work || work.size !== size) {
          work = { busy: false, size: size, stamp: 0, seen: new Uint32Array(size), closed: new Uint32Array(size),
            open: [], g: new Int32Array(size), f: new Float64Array(size), parent: new Int32Array(size) };
          workspaces.set(map, work);
        }
        work.busy = true;
        stats.accelerated++;
        try {
          var limit = this.searchLimit();
          var geometry = geometryMethods && Object.keys(geometryMethods).every(function(name) {
            return map[name] === geometryMethods[name];
          });
          var loopX = geometry && map.isLoopHorizontal(), loopY = geometry && map.isLoopVertical();
          if (this.x === goalX && this.y === goalY) return 0;
          var seen = work.seen, closed = work.closed, open = work.open;
          var g = work.g, f = work.f, parent = work.parent;
          work.stamp = (work.stamp + 1) >>> 0;
          if (!work.stamp) { seen.fill(0); closed.fill(0); work.stamp = 1; }
          var stamp = work.stamp, start = this.y * width + this.x;
          open.length = 0;
          seen[start] = stamp; g[start] = 0;
          f[start] = map.distance(this.x, this.y, goalX, goalY); parent[start] = -1;
          open.push(start);
          var best = start, expanded = 0;
          var minimumDistance = Number.isInteger(limit) && limit >= 0 && Number.isInteger(goalX) && Number.isInteger(goalY) &&
            goalX >= 0 && goalX < width && goalY >= 0 && goalY < height ? Math.max(0, f[start] - limit) : -1;
          var pureSearch = null;
          while (open.length) {
            var at = 0;
            for (var i = 1; i < open.length; i++) if (f[open[i]] < f[open[at]]) at = i;
            var current = open[at]; open.splice(at,1); expanded++;
            var x1 = current % width, y1 = Math.floor(current / width), g1 = g[current];
            closed[current] = stamp;
            if (x1 === goalX && y1 === goalY) { best = current; break; }
            var remaining = f[current] - g1;
            // A settled path attaining a proved distance bound cannot be improved.
            if (current === best && minimumDistance >= 0 &&
                (remaining === 1 || minimumDistance > 0 && remaining === minimumDistance)) {
              if (pureSearch === null) pureSearch = typeof PMJS.mv.pathfinding.isPureSearch === 'function' &&
                PMJS.mv.pathfinding.isPureSearch(this, map, limit);
              if (pureSearch) {
                if (minimumDistance > 0 && remaining === minimumDistance) { stats.finalized++; break; }
                if (!this.isThrough() && !this.isDebugThrough() && this.isCollidedWithCharacters(goalX, goalY)) {
                  stats.blockedGoals++; stats.finalized++; break;
                }
              }
            }
            if (g1 >= limit) continue;
            for (var j = 0; j < 4; j++) {
              var direction = 2 + j * 2;
              var x2, y2;
              if (geometry) {
                x2 = x1 + (direction === 6 ? 1 : direction === 4 ? -1 : 0);
                y2 = y1 + (direction === 2 ? 1 : direction === 8 ? -1 : 0);
                if (loopX) { if (x2 < 0) x2 += width; else if (x2 >= width) x2 -= width; }
                if (loopY) { if (y2 < 0) y2 += height; else if (y2 >= height) y2 -= height; }
              } else {
                x2 = map.roundXWithDirection(x1, direction);
                y2 = map.roundYWithDirection(y1, direction);
              }
              var position = y2 * width + x2;
              if (closed[position] === stamp) continue;
              if (!this.canPass(x1, y1, direction)) continue;
              var g2 = g1 + 1, neighbor = position;
              if (seen[neighbor] !== stamp || g2 < g[neighbor]) {
                if (seen[neighbor] !== stamp) {
                  seen[neighbor] = stamp;
                  open.push(neighbor);
                }
                parent[neighbor] = current;
                g[neighbor] = g2;
                var distance;
                if (geometry) {
                  var dx = Math.abs(x2 - goalX), dy = Math.abs(y2 - goalY);
                  if (loopX && dx > width / 2) dx = Math.abs(dx - width);
                  if (loopY && dy > height / 2) dy = Math.abs(dy - height);
                  distance = dx + dy;
                } else distance = map.distance(x2, y2, goalX, goalY);
                f[neighbor] = g2 + distance;
                if (f[neighbor] - g[neighbor] < f[best] - g[best]) best = neighbor;
              }
            }
          }
          stats.expanded += expanded;
          var node = best;
          while (parent[node] >= 0 && parent[node] !== start) node = parent[node];
          var dx1 = map.deltaX(node % width, this.x), dy1 = map.deltaY(Math.floor(node / width), this.y);
          if (dy1 > 0) return 2;
          if (dx1 < 0) return 4;
          if (dx1 > 0) return 6;
          if (dy1 < 0) return 8;
          var dx2 = this.deltaXFrom(goalX), dy2 = this.deltaYFrom(goalY);
          if (Math.abs(dx2) > Math.abs(dy2)) return dx2 > 0 ? 4 : 6;
          if (dy2 !== 0) return dy2 > 0 ? 8 : 2;
          return 0;
        } finally { work.busy = false; }
      };
    }
  });
})();
