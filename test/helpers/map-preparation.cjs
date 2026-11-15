'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { temporaryDirectory } = require('./temp.cjs');
const { preparationLocks } = require('./preparation-lock.cjs');
const { png } = require('./png.cjs');
const core = `\nfunction Tilemap(){}\nTilemap.prototype._drawNormalTile=function(target,id){target.bltImage(this.bitmaps[5],0,0,48,48);};\nTilemap.prototype._drawAutotile=function(target,id){target.bltImage(this.bitmaps[0],this.animationFrame*24,0,24,24);};\nTilemap.prototype._drawTableEdge=function(target,id){target.bltImage(this.bitmaps[1],0,24,24,12);};\nTilemap.isAutotile=function(id){return id>=2048;};Tilemap.isTileA2=function(id){return id>=2816;};\nfunction ShaderTilemap(){}`;
function fixture(t) {
  const root=temporaryDirectory('pmjs-map-preparation-'),gameRoot=path.join(root,'game');
  for(const dir of ['data','js','img/tilesets']) fs.mkdirSync(path.join(gameRoot,dir),{recursive:true});
  fs.writeFileSync(path.join(gameRoot,'js/rpg_core.js'),core);fs.writeFileSync(path.join(gameRoot,'js/plugins.js'),'var $plugins=[];');
  const names=['','','','','','B','C'];
  fs.writeFileSync(path.join(gameRoot,'data/Tilesets.json'),JSON.stringify([null,{tilesetNames:names,flags:[]}])) ;
  fs.writeFileSync(path.join(gameRoot,'data/System.json'),'{}');
  const map={width:2,height:1,tilesetId:1,data:[1,0,0,0,0,0,0,0,0,0,0,0],events:[]};
  fs.writeFileSync(path.join(gameRoot,'data/Map001.json'),JSON.stringify(map));
  const bytes=png(512,512,Buffer.alloc(512*512*4,73));
  for(const name of ['B','C']) fs.writeFileSync(path.join(gameRoot,'img/tilesets',name+'.png'),bytes);
  let jobs=0,installed=[];
  function resolved(source) {
    let file=gameRoot;
    for(const part of source.split('/')) {
      if(!fs.existsSync(file)) return null;
      const name=fs.readdirSync(file).find(name=>name.toLowerCase()===part.toLowerCase());
      if(!name) return null;file=path.join(file,name);
    }
    return file;
  }
  const native={fs:{readBytes(source){const file=resolved(source);return file?fs.readFileSync(file):null;},
    exists(source){return !!resolved(source);},readDirectory(source){const file=resolved(source);return file?fs.readdirSync(file):null;}},
    assets:{...preparationLocks(),tilePreparationVersion:'test',sourcePath:resolved,
    sourceIdentity(source){const file=resolved(source);return file?crypto.createHash('sha256').update(file).update(fs.readFileSync(file)).digest('hex'):null;},
    async processTiles(inputs,stage){jobs++;fs.writeFileSync(path.join(stage,'tiles-0.png'),png(50,50,Buffer.alloc(50*50*4,73)));
      return {ordinaryBytes:inputs.length*512*512*4,version:1,halo:1,pages:[{path:'tiles-0.png',width:50,height:50}],sources:inputs.map(input=>({width:512,height:512,
        regions:input.rectangles.map(rect=>({rect,atlas:[1,1,rect[2],rect[3]],page:0}))}))};},
    installTileSets(entries){installed=entries;return {accepted:entries.map(entry=>entry.identity),rejected:[]};}}};
  return {gameRoot,cacheRoot:path.join(root,'cache'),native,logger:{warn(){}},map,
    get jobs(){return jobs;},get installed(){return installed;}};
}

module.exports = { fixture, core };
