'use strict';
(function() {
  var id = 'port.omori.search-limit';
  var filter = Array.prototype.filter, mapArray = Array.prototype.map, slice = Array.prototype.slice, some = Array.prototype.some;
  var parse = parseInt;
  var contains = Array.prototype.contains, indexOf = Array.prototype.indexOf;
  var species = Object.getOwnPropertyDescriptor(Array, Symbol.species).get;
  var lowerCase = String.prototype.toLowerCase;
  PMJS.plugins.registerOptimization('GALV_EventDetectors', { id: id, owner: 'pmjs-omori', fallback: 'complete bounded search' });
  PMJS.phases.on('afterGuestPlugins', id, function() {
    if (!PMJS.mv.pathfinding) return;
    var methods = [
      [Game_CharacterBase.prototype, 'isThrough', '4ec225207f2b96c07625fce51727824234e2d059c1fd31c7401f43a851e45af5'],
      [Game_CharacterBase.prototype, 'isDebugThrough', 'feb57cf5786befc3fbd78772a52a8d3fa3a3350e9df674ddf5ea9319f2f9c834'],
      [Game_CharacterBase.prototype, 'isNormalPriority', '9818c505b73c2bc9f9ebf9c1165bdb6c287150e271e676b6f3f06d1b151b97a6'],
      [Game_CharacterBase.prototype, 'posNt', '24649f0796faa64b85ecf9c0e00258bd5f34ed6dbd84a6f5e8f9fafff89c5f94'],
      [Game_CharacterBase.prototype, 'reverseDir', '8425c07de98053a4b17ddfc23484b12a3fa106d70a0e1a41cd22b68853a3228e'],
      [Game_CharacterBase.prototype, 'isCollidedWithVehicles', '3a517cc91af80238b56fea3e4b06fb916cb48b5446a29b53cf8090bf20e219ff'],
      [Game_CharacterBase.prototype, 'isCollidedWithCharacters', '1bbf46c0539b030fd64a30cfd0d516c87b76705a0a85c968c36aeb71335a2d5d'],
      [Game_Event.prototype, 'isCollidedWithCharacters', '9a60b91f53fc7a9ded4528b982f2c1c284963d799c85ea7ab14f4a4d8b8668ec'],
      [Game_Event.prototype, 'isCollidedWithEvents', '6c4342c1061f7bcb42703f12650c376be518161edf0b8bf38a72a978fc616594'],
      [Game_Event.prototype, 'isCollidedWithPlayerCharacters', '451ef7f2aa4440c263296da4982e6741f833103f1fb4ea98e3167897de80a51f'],
      [Game_Player.prototype, 'isCollided', '188c81d2e7d43c34dc21c40a62091e89976a0cc91575d5c33d8f479a31d691f9'],
      [Game_Player.prototype, 'followers', '5adc2e2c89336eb6b2ebd61c4e00d9b87563ac5f12c0e975feb3597d8add383a'],
      [Game_Followers.prototype, 'isSomeoneCollided', 'b24a149daace42723d04f87f40cb091197d4e1e862fb60b437e478983886166a'],
      [Game_Followers.prototype, 'visibleFollowers', 'a9e76f8cbc81a6358d44f6b35330c03c6bc03e17495b088dcf244c3ffcca17ac'],
      [Game_Followers.prototype, 'isVisible', 'c336ae9fecd52d2b5de413c8c4d2360c43e22f4ef63ebd360c3a68c034ac039a'],
      [Game_Follower.prototype, 'actor', '85d13f07c8f7453aae7b01a2e0f58c092eae021c56af301cd08e6a0312dacc3e'],
      [Game_Party.prototype, 'battleMembers', 'a3bf83f0fa677fbec56a9a8bba8c380b86bb84e6054b1e4b5f8f222b9648cd40'],
      [Game_Party.prototype, 'maxBattleMembers', '3d4e937cde38233072d8e52aaa5ac9931555dd26db5840b3175c1d82efd1b673'],
      [Game_Actors.prototype, 'actor', 'bfb6605b53d578af134c3950ce754036b9a51541663de8b848c653c4057d9fe4'],
      [Game_BattlerBase.prototype, 'isAppeared', '02e597f867361580000bf42b0be723b98f708911c758b4256d9cc293a52d420a'],
      [Game_BattlerBase.prototype, 'isHidden', '8283a6d844b8f9a1006fbe84dad3a19ca15eeafbda9dd0caa56748d749cc3f50'],
      [Game_Switches.prototype, 'value', '252e9a77de26cd3a0bd55fec35c6873544ebd8114e7280ce5685556d00dfac87'],
      [Game_Map.prototype, 'eventsXyNt', 'b29186784b56febc978c7e4cdc8d91ffc598c548f6ff1f63ddb6b43c062d6932'],
      [Game_Map.prototype, 'events', '506f1ee64fd3bfb33a91e517d0dd955534d0979c8e7696d4cfcb7f3c3b694994'],
      [Game_Map.prototype, 'boat', '62f9e6f5448e7d5735d508b7a4a3d2e06e6e1ee7da868640871fa4e0c6e4ccb6'],
      [Game_Map.prototype, 'ship', 'e1a8c34cebdd566949b2a5d645deee51c370c6c11987951abf870249d257e508'],
      [Game_Map.prototype, 'mapId', '393333f7b7cb7a18d6f97c3a6627bce537bc6dd5340fb7bd0dce81ba9cee2b62'],
      [Game_Vehicle.prototype, 'pos', '673695f9f3306be47201598d6b37f4b8151aee8c0527aa0e2ec11bb1f675b0f0'],
      [Game_CharacterBase.prototype, 'canPass', '63d998290245adc33eb6a2ee728f14bc97e1d45a1088822f9caa51b183ed6e98'],
      [Game_CharacterBase.prototype, 'pos', 'f7cc2b22802c7703edde4782a5e8b969adf0e9cba5f7e4a4e946075f43063636'],
      [Game_CharacterBase.prototype, 'isWithinHitboxes', 'd5fe3251a03f650837e9d399c3641f046a6e6371452a11e515e0706fd01a6c3e'],
      [Game_CharacterBase.prototype, 'isMapPassable', '8c2cf67110b0e470ac0ce63fe20035bbb57771d3e67de1f101c4516647c6acf5'],
      [Game_CharacterBase.prototype, 'isPlayer', 'feb57cf5786befc3fbd78772a52a8d3fa3a3350e9df674ddf5ea9319f2f9c834'],
      [Game_CharacterBase.prototype, 'isEventRegionForbid', 'b022a3b2ef630ee8ca79a6252a9d3a05e7141d8b9ce7d47385531221de84e197'],
      [Game_CharacterBase.prototype, 'isPlayerRegionForbid', 'e364e4d2eff0c4dc87606885c522c54aac78f01bd5ea6a762b88bf86bebdbf85'],
      [Game_CharacterBase.prototype, 'isEventRegionAllow', 'c65825f9fe397c24817b9e2216a1c5b47c9eb7005c2578e8fef2b2dadc57e865'],
      [Game_CharacterBase.prototype, 'isPlayerRegionAllow', '7bf0da8f2c87c81f58fef63d67d3b342e436c56c5c1990e046ec6c170d9ee8d3'],
      [Game_CharacterBase.prototype, 'getRegionId', '6f0b8a53465b8b7b559c4cb83c5b115500d7ae35fa0820ce9f02aa73d8b042d9'],
      [Game_Event.prototype, 'isEvent', '59d970ec76aa49dd256286168f3a2fb122e03247533834e3703df8f7590ae7ba'],
      [Game_Map.prototype, 'restrictEventRegions', '75dadd5329570a5789670b4c8c2c7bc5940a430a0ff6393e90ef7e6860cf9b93'],
      [Game_Map.prototype, 'allowEventRegions', '9e412c6fe666a6c1740d27f1c151285663dd4ab6aca77c99148729843c1cac29'],
      [Game_Map.prototype, 'width', '534c56c5ec894a95f7b3f04087821e890f7ce5942c767b710ccbeffbf5e881b0'],
      [Game_Map.prototype, 'height', 'e73277cb4abb04863468ebe53d5a74c11abee87eb73f1c69141807c0be572955'],
      [Game_Map.prototype, 'isHalfTile', 'd70c76e7841074447fc5ccd4295d0e2a5fb2a71d8a7bdb1860b15ab93fe5ac0b'],
      [Game_Map.prototype, 'isTiledMap', 'ab604a2024455928bebc39cc9c7d749b6a6149c8df3541e68e1fb73dd5cabb0b'],
      [Game_Map.prototype, 'isPassable', 'abb7923101646074fbb3854627ef6b3d60dd3a18330c497032f7573df5ec6cfd'],
      [Game_Map.prototype, 'regionId', '7c2e048eb034b94157ac4be179311d604d867ff30bb2d9dc6a81a797ff69af6a'],
      [Game_Follower.prototype, 'isVisible', '12b2a91de61892170dd830bb11107988c063c14c06cf47d33a714cd4cb7a0ebb'],
      [Game_Party.prototype, 'allMembers', 'd6e4ca463c403519abd77855cbc5b141d6629e4ca6de0ea99eb16b91031076ff'],
      [Game_Party.prototype, 'isInFaraway', '8551d894752d60cdaff323ef9d9b0d8b1ef9ab2cb2d4341575b35821ea07c15e'],
      [_TDS_.ExtraFollowers, 'Game_Follower_isVisible', '17b03e989bf1ce3ee8513720737d946fdb58700f845447d72fe0f46cdcb2f9e9'],
      [_TDS_.OmoriBASE, 'Game_Party_allMembers', 'a6cfd0a7b5870d7f524869a03ead6c8798111affc292b1c3906d803c9522ac29'],
      [Yanfly.EvHbRs, 'Game_CharacterBase_canPass', '3157b43e6bf024acf6f594c99319d77784c00c263650d4f174e5da5007072167'],
      [Yanfly.EvHbRs, 'Game_CharacterBase_pos', '0662f77c5fbbc557fe9826aee1827b3982e9e8618815a7552f8cfabe5713076b'],
      [Yanfly.RR, 'Game_CharacterBase_isMapPassable', '3045cba44ea562e6c1700cc22286906fbb9120f57940810472c4687ca3944750'],
      [Yanfly.MoveRoute, 'Game_Event_isPlayerCollided', 'e2e22049179713b525b493c62f2ba763005d8368808ccb511066af2d91bea463'],
      [Game_Variables.prototype, 'value', 'fb9ad36786c6527747a0ae927380a8987ca2ab1ecb347a241096105e2ba76afd']
    ];
    var refused = methods.filter(function(row) { return !PMJS.methods.matchesSource(row[0][row[1]], row[2]); });
    if (refused.length) {
      PMJS.optimizations.refuse(id, 'unrecognized search queries: ' + refused.map(function(row) { return row[1]; }).join(', ')); return;
    }
    methods.forEach(function(row) { row[2] = row[0][row[1]]; });
    var extra = _TDS_.ExtraFollowers, base = _TDS_.OmoriBASE, hitboxes = Yanfly.EvHbRs, regions = Yanfly.RR, routes = Yanfly.MoveRoute;
    var sets = new Map();
    methods.forEach(function(row) {
      if (!sets.has(row[1])) sets.set(row[1], new Set());
      sets.get(row[1]).add(row[2]);
    });
    var getters = ['tiledData', 'currentMapLevel'].map(function(name) {
      return (descriptor(Game_Map.prototype, name) || {}).get;
    });
    var positionGetters = ['x', 'y'].map(function(name) { return (descriptor(Game_CharacterBase.prototype, name) || {}).get; });
    if (!PMJS.methods.matchesSource(getters[0], 'e687609b1430802d1ccfad336b7fdfb9c13a5a0747799b335420b2b4b4534beb') ||
        !PMJS.methods.matchesSource(getters[1], 'cd9c0d777cfc22b9405f01ae0b87db05fc8bc5d215aa81e858f0cba04439ef27') ||
        !PMJS.methods.matchesSource(positionGetters[0], 'd1a06e1e325456ed37c44c69edf36e91d5ebda0d2cb75a40b705e6f0902911d3') ||
        !PMJS.methods.matchesSource(positionGetters[1], '33f22310bb5dd92f04a568e0177b8f961a0db09a04472035da4d9c66c7ce4748')) {
      PMJS.optimizations.refuse(id, 'unrecognized search data getters'); return;
    }
    var unsafe = {};
    function field(object, name) {
      if (!object) return unsafe;
      var d = Object.getOwnPropertyDescriptor(object, name);
      return d ? (Object.hasOwn(d, 'value') ? d.value : unsafe) : name in object ? unsafe : undefined;
    }
    function descriptor(object, name) {
      while (object) {
        var d = Object.getOwnPropertyDescriptor(object, name);
        if (d) return d;
        object = Object.getPrototypeOf(object);
      }
    }
    function method(object, name) {
      var d = descriptor(object, name);
      return d && Object.hasOwn(d, 'value') ? d.value : unsafe;
    }
    function known(object, names) {
      return object && names.every(function(name) { return sets.get(name).has(method(object, name)); });
    }
    function array(value) {
      return Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype &&
        method(value, 'constructor') === Array && method(value, 'filter') === filter && method(value, 'map') === mapArray &&
        method(value, 'slice') === slice && method(value, 'some') === some && method(value, 'contains') === contains && method(value, 'indexOf') === indexOf;
    }
    function primitives(value) {
      if (!array(value)) return false;
      for (var i = 0; i < value.length; i++) {
        var item = field(value, i);
        if (item !== undefined && typeof item !== 'number' && typeof item !== 'boolean') return false;
      }
      return true;
    }
    function character(value) {
      if (!known(value, ['pos', 'posNt', 'isThrough']) ||
          !Number.isFinite(field(value, '_x')) || !Number.isFinite(field(value, '_y')) ||
          typeof field(value, '_through') !== 'boolean') return false;
      for (var axis = 0; axis < 2; axis++) {
        var owner = value, descriptor, name = axis ? 'y' : 'x';
        while (owner && !(descriptor = Object.getOwnPropertyDescriptor(owner, name))) owner = Object.getPrototypeOf(owner);
        if (!descriptor || descriptor.get !== positionGetters[axis]) return false;
      }
      for (var name of ['_addedHitboxUp', '_addedHitboxDown', '_addedHitboxLeft', '_addedHitboxRight']) {
        var extent = field(value, name);
        if (extent !== undefined && !Number.isFinite(extent)) return false;
      }
      return field(value, '_addedHitboxUp') === undefined || known(value, ['isWithinHitboxes']);
    }
    function followersReady(player) {
      var followers = field(player, '_followers'), data = field(followers, '_data');
      if (!known(player, ['followers', 'isCollided']) || !known(followers, ['isSomeoneCollided', 'visibleFollowers', 'isVisible']) ||
          typeof field(followers, '_visible') !== 'boolean' || !array(data)) return false;
      for (var i = 0; i < data.length; i++) {
        var follower = field(data, i);
        if (!character(follower) || !known(follower, ['actor', 'isVisible']) ||
            !Number.isInteger(field(follower, '_memberIndex')) || field(follower, '_graphicsData') === unsafe) return false;
      }
      var party = globalThis.$gameParty, actors = globalThis.$gameActors, switches = globalThis.$gameSwitches;
      if (!known(party, ['allMembers', 'battleMembers', 'maxBattleMembers', 'isInFaraway']) ||
          !known(actors, ['actor']) || !known(switches, ['value'])) return false;
      var ids = field(party, '_actors'), actorData = field(actors, '_data'), switchData = field(switches, '_data');
      if (!primitives(ids) || !array(actorData) || !array(switchData) || !array($dataActors) || field(switchData, 7) === unsafe) return false;
      function ready(id) {
        var actor = field(actorData, id), definition = field($dataActors, id);
        return definition && definition !== unsafe && known(actor, ['isAppeared', 'isHidden']) &&
          typeof field(actor, '_hidden') === 'boolean' && field(actor, '_farawayActorId') !== unsafe;
      }
      for (var i = 0; i < ids.length; i++) {
        if (!Number.isInteger(ids[i]) || !ready(ids[i])) return false;
        var replacement = field(actorData[ids[i]], '_farawayActorId');
        if (field(switchData, 7) && replacement && (!Number.isInteger(replacement) || !ready(replacement))) return false;
      }
      return true;
    }
    function reject(reason) { PMJS.optimizations.reportFallback(id, reason); return false; }
    PMJS.mv.pathfinding.isPureSearch = function(mover, gameMap, limit) {
      if (!PMJS.optimizations.isEnabled(id) || !Number.isInteger(limit) || limit > 64 ||
          parseInt !== parse || Array.prototype.filter !== filter || Array.prototype.map !== mapArray ||
          Array.prototype.slice !== slice || Array.prototype.some !== some ||
          Array.prototype.contains !== contains || Array.prototype.indexOf !== indexOf ||
          (Object.getOwnPropertyDescriptor(Array, Symbol.species) || {}).get !== species || String.prototype.toLowerCase !== lowerCase ||
          _TDS_.ExtraFollowers !== extra || _TDS_.OmoriBASE !== base || Yanfly.EvHbRs !== hitboxes || Yanfly.RR !== regions || Yanfly.MoveRoute !== routes ||
          method(Game_Character.prototype, 'pos') !== method(Game_CharacterBase.prototype, 'pos') ||
          method(Game_Character.prototype, 'isCollidedWithCharacters') !== method(Game_CharacterBase.prototype, 'isCollidedWithCharacters') ||
          methods.some(function(row) { return method(row[0], row[1]) !== row[2]; })) return reject('query-method-changed');
      if (!known(mover, ['canPass', 'isThrough', 'isDebugThrough', 'isNormalPriority', 'isMapPassable',
          'isPlayer', 'isEvent', 'isEventRegionForbid', 'isPlayerRegionForbid', 'isEventRegionAllow',
          'isPlayerRegionAllow', 'getRegionId', 'reverseDir', 'isCollidedWithCharacters',
          'isCollidedWithEvents', 'isCollidedWithVehicles', 'isCollidedWithPlayerCharacters']) || !character(mover) ||
          !Number.isFinite(field(mover, '_priorityType'))) return reject('mover-composition');
      if (Object.getPrototypeOf(gameMap) !== Game_Map.prototype || !known(gameMap, ['width', 'height', 'isHalfTile', 'isTiledMap', 'isPassable', 'regionId',
          'restrictEventRegions', 'allowEventRegions', 'events', 'eventsXyNt', 'boat', 'ship', 'mapId']) ||
          (descriptor(gameMap, 'tiledData') || {}).get !== getters[0] ||
          (descriptor(gameMap, 'currentMapLevel') || {}).get !== getters[1] ||
          Object.hasOwn(gameMap, 'tiledData') || Object.hasOwn(gameMap, 'currentMapLevel')) return reject('map-composition');
      var parameters = typeof YED_TiledParameters === 'undefined' ? null : YED_TiledParameters;
      var levelParameter = field(parameters, 'Map Level Variable');
      if (field(globalThis.$gameTemp, '_moveAllowPlayerCollision') === unsafe || typeof levelParameter !== 'string' ||
          typeof field(parameters, 'Half-tile movement') !== 'string' ||
          !Number.isInteger(field($dataMap, 'scrollType')) ||
          !primitives(field($dataMap, 'restrictEventRegions')) || !primitives(field($dataMap, 'allowEventRegions'))) return reject('map-parameters');
      var tileData = field(DataManager, '_tempTiledData'), level = field(gameMap, '_currentMapLevel');
      var levelVariable = parse(levelParameter);
      if (levelVariable) {
        var variables = globalThis.$gameVariables, values = field(variables, '_data');
        if (!Number.isInteger(levelVariable) || !known(variables, ['value']) || !array(values)) return reject('map-level-variable');
        var selected = field(values, levelVariable);
        if (selected !== undefined && typeof selected !== 'number') return reject('map-level-value');
        level = selected || 0;
      }
      if (!Number.isInteger(field(tileData, 'width')) || !Number.isInteger(field(tileData, 'height')) ||
          !Number.isInteger(level) || !Number.isInteger(field(gameMap, '_mapId'))) return reject('map-data');
      var events = field(gameMap, '_events'), vehicles = field(gameMap, '_vehicles');
      if (!array(events) || !array(vehicles) || !character($gamePlayer) || !followersReady($gamePlayer)) return reject('party-or-collections');
      for (var i = 0; i < events.length; i++) {
        var event = field(events, i);
        if (event && (!character(event) || !known(event, ['isNormalPriority']) || !Number.isFinite(field(event, '_priorityType')))) return reject('event-fields');
      }
      for (var i = 0; i < 2; i++) {
        var vehicle = field(vehicles, i);
        if (!character(vehicle) || !Number.isInteger(field(vehicle, '_mapId'))) return reject('vehicle-fields');
      }
      var width = gameMap.width(), height = gameMap.height();
      var loopX = gameMap.isLoopHorizontal(), loopY = gameMap.isLoopVertical();
      function numeric(grid, index) {
        var value = field(grid, index);
        return value === undefined || typeof value === 'number';
      }
      for (var key of ['_regions', '_collisionMap', '_arrowCollisionMap']) {
        var levels = field(gameMap, key), grid = field(levels, level);
        if (!Array.isArray(levels) || !Array.isArray(grid)) return reject('grid-shape');
        for (var dy = -limit; dy <= limit; dy++) for (var dx = -limit + Math.abs(dy); dx <= limit - Math.abs(dy); dx++) {
          var x = mover.x + dx, y = mover.y + dy;
          if (loopX) x = (x % width + width) % width;
          if (loopY) y = (y % height + height) % height;
          if (x < 0 || x >= width || y < 0 || y >= height) continue;
          if (!numeric(grid, y * width + x)) return reject('grid-accessor');
          if (key === '_regions' &&
              (loopX && x === 0 && !numeric(grid, y * width - 1) ||
               loopX && x === width - 1 && !numeric(grid, (y + 1) * width) ||
               loopY && y === 0 && !numeric(grid, x - width) ||
               loopY && y === height - 1 && !numeric(grid, height * width + x))) return reject('region-edge-accessor');
        }
      }
      return true;
    };
  });
})();
