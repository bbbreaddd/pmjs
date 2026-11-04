'use strict';
const assert=require('node:assert/strict');
const test=require('node:test');
const fs=require('node:fs');
const vm=require('node:vm');
const crypto=require('node:crypto');
const {loadPmjsRuntime}=require('./helpers/runtime-context.cjs');
const source=fs.readFileSync(require.resolve('../js/pmjs-rpgmaker/map-images.js'),'utf8');
function fixture({ reviewed = false, mz = false, lineEnding = '\n', unknown = false } = {}) {
  const definitions=[],loads=[];
  function Tilemap() {} function ShaderTilemap() {} function Bitmap() {}
  const producerSource = 'function(tileId) {\n  return tileId + 1;\n}';
  const producer = vm.runInNewContext('(' + producerSource.replace(/\n/g, lineEnding) + ')');
  for(const name of ['_addNormalTile','_addAutotile','_addTableEdge','_drawNormalTile','_drawAutotile','_drawTableEdge','_isTableTile']) Tilemap.prototype[name]=producer;
  for(const name of ['_drawNormalTile','_drawAutotile','_drawTableEdge']) ShaderTilemap.prototype[name]=producer;
  if (unknown) Tilemap.prototype._isTableTile = function() { return false; };
  const PMJS=loadPmjsRuntime({ __pmjsBuiltinRequire: require }, ['js/pmjs-core/methods.js']).PMJS;
  PMJS.images={};
  PMJS.methods.wrap=definition=>definitions.push(definition);
  const ImageManager={loadTileset(url,hue){loads.push({url,hue,context:PMJS.images.preparedTileSet});return {};},
    loadParserTileset(url,hue){loads.push({url,hue,context:PMJS.images.preparedTileSet});return {};},_generateCacheKey(url,hue){return url+':'+hue;}};
  Bitmap.prototype._requestImage=function(){loads.push({context:PMJS.images.preparedTileSet,retry:true});};
  const data={tilesets:[{firstgid:1}],layers:[{data:[1,2]}]};
  const index={1:{renderer:'tiled',identity:'set-a',contractHash:crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex')}};
  const context={PMJS,NativeHost:{assets:{mapPreparationEnabled:true,preparedMapIndex:index}},ImageManager,
    Tilemap,ShaderTilemap:mz?undefined:ShaderTilemap,Bitmap,$dataMap:{},$gameMap:{mapId:()=>1,tiledData:data,isTiledMap:()=>true},
    __pmjsBuiltinRequire:require};
  const adapter = reviewed ? source.replace(/'[a-f0-9]{64}'/g,
    "'" + crypto.createHash('sha256').update(producerSource).digest('hex') + "'") : source;
  vm.runInNewContext(adapter,context);
  for(const definition of definitions) {
    const target=definition.getTarget();if(typeof target[definition.method]==='function')
      target[definition.method]=definition.wrap(target[definition.method]);
  }
  PMJS.maps.tiledContract=()=>true;
  return {context,PMJS,loads,ImageManager,Bitmap,data,index};
}
test('reviewed tile loads preserve public names, isolate cache identities and restore nested context',()=>{
  const f=fixture();f.PMJS.images.preparedTileSet='outer';
  const bitmap=f.ImageManager.loadParserTileset('Sheet',0);
  assert.equal(bitmap._pmjsPreparedTileSet,'set-a');
  assert.deepEqual(f.loads,[{url:'Sheet',hue:0,context:'set-a'}]);
  assert.equal(f.PMJS.images.preparedTileSet,'outer');
  f.PMJS.images.preparedTileSet='set-a';const a=f.ImageManager._generateCacheKey('Sheet',0);
  f.PMJS.images.preparedTileSet='set-b';assert.notEqual(f.ImageManager._generateCacheKey('Sheet',0),a);
  const retained=new f.Bitmap();retained._pmjsPreparedTileSet='set-a';retained._requestImage();
  assert.equal(f.loads.at(-1).context,'set-a');assert.equal(f.PMJS.images.preparedTileSet,'set-b');
});
test('hue, revised content and changed method compositions use ordinary context with precise reasons',()=>{
  const f=fixture();f.ImageManager.loadTileset('Sheet',30);assert.equal(f.loads.at(-1).context,'');
  f.data.layers[0].data[0]=3;f.ImageManager.loadTileset('Sheet',0);
  assert.equal(f.loads.at(-1).context,'');assert.equal(f.PMJS.maps.stats.reasons['tiled-content-changed'],1);
  f.PMJS.maps.tiledContract=()=>false;f.ImageManager.loadTileset('Sheet',0);
  assert.equal(f.PMJS.maps.stats.reasons['unreviewed-tiled-methods'],1);
  f.index[1].renderer='mv';f.context.$gameMap.isTiledMap=()=>false;f.ImageManager.loadTileset('Sheet',0);
  assert.equal(f.PMJS.maps.stats.reasons['unreviewed-tile-producers'],1);
});

test('adding or removing a Tiled override refuses the cached renderer',()=>{
  const f=fixture();
  f.context.$gameMap.isTiledMap=()=>false;
  assert.equal(f.PMJS.maps.selected(),'');
  f.index[1].renderer='mv';f.context.$gameMap.isTiledMap=()=>true;
  assert.equal(f.PMJS.maps.selected(),'');
  assert.equal(f.PMJS.maps.stats.reasons['map-renderer-changed'],2);
});

test('observed content and renderer mismatches request catalog refresh, unknown methods do not', () => {
  const f = fixture(); let invalidations = 0;
  f.context.NativeHost.assets.invalidateMapCatalog = () => { invalidations++; };
  f.data.layers[0].data.push(3);
  assert.equal(f.PMJS.maps.selected(), '');
  assert.equal(invalidations, 1);
  f.context.$gameMap.isTiledMap = () => false;
  assert.equal(f.PMJS.maps.selected(), '');
  assert.equal(invalidations, 2);
  f.context.$gameMap.isTiledMap = () => true;
  f.PMJS.maps.tiledContract = () => false;
  assert.equal(f.PMJS.maps.selected(), '');
  assert.equal(invalidations, 2, 'runtime plugin overrides cannot be repaired by regeneration');
});

test('tileset images outside the prepared set load unscoped without discarding the catalog', () => {
  const f = fixture(); let invalidations = 0;
  f.context.NativeHost.assets.invalidateMapCatalog = () => { invalidations++; };
  f.index[1].sources = ['img/tilesets/Used.png'];
  f.ImageManager.loadParserTileset('../img/tilesets/Unused.png', 0);
  assert.equal(f.loads.at(-1).context, '');
  f.ImageManager.loadTileset('Unused', 0);
  assert.equal(f.loads.at(-1).context, '');
  assert.equal(f.PMJS.maps.stats.unscoped, 2);
  f.ImageManager.loadParserTileset('../img/tilesets/Used.png', 0);
  assert.equal(f.loads.at(-1).context, 'set-a');
  f.ImageManager.loadTileset('Used', 0);
  assert.equal(f.loads.at(-1).context, 'set-a');
  assert.equal(f.PMJS.maps.stats.selected, 2);
  assert.equal(invalidations, 0);
  delete f.index[1].sources;
  f.ImageManager.loadParserTileset('../img/tilesets/Unused.png', 0);
  assert.equal(f.loads.at(-1).context, 'set-a', 'indexes without a source list keep the previous scoping');
});

function selectOrdinaryMap(f) {
  const map = { width: 1, height: 1, data: [0], tilesetId: 1, scrollType: 0, events: [] };
  const tileset = { tilesetNames: ['Ground'], flags: [0] };
  Object.assign(f.context.$gameMap, {
    isTiledMap: () => false, tileset: () => tileset, tileWidth: () => 48, tileHeight: () => 48
  });
  f.context.$dataMap = map;
  f.index[1] = { renderer: 'ordinary', identity: 'ordinary-map', contractHash: crypto.createHash('sha256')
    .update(JSON.stringify({ ...map, tilesetNames: tileset.tilesetNames, flags: tileset.flags,
      tileWidth: 48, tileHeight: 48 })).digest('hex') };
}

for (const mz of [false, true]) {
  for (const lineEnding of ['\n', '\r\n']) {
    test((mz ? 'MZ' : 'MV') + ' producers qualify with ' + (lineEnding === '\n' ? 'LF' : 'CRLF'), () => {
      const f = fixture({ reviewed: true, mz, lineEnding });
      selectOrdinaryMap(f);
      assert.equal(f.PMJS.maps.selected(), 'ordinary-map');
      const owner = mz ? f.context.Tilemap : f.context.ShaderTilemap;
      const method = mz ? '_addNormalTile' : '_drawNormalTile';
      owner.prototype[method] = function customProducer() {};
      assert.equal(f.PMJS.maps.selected(), '');
      assert.equal(f.PMJS.maps.stats.reasons['tile-producer-changed:' + method], 1);
    });
  }
  test((mz ? 'MZ' : 'MV') + ' unknown producers preserve ordinary loading', () => {
    const f = fixture({ reviewed: true, mz, unknown: true });
    selectOrdinaryMap(f);
    assert.equal(f.PMJS.maps.selected(), '');
    assert.equal(f.PMJS.maps.stats.reasons['unreviewed-tile-producers'], 1);
  });
}
