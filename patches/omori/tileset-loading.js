'use strict';
(function() {
  var id='omori.tileset-loading';
  PMJS.optimizations.register({id:id,owner:'pmjs-omori',fallback:'ordinary tileset loading'});
  PMJS.phases.on('afterGuestPlugins',id,function() {
    if (!PMJS.optimizations.isEnabled(id)) return;
    var prototype=Spriteset_Map.prototype,original=prototype.loadTileset;
    if (!PMJS.maps || !PMJS.maps.loadParserTilesets || !PMJS.methods.matchesSource(original,
        'c781bcae7395f63ce89a5a5014c90fad8349449230db93bfbb092224fdafee33')) {
      PMJS.optimizations.refuse(id,'unrecognized tileset loader');return;
    }
    prototype.loadTileset=function() {
      if (!$gameMap.isTiledMap()) return original.apply(this,arguments);
      var tilesets=$gameMap.tiledData.tilesets;
      PMJS.maps.loadParserTilesets(tilesets.map(function(set) {return set.image;}),this._tilemap.bitmaps);
      this._tilemap.refreshTileset();
      this._tileset=tilesets;
    };
  });
})();
