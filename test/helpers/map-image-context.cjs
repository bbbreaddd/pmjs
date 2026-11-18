'use strict';
const fs=require('node:fs');
const vm=require('node:vm');
const crypto=require('node:crypto');
const {loadPmjsRuntime}=require('./runtime-context.cjs');
const source=fs.readFileSync(require.resolve('../../js/pmjs-rpgmaker/map-images.js'),'utf8');
function fixture({ reviewed = false, mz = false, lineEnding = '\n', unknown = false, mapData = null, moduleSource = source, onParserLoad = null } = {}) {
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
    loadParserTileset(url,hue){loads.push({url,hue,context:PMJS.images.preparedTileSet});return onParserLoad ? onParserLoad.call(this,url,hue) : {};},_generateCacheKey(url,hue){return url+':'+hue;}};
  Bitmap.prototype._requestImage=function(){loads.push({context:PMJS.images.preparedTileSet,retry:true});};
  const data=mapData || {tilesets:[{firstgid:1}],layers:[{data:[1,2]}]};
  const index={1:{renderer:'tiled',identity:'set-a',contractHash:crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex')}};
  const context={PMJS,NativeHost:{assets:{mapPreparationEnabled:true,preparedMapIndex:index}},ImageManager,
    Tilemap,ShaderTilemap:mz?undefined:ShaderTilemap,Bitmap,$dataMap:{},$gameMap:{mapId:()=>1,tiledData:data,isTiledMap:()=>true},
    __pmjsBuiltinRequire:require};
  const adapter = reviewed ? moduleSource.replace(/'[a-f0-9]{64}'/g,
    "'" + crypto.createHash('sha256').update(producerSource).digest('hex') + "'") : moduleSource;
  vm.runInNewContext(adapter,context);
  for(const definition of definitions) {
    const target=definition.getTarget();if(typeof target[definition.method]==='function')
      target[definition.method]=definition.wrap(target[definition.method]);
  }
  PMJS.maps.tiledContract=()=>true;
  return {context,PMJS,loads,ImageManager,Bitmap,data,index};
}
module.exports={fixture};
