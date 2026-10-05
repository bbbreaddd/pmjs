'use strict';
const assert=require('node:assert/strict');
const test=require('node:test');
const fs=require('node:fs');
const vm=require('node:vm');
const crypto=require('node:crypto');
const source=fs.readFileSync(require.resolve('../js/pmjs-rpgmaker/map-images.js'),'utf8');
function fixture() {
  const definitions=[],loads=[];
  function Tilemap() {} function ShaderTilemap() {} function Bitmap() {}
  for(const name of ['_drawNormalTile','_drawAutotile','_drawTableEdge','_isTableTile']) Tilemap.prototype[name]=()=>{};
  const PMJS={images:{},methods:{wrap(definition){definitions.push(definition);}}};
  const ImageManager={loadTileset(url,hue){loads.push({url,hue,context:PMJS.images.preparedTileSet});return {};},
    loadParserTileset(url,hue){return this.loadTileset(url,hue);},_generateCacheKey(url,hue){return url+':'+hue;}};
  Bitmap.prototype._requestImage=function(){loads.push({context:PMJS.images.preparedTileSet,retry:true});};
  const data={tilesets:[{firstgid:1}],layers:[{data:[1,2]}]};
  const index={1:{renderer:'tiled',identity:'set-a',contractHash:crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex')}};
  const context={PMJS,NativeHost:{assets:{mapPreparationEnabled:true,preparedMapIndex:index}},ImageManager,
    Tilemap,ShaderTilemap,Bitmap,$dataMap:{},$gameMap:{mapId:()=>1,tiledData:data},
    __pmjsBuiltinRequire:require};
  vm.runInNewContext(source,context);
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
  f.index[1].renderer='mv';f.ImageManager.loadTileset('Sheet',0);
  assert.equal(f.PMJS.maps.stats.reasons['unreviewed-tile-producers'],1);
});
