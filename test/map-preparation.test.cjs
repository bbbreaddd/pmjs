'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const test = require('node:test');
const { temporaryDirectory } = require('./helpers/temp.cjs');
const { png } = require('./helpers/png.cjs');
const { compileRpgMap, compileTiledMap, engineTilemap } = require('../runner/map-demand.cjs');
const { prepareMaps, validTileDescriptor } = require('../runner/map-preparation.cjs');
const { parse } = require('../runner/cli.cjs');
const { validate } = require('../runner/index.cjs');
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
    assets:{tilePreparationVersion:'test',sourcePath:resolved,
    sourceIdentity(source){const file=resolved(source);return file?crypto.createHash('sha256').update(file).update(fs.readFileSync(file)).digest('hex'):null;},
    async processTiles(inputs,stage){jobs++;fs.writeFileSync(path.join(stage,'tiles-0.png'),png(50,50,Buffer.alloc(50*50*4,73)));
      return {ordinaryBytes:inputs.length*512*512*4,version:1,halo:1,pages:[{path:'tiles-0.png',width:50,height:50}],sources:inputs.map(input=>({width:512,height:512,
        regions:input.rectangles.map(rect=>({rect,atlas:[1,1,rect[2],rect[3]],page:0}))}))};},
    installTileSets(entries){installed=entries;return entries.length;}}};
  return {gameRoot,cacheRoot:path.join(root,'cache'),native,logger:{warn(){}},map,
    get jobs(){return jobs;},get installed(){return installed;}};
}
test('full visual planes, every tile-event page, table halves and all animation phases are demanded',()=>{
  const Tilemap=engineTilemap(core,false),names=['A1','A2','','','','B'];
  const map={width:1,height:1,tilesetId:1,data:[1,2048,0,0,0,0],events:[null,{pages:[{image:{tileId:2816}},{image:{tileId:2}}]}]};
  const result=compileRpgMap({map,tileset:{tilesetNames:names,flags:[]},Tilemap,mz:false});
  assert.equal(result.sources.find(s=>s.source.includes('A1')).rectangles.length,12);
  assert.deepEqual(result.sources.find(s=>s.source.includes('A2')).rectangles,[[0,24,24,12]]);
  assert.deepEqual(result.sources.find(s=>s.source.endsWith('B.png')).rectangles,[[0,0,48,48]]);
  assert.equal(map.events[1].pages.length,2);
});
test('Tiled recursively covers chunks, flipped GIDs, objects, spacing and arbitrary animation durations without editing them',()=>{
  const map={tilewidth:32,tileheight:32,tilesets:[{firstgid:1,image:'B.png',columns:4,tilewidth:32,tileheight:32,spacing:2,margin:1,
    tiles:[{id:0,animation:[{tileid:2,duration:137},{tileid:3,duration:29}]}]}],layers:[{layers:[{chunks:[{data:[0x80000001]}]}]},{objects:[{gid:2,width:32,height:32}]}]};
  const original=JSON.stringify(map),result=compileTiledMap(map);
  assert.deepEqual(result.sources[0].rectangles,[[1,1,32,32],[35,1,32,32],[69,1,32,32],[103,1,32,32]]);
  assert.equal(JSON.stringify(map),original);
  map.layers[1].objects[0].width=64;
  assert.equal(compileTiledMap(map).sources.length,0,'unreviewed object geometry preserves its entire source');
});
test('cache shares encoded snapshots, reuses positive entries, validates corruption and stale map inputs',async t=>{
  const f=fixture(t),a=await prepareMaps(f);
  assert.equal(a.selected,1);assert.equal(a.installed,1);assert.equal(f.jobs,1);
  assert.equal(fs.readdirSync(path.join(f.cacheRoot,'maps/sources')).length,1);
  assert.equal(f.installed[0].descriptor.sources[1].regions.length,0,'unused sheet is a sparse logical view');
  assert.equal((await prepareMaps(f)).hits,1);assert.equal(f.jobs,1);
  const entry=f.installed[0];fs.appendFileSync(path.join(entry.directory,'tiles-0.png'),'corruption');
  assert.equal((await prepareMaps(f)).generated,1);assert.equal(f.jobs,2);
  f.map.data[1]=2;fs.writeFileSync(path.join(f.gameRoot,'data/Map001.json'),JSON.stringify(f.map));
  assert.equal((await prepareMaps(f)).generated,1);assert.equal(f.jobs,3);
});
test('warm compilation preserves descriptors and map contracts; changed and damaged inputs rebuild demand',async t=>{
  const f=fixture(t),cold=await prepareMaps(f);
  const descriptor=structuredClone(f.installed[0].descriptor);
  const read = f.native.fs.readBytes;
  f.native.fs.readBytes = logical => {
    if (logical === 'data/Map001.json') throw new Error('unchanged map must reuse its verified visual contract');
    return read(logical);
  };
  const warm=await prepareMaps(f);
  assert.equal(warm.compilationHits,1);
  assert.deepEqual(warm.index,cold.index);
  assert.deepEqual(f.installed[0].descriptor,descriptor);
  assert.equal(warm.validation.hashedFiles,0);
  const verified=await prepareMaps({...f,verifyHashes:true});
  assert.ok(verified.validation.hashedFiles>0);
  assert.deepEqual(verified.index,cold.index);
  f.native.fs.readBytes = read;
  const root=path.join(f.cacheRoot,'maps');
  const indexFile=fs.readdirSync(root).find(file=>/^index-.*\.json$/.test(file));
  const indexPath=path.join(root,indexFile),damagedInputs=JSON.parse(fs.readFileSync(indexPath));
  Object.values(damagedInputs.mapInputs)[0].dependencies[0].hash='0'.repeat(64);
  fs.writeFileSync(indexPath,JSON.stringify(damagedInputs));
  assert.deepEqual((await prepareMaps(f)).index,cold.index,'damaged input receipts reconstruct the full visual contract');
  const index=JSON.parse(fs.readFileSync(indexPath));
  Object.values(index.compilations)[0].sources[0].rectangles=[];
  fs.writeFileSync(indexPath,JSON.stringify(index));
  const repaired=await prepareMaps(f);
  assert.equal(repaired.compilationHits,0);
  assert.deepEqual(repaired.index,cold.index);
  assert.deepEqual(f.installed[0].descriptor,descriptor);
  assert.equal((await prepareMaps(f)).compilationHits,1,'repaired compilation records remain reusable');
  f.map.data[1]=2;
  fs.writeFileSync(path.join(f.gameRoot,'data/Map001.json'),JSON.stringify(f.map));
  const changed=await prepareMaps(f);
  assert.equal(changed.compilationHits,0);
  assert.notDeepEqual(changed.index,cold.index);
  assert.equal((await prepareMaps(f)).compilationHits,1);
  fs.appendFileSync(path.join(f.gameRoot,'js/rpg_core.js'),'\n');
  assert.equal((await prepareMaps(f)).compilationHits,0);
  const beforeFlags=(await prepareMaps(f)).index;
  const sheets=JSON.parse(fs.readFileSync(path.join(f.gameRoot,'data/Tilesets.json')));
  sheets[1].flags[1]=16;
  fs.writeFileSync(path.join(f.gameRoot,'data/Tilesets.json'),JSON.stringify(sheets));
  const changedFlags=await prepareMaps(f);
  assert.equal(changedFlags.compilationHits,0);assert.notDeepEqual(changedFlags.index,beforeFlags);
});

test('unchanged map validation preserves published receipts and compilation index',async t=>{
  const f=fixture(t);
  await prepareMaps(f);
  await prepareMaps(f);
  const root=path.join(f.cacheRoot,'maps');
  const files=['verified-files.json',fs.readdirSync(root).find(file=>/^index-.*\.json$/.test(file))];
  const before=files.map(file=>fs.statSync(path.join(root,file),{bigint:true}));
  const warm=await prepareMaps(f);
  assert.equal(warm.installed,1);assert.equal(warm.generated,0);
  for(const [i,file] of files.entries()) {
    const after=fs.statSync(path.join(root,file),{bigint:true});
    assert.equal(after.ino,before[i].ino);assert.equal(after.mtimeNs,before[i].mtimeNs);
  }
});

test('missing sources and cancellation report individual failures and never install partial sets',async t=>{
  const f=fixture(t);fs.unlinkSync(path.join(f.gameRoot,'img/tilesets/C.png'));
  const missing=await prepareMaps(f);assert.equal(missing.refused,1);assert.match(missing.maps[0].reason,/missing tile source/);assert.equal(missing.installed,0);
  assert.equal((await prepareMaps(f)).negativeHits,1);
  const g=fixture(t);let cancel=false;
  const process=g.native.assets.processTiles;
  g.native.assets.processTiles=async(...args)=>{const result=await process(...args);cancel=true;return result;};
  const cancelled=await prepareMaps({...g,shouldCancel:()=>cancel});
  assert.equal(cancelled.cancelled,true);assert.equal(cancelled.installed,0);
  assert.equal(fs.readdirSync(path.join(g.cacheRoot,'maps/entries')).length,0);
});
test('unprofitable and unsupported decisions are cached without adding source snapshots',async t=>{
  const f=fixture(t);let attempts=0;
  f.native.assets.processTiles=async()=>{attempts++;throw Object.assign(new Error('unsupported rectangle'),{code:'PMJS_TILE_UNSUPPORTED'});};
  assert.equal((await prepareMaps(f)).refused,1);
  assert.equal((await prepareMaps(f)).negativeHits,1);assert.equal(attempts,1);
  assert.equal(fs.readdirSync(path.join(f.cacheRoot,'maps/sources')).length,0);
  const g=fixture(t),original=g.native.assets.processTiles;
  g.native.assets.processTiles=async(...args)=>{const descriptor=await original(...args);
    descriptor.pages[0].width=descriptor.pages[0].height=1024;
    fs.writeFileSync(path.join(args[1],'tiles-0.png'),png(1024,1024,Buffer.alloc(1024*1024*4,73)));return descriptor;};
  const refused=await prepareMaps(g);assert.match(refused.maps[0].reason,/not smaller/);
  assert.equal((await prepareMaps(g)).negativeHits,1);assert.equal(g.jobs,1);
  assert.equal(fs.readdirSync(path.join(g.cacheRoot,'maps/sources')).length,0);
});
test('leased decrypted sources are reused directly without a second encoded snapshot',async t=>{
  const f=fixture(t),decryptedKey='a'.repeat(64),directory=path.join(f.cacheRoot,'entries',decryptedKey);fs.mkdirSync(directory,{recursive:true});
  const file=path.join(directory,'source.png');fs.copyFileSync(path.join(f.gameRoot,'img/tilesets/B.png'),file);
  const sourcePath=f.native.assets.sourcePath,sourceIdentity=f.native.assets.sourceIdentity;
  f.native.assets.sourcePath=source=>source.startsWith('img/')?file:sourcePath(source);
  f.native.assets.sourceIdentity=source=>source.startsWith('img/')?crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'):sourceIdentity(source);
  const install=f.native.assets.installTileSets;
  f.native.assets.installTileSets=entries=>{
    for(const entry of entries) {
      entry.pageIdentities=entry.descriptor.pages.map(()=>'page');
      entry.snapshotIdentities=entry.descriptor.sources.map(()=>'snapshot');
    }
    return install(entries);
  };
  f.native.assets.installTileSetCatalog=entries=>entries.length;
  const report=await prepareMaps(f);assert.equal(report.selected,1);assert.equal(report.additionalSnapshotBytes,0);
  const lease=fs.readdirSync(path.join(f.cacheRoot,'maps')).find(name=>name.startsWith('.lease-'));
  assert.ok(JSON.parse(fs.readFileSync(path.join(f.cacheRoot,'maps',lease))).keys.includes(decryptedKey));
  const warm=await prepareMaps(f);assert.equal(warm.catalogHit,true);
  warm.releaseCacheLease();report.releaseCacheLease();
  assert.equal(f.installed[0].descriptor.sources[0].snapshot,file);
  assert.equal(f.installed[0].descriptor.sources.length,1,'VFS aliases share one logical source backing');
});
test('invalid sparse descriptors reject unsafe pages and logical bounds',()=>{
  assert.equal(validTileDescriptor({version:1,halo:1,sources:[],pages:[]}),false);
});
test('Tiled definitions sharing a sheet union demand and an unsupported use preserves the whole sheet',()=>{
  const map={tilewidth:32,tileheight:32,tilesets:[{firstgid:1,image:'shared.png',columns:4,tilewidth:32,tileheight:32},
    {firstgid:10,image:'shared.png',columns:8,tilewidth:32,tileheight:32}],layers:[{data:[2,13]}]};
  assert.deepEqual(compileTiledMap(map).sources[0].rectangles,[[32,0,32,32],[96,0,32,32]]);
  map.layers.push({objects:[{gid:13,width:64,height:32}]});
  assert.equal(compileTiledMap(map).sources.length,0);
});
test('map inputs use the game VFS for case folding, external definitions and dependency identities',async t=>{
  const f=fixture(t),ordinary=await prepareMaps({...f,width:48,height:48});
  fs.mkdirSync(path.join(f.gameRoot,'maps'));
  fs.writeFileSync(path.join(f.gameRoot,'maps/map1.json'),JSON.stringify({tilewidth:48,tileheight:48,
    tilesets:[{firstgid:1,source:'External.JSON'}],layers:[{data:[1]}]}));
  fs.writeFileSync(path.join(f.gameRoot,'maps/external.json'),JSON.stringify({image:'B.png',columns:10,tilewidth:48,tileheight:48}));
  const result=await prepareMaps({...f,width:48,height:48});
  assert.equal(result.maps[0].renderer,'tiled');assert.equal(result.selected,1);
  assert.equal(result.compilationHits,0,'a new override replaces the cached ordinary map');
  assert.equal(result.index[1].renderer,'tiled');
  const warm=await prepareMaps({...f,width:48,height:48});
  assert.equal(warm.compilationHits,1);assert.deepEqual(warm.index,result.index);
  fs.writeFileSync(path.join(f.gameRoot,'maps/external.json'),JSON.stringify({image:'B.png',columns:10,tilewidth:48,tileheight:48,margin:1}));
  const changed=await prepareMaps({...f,width:48,height:48});
  assert.equal(changed.compilationHits,0);assert.notDeepEqual(changed.index,result.index);
  fs.unlinkSync(path.join(f.gameRoot,'maps/map1.json'));
  const restored=await prepareMaps({...f,width:48,height:48});
  assert.equal(restored.maps[0].renderer,'mv');
  assert.equal(restored.compilationHits,0);assert.deepEqual(restored.index,ordinary.index);
});
test('runner map override validates values and the master switch disables maps',t=>{
  const f = fixture(t);
  const input = { addon: __filename, bootstrap: __filename, gameRoot: f.gameRoot, saveRoot: f.cacheRoot };

  assert.equal(validate(input).assetPreparation.maps,true);
  assert.equal(validate({...input,mapPreparation:'on'}).assetPreparation.maps,true);
  assert.equal(validate({...input,mapPreparation:'off'}).assetPreparation.maps,false);
  assert.equal(parse(['--map-preparation','off']).mapPreparation,'off');
  assert.throws(()=>validate({mapPreparation:'maybe'}),/mapPreparation/);
  assert.equal(validate({...input,assetPreparation:'off',mapPreparation:'on'}).assetPreparation.maps,false);
});

test('metadata changes with identical VFS backing bytes refresh installation identities; content changes reject',async t=>{
  const f=fixture(t),identity=f.native.assets.sourceIdentity;let revision=0;
  f.native.assets.sourceIdentity=source=>identity(source)+':'+revision;
  const process=f.native.assets.processTiles;
  f.native.assets.processTiles=async(...args)=>{const descriptor=await process(...args);revision++;return descriptor;};
  const report=await prepareMaps(f);assert.equal(report.selected,1);assert.ok(report.identityRefreshes>0);
  assert.equal(f.installed[0].descriptor.sources[0].sourceIdentity,f.native.assets.sourceIdentity('img/tilesets/B.png'));
  const g=fixture(t),pack=g.native.assets.processTiles;
  g.native.assets.processTiles=async(...args)=>{const descriptor=await pack(...args);
    fs.appendFileSync(path.join(g.gameRoot,'data/Map001.json'),' ');return descriptor;};
  const changed=await prepareMaps(g);assert.equal(changed.selected,0);assert.match(changed.maps[0].reason,/map dependency changed.*Map001/);
});

test('warm map catalogs skip map inputs and dependency scans; viewport changes rebuild',async t=>{
  const f=fixture(t);
  const install=f.native.assets.installTileSets;
  f.native.assets.installTileSets=entries=>{
    for(const entry of entries) {
      entry.pageIdentities=entry.descriptor.pages.map(()=>'page-identity');
      entry.snapshotIdentities=entry.descriptor.sources.map(()=>'snapshot-identity');
    }
    return install(entries);
  };
  f.native.assets.installTileSetCatalog=entries=>entries.length;
  const cold=await prepareMaps(f);
  assert.equal(cold.installed,1);
  const read=f.native.fs.readBytes, sourceIdentity=f.native.assets.sourceIdentity;
  f.native.fs.readBytes=()=>{throw new Error('unexpected map read');};
  f.native.assets.sourceIdentity=()=>{throw new Error('unexpected dependency scan');};
  try {
    const warm=await prepareMaps(f);
    assert.equal(warm.catalogHit,true);
    assert.deepEqual(warm.index,cold.index);
    assert.deepEqual(warm.maps,cold.maps);
    assert.equal(warm.generated,0);
    warm.releaseCacheLease();
  } finally {f.native.fs.readBytes=read;f.native.assets.sourceIdentity=sourceIdentity;}
  const resized=await prepareMaps({...f,width:640,height:480});
  assert.equal(resized.catalogHit,undefined);
  assert.equal(resized.installed,1);
  resized.releaseCacheLease();cold.releaseCacheLease();
});

test('observed stale map catalogs recompile changed inputs on the following launch', async t => {
  const f = fixture(t);
  const install = f.native.assets.installTileSets;
  f.native.assets.installTileSets = entries => {
    for (const entry of entries) {
      entry.pageIdentities = entry.descriptor.pages.map(() => 'page-identity');
      entry.snapshotIdentities = entry.descriptor.sources.map(() => 'snapshot-identity');
    }
    return install(entries);
  };
  f.native.assets.installTileSetCatalog = entries => entries.length;
  const cold = await prepareMaps(f);
  const warm = await prepareMaps(f);
  assert.equal(warm.catalogHit, true);
  const file = path.join(f.gameRoot, 'data/Map001.json');
  const map = JSON.parse(fs.readFileSync(file)); map.data[0] = 2;
  fs.writeFileSync(file, JSON.stringify(map));
  assert.equal(warm.invalidateCatalog(), true);
  const refreshed = await prepareMaps(f);
  assert.equal(refreshed.catalogHit, undefined);
  assert.notDeepEqual(refreshed.index, warm.index);
  const next = await prepareMaps(f);
  assert.equal(next.catalogHit, true);
  for (const result of [cold, warm, refreshed, next]) result.releaseCacheLease();
});

test('installation failures clear native entries before releasing their cache lease', async t => {
  for (const failure of ['cancel', 'catalog']) {
    const f = fixture(t), install = f.native.assets.installTileSets;
    const root = path.join(f.cacheRoot, 'maps');
    const previous = await prepareMaps(f);
    assert.equal(previous.installed, 1);
    let installed = false, cleared = false;
    if (failure === 'catalog') f.native.assets.installTileSetCatalog = entries => entries.length;
    f.native.assets.installTileSets = entries => {
      if (entries.length) {
        installed = true;
        if (failure === 'catalog') {
          for (const entry of entries) {
            entry.pageIdentities = entry.descriptor.pages.map(() => 'page-identity');
            entry.snapshotIdentities = entry.descriptor.sources.map(() => 'snapshot-identity');
          }
          const { checksum } = require('../runner/preparation-catalog.cjs');
          fs.mkdirSync(path.join(root, 'catalog-' + checksum(path.resolve(f.gameRoot)) + '.json'));
        }
      } else if (installed) {
        assert.ok(fs.readdirSync(root).some(file => file.startsWith('.lease-')),
          'native references must be removed while their lease is still live');
        cleared = true;
      }
      return install(entries);
    };
    const result = await prepareMaps({ ...f, shouldCancel: () => failure === 'cancel' && installed });
    assert.equal(installed, true);
    assert.equal(cleared, true);
    assert.equal(result.installed, 0);
    assert.deepEqual(f.installed, []);
    assert.deepEqual(f.native.assets.preparedMapIndex, {});
    assert.equal(result.releaseCacheLease, undefined);
    assert.equal(fs.readdirSync(root).some(file => file.startsWith('.lease-')), false);
    assert.ok(result.error);
  }
});
