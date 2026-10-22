'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const test = require('node:test');
const { temporaryDirectory } = require('./helpers/temp.cjs');
const { preparationLocks } = require('./helpers/preparation-lock.cjs');
const { png } = require('./helpers/png.cjs');
const { compileRpgMap, compileTiledMap, engineTilemap } = require('../runner/map-demand.cjs');
const { prepareMaps, validTileDescriptor, engineContract } = require('../runner/map-preparation.cjs');
const { prepareGameAssets } = require('../runner/preparation.cjs');
const { parse } = require('../runner/cli.cjs');
const { validate } = require('../runner/index.cjs');
const { fixture, core } = require('./helpers/map-preparation.cjs');
function cachePath(f) { return path.join(f.cacheRoot, 'preparation-v1', crypto.createHash('sha256').update(JSON.stringify(path.resolve(f.gameRoot))).digest('hex').slice(0,16)); }
function readIndex(f) { return JSON.parse(fs.readFileSync(path.join(cachePath(f),'preparation-state.json'))).data.indices.maps; }
function writeIndex(f, value) {
  const file = path.join(cachePath(f),'preparation-state.json'), state = JSON.parse(fs.readFileSync(file));
  state.data.indices.maps = value;
  state.checksum = crypto.createHash('sha256').update(JSON.stringify(state.data)).digest('hex');
  fs.writeFileSync(file, JSON.stringify(state));
}
test('map preparation retains truthy plugin status semantics without executing the manifest', async () => {
  const manifest = Buffer.from(`var $plugins = [
    {"name":"Truthy","status":1,"parameters":{"mode":"kept"}},
    {"name":"Placeholder","status":0,"parameters":{}},
    {"name":"Boolean","status":true,"parameters":{}}
  ]; throw new Error("must not execute");`);
  const dependency = logical => ({ logical, hash: logical });
  const game = {
    exists: logical => logical === 'js/plugins.js',
    read(logical) {
      if (logical === 'js/rpg_core.js') return { bytes: Buffer.from(core), dependency: dependency(logical) };
      if (logical === 'js/plugins.js') return { bytes: manifest, dependency: dependency(logical) };
      throw new Error('unexpected read: ' + logical);
    },
    async dependency(logical) { return dependency(logical); }
  };
  const result = await engineContract(game, false);
  assert.deepEqual(result.identity.plugins.map(plugin => plugin.name), ['Truthy', 'Boolean']);
  assert.deepEqual(result.identity.plugins[0].parameters, { mode: 'kept' });
});

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
  assert.equal(a.nativePacks,1);
  assert.equal(a.indexedCopies,0);
  assert.equal(fs.readdirSync(path.join(cachePath(f),'maps/sources')).length,1);
  assert.equal(f.installed[0].descriptor.sources[1].regions.length,0,'unused sheet is a sparse logical view');
  assert.equal((await prepareMaps(f)).hits,1);assert.equal(f.jobs,1);
  const entry=f.installed[0];fs.appendFileSync(path.join(entry.directory,'tiles-0.png'),'corruption');
  assert.equal((await prepareMaps(f)).generated,1);assert.equal(f.jobs,2);
  f.map.data[1]=2;fs.writeFileSync(path.join(f.gameRoot,'data/Map001.json'),JSON.stringify(f.map));
  assert.equal((await prepareMaps(f)).generated,1);assert.equal(f.jobs,3);
});

test('enabled plugin dependencies are stream-hashed without loading plugin source into JavaScript', async t => {
  const f = fixture(t), pluginSource = path.join(f.gameRoot, 'js/plugins/LargePlugin.js');
  fs.mkdirSync(path.dirname(pluginSource), { recursive: true });
  fs.writeFileSync(pluginSource, 'window.pluginValue = 1;');
  fs.writeFileSync(path.join(f.gameRoot, 'js/plugins.js'),
    'var $plugins = [{"name":"LargePlugin","status":true,"parameters":{}}];');
  const reads = [], readBytes = f.native.fs.readBytes;
  f.native.fs.readBytes = logical => { reads.push(logical); return readBytes(logical); };
  const first = await prepareMaps(f);
  assert.equal(first.generated, 1);
  assert.ok(!reads.includes('js/plugins/LargePlugin.js'));
  fs.writeFileSync(pluginSource, 'window.pluginValue = 2;');
  const second = await prepareMaps(f);
  assert.equal(second.generated, 1, 'plugin content remains part of the engine contract');
  assert.ok(!reads.includes('js/plugins/LargePlugin.js'));
});

test('shared engine changes during warm map reuse reject installation at the final dependency check', async t => {
  const f = fixture(t);
  await prepareMaps(f);
  const engine = path.join(f.gameRoot, 'js/rpg_core.js');
  let changed = false;
  const warm = await prepareMaps({ ...f, onProgress(progress) {
    if (!changed && progress.phase === 'map-validate' && progress.completed > 0) {
      fs.appendFileSync(engine, '\nchanged during map preparation');
      changed = true;
    }
  } });
  assert.equal(changed, true);
  assert.match(warm.error, /map dependency changed during preparation/);
  assert.equal(warm.installed, 0);
});

test('ordinary map preparation reuses shared dependency checks; full verification repeats them', async t => {
  const f = fixture(t), sourceIdentity = f.native.assets.sourceIdentity;
  fs.writeFileSync(path.join(f.gameRoot, 'data/Map002.json'), JSON.stringify({ ...f.map, data: [2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] }));
  let checks = 0;
  f.native.assets.sourceIdentity = function(source) {
    if (source === 'img/tilesets/B.png') ++checks;
    return sourceIdentity(source);
  };
  const ordinary = await prepareMaps(f), ordinaryChecks = checks;
  checks = 0;
  const verified = await prepareMaps({ ...f, cacheRoot: path.join(cachePath(f), 'verified'), verifyHashes: true });
  assert.deepEqual(verified.index, ordinary.index);
  assert.equal(verified.installed, 2);
  assert.ok(checks > ordinaryChecks);
});
test('warm compilation preserves descriptors and map contracts; changed and damaged inputs rebuild demand',async t=>{
  const f=fixture(t),cold=await prepareMaps(f);
  const compiledDemand = Object.values(readIndex(f).compilations)[0];
  assert.ok(Number.isFinite(compiledDemand.geometryBytes));
  assert.equal(Object.hasOwn(compiledDemand, 'geometryDensity'), false);
  assert.equal(Object.hasOwn(compiledDemand, 'geometryWidth'), false);
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
  const damagedInputs = readIndex(f);
  Object.values(damagedInputs.mapInputs)[0].dependencies[0].hash='0'.repeat(64);
  writeIndex(f, damagedInputs);
  assert.deepEqual((await prepareMaps(f)).index,cold.index,'damaged input records reconstruct the full visual contract');
  const index = readIndex(f);
  Object.values(index.compilations)[0].sources[0].rectangles=[];
  writeIndex(f, index);
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

test('warm map output keys are reused only while tile source hashes match', async t => {
  const f = fixture(t), cold = await prepareMaps(f);
  const before = readIndex(f).mapInputs['Map001.json'].entryKey;
  const source = path.join(f.gameRoot, 'img/tilesets/B.png');
  fs.appendFileSync(source, 'changed');
  const warmDemand = await prepareMaps(f);
  assert.equal(warmDemand.compilationHits, 1);
  assert.equal(warmDemand.generated, 1);
  assert.notEqual(readIndex(f).mapInputs['Map001.json'].entryKey, before);
  assert.notEqual(warmDemand.index[1].identity, cold.index[1].identity);
});

test('large Tiled maps keep bounded cached contracts across reuse, changes and legacy migration', async t => {
  const f = { ...fixture(t), width: 64, height: 64 };
  fs.mkdirSync(path.join(f.gameRoot, 'maps'));
  const map = { width: 256, height: 256, tilewidth: 48, tileheight: 48,
    tilesets: [{ firstgid: 1, image: 'B.png', columns: 10, tilewidth: 48, tileheight: 48 }],
    layers: [{ data: Array(256 * 256).fill(1) }] };
  const source = path.join(f.gameRoot, 'maps/Map1.json');
  fs.writeFileSync(source, JSON.stringify(map));
  const cold = await prepareMaps(f);
  assert.equal(cold.installed, 1);
  assert.equal(cold.index[1].contractHash, crypto.createHash('sha256').update(JSON.stringify(map)).digest('hex'));
  const cached = readIndex(f);
  assert.ok(JSON.stringify(cached).length < 16 * 1024, 'cached metadata must not retain tile layers');
  const read = f.native.fs.readBytes;
  f.native.fs.readBytes = logical => {
    assert.notEqual(logical, 'maps/Map1.json', 'warm preparation must reuse verified demand');
    return read(logical);
  };
  const warm = await prepareMaps(f);
  assert.equal(warm.compilationHits, 1);
  assert.deepEqual(warm.index, cold.index);
  f.native.fs.readBytes = read;
  cached.compiler = 'map-demand-v5';
  cached.mapInputs['Map001.json'].contract = map;
  writeIndex(f, cached);
  const migrated = await prepareMaps(f);
  assert.equal(migrated.compilationHits, 0);
  assert.deepEqual(migrated.index, cold.index);
  assert.ok(JSON.stringify(readIndex(f)).length < 16 * 1024);
  map.layers[0].data[0] = 2;
  fs.writeFileSync(source, JSON.stringify(map));
  const changed = await prepareMaps(f);
  assert.equal(changed.compilationHits, 0);
  assert.notEqual(changed.index[1].contractHash, cold.index[1].contractHash);
});

test('map output invalidation reuses demand while demand invalidation recompiles it', async t => {
  const f = fixture(t);
  const first = await prepareGameAssets({ ...f, images: false, maps: true });
  const identity = first.maps.index[1].identity;
  assert.equal(f.jobs, 1);
  await first.invalidate(identity);
  const outputRepair = await prepareGameAssets({ ...f, images: false, maps: true });
  assert.equal(outputRepair.maps.compilationHits, 1);
  assert.equal(f.jobs, 2);
  const oldFormatIndex = readIndex(f);
  delete Object.values(oldFormatIndex.mapInputs)[0].compilationKey;
  writeIndex(f, oldFormatIndex);
  await outputRepair.invalidate({ source: identity, mapDemand: true });
  const demandRepair = await prepareGameAssets({ ...f, images: false, maps: true });
  assert.equal(demandRepair.maps.compilationHits, 0);
  assert.equal(f.jobs, 3);
  assert.equal((await prepareGameAssets({ ...f, images: false, maps: true })).maps.compilationHits, 1);
});

test('demand invalidation escalates an already failed map output record', async t => {
  const f = fixture(t);
  const first = await prepareGameAssets({ ...f, images: false, maps: true });
  const identity = first.maps.index[1].identity;
  await first.invalidate(identity);
  await first.invalidate({ source: identity, mapDemand: true });
  const repaired = await prepareGameAssets({ ...f, images: false, maps: true });
  assert.equal(repaired.maps.compilationHits, 0);
  assert.equal(f.jobs, 2);
});

test('demand invalidation recompiles maps that shared a compilation identity', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.gameRoot, 'data/Map002.json'), JSON.stringify(f.map));
  const first = await prepareGameAssets({ ...f, images: false, maps: true });
  assert.equal(first.maps.index[1].identity, first.maps.index[2].identity);
  assert.equal(f.jobs, 1);
  await first.invalidate({ source: first.maps.index[1].identity, mapDemand: true });
  const repaired = await prepareGameAssets({ ...f, images: false, maps: true });
  assert.equal(repaired.maps.selected, 2);
  assert.equal(repaired.maps.compilationHits, 0);
  assert.equal(f.jobs, 2);
});

test('a thrown map phase retains cached results and recovers on the next launch', async t => {
  const f = fixture(t);
  const first = await prepareGameAssets({ ...f, images: false, maps: true });
  assert.equal(first.maps.selected, 1);
  const processTiles = f.native.assets.processTiles;
  f.native.assets.processTiles = undefined;
  const unavailable = await prepareGameAssets({ ...f, images: false, maps: true });
  assert.match(unavailable.maps.error, /tile preparation unavailable/);
  const state = JSON.parse(fs.readFileSync(path.join(cachePath(f), 'preparation-state.json')));
  assert.equal(Object.keys(state.data.results).filter(name => name.startsWith('maps/')).length, 1);
  f.native.assets.processTiles = processTiles;
  const recovered = await prepareGameAssets({ ...f, images: false, maps: true });
  assert.equal(recovered.maps.compilationHits, 1);
  assert.equal(f.jobs, 1);
});

test('portable map metadata and atlas pages are checked against recipient inputs',async t=>{
  const f=fixture(t),cold=await prepareMaps(f);
  assert.equal(cold.selected,1);
  const identity=Object.values(cold.index)[0].identity;
  const entryDirectory=path.join(cachePath(f),'maps/entries',identity);
  const state=JSON.parse(fs.readFileSync(path.join(cachePath(f),'preparation-state.json')));
  const manifest=state.data.results[path.relative(cachePath(f),entryDirectory).split(path.sep).join('/')];
  const bundle=temporaryDirectory('pmjs-map-index-');
  const output=path.join(bundle,'assets/maps',identity,'tiles-0.png');
  fs.mkdirSync(path.dirname(output),{recursive:true});
  fs.copyFileSync(path.join(entryDirectory,'tiles-0.png'),output);
  const portableIndex={compiler:manifest.compiler,compilations:cold.compilations,
    mapInputs:Object.fromEntries(Object.entries(cold.mapInputs).map(([name,input])=>
      [name,{...input,dependencies:input.dependencies.map(({logical,hash})=>({logical,hash}))}])),
    entries:[{identity,descriptor:manifest.descriptor,
      outputs:[{path:path.posix.join('assets/maps',identity,'tiles-0.png'),
        hash:crypto.createHash('sha256').update(fs.readFileSync(output)).digest('hex')}]}]};
  portableIndex.entries.push({ ...portableIndex.entries[0], descriptor: null });
  const imported=await prepareMaps({...f,cacheRoot:path.join(bundle,'recipient-cache'),
    portableIndex,portableAssetRoot:bundle});
  assert.equal(imported.selected,1);
  assert.equal(imported.compilationHits,1);
  assert.equal(f.jobs,1,'valid indexed atlas avoids native repacking');
  fs.appendFileSync(output,'damaged');
  const damaged=await prepareMaps({...f,cacheRoot:path.join(bundle,'damaged-cache'),
    portableIndex,portableAssetRoot:bundle});
  assert.equal(damaged.selected,1);
  assert.equal(f.jobs,2,'corrupt page falls back to native preparation');
  for (const size of [8, 24]) {
    const invalid = Buffer.alloc(size);
    fs.writeFileSync(output, invalid);
    portableIndex.entries[0].outputs[0].hash = crypto.createHash('sha256').update(invalid).digest('hex');
    const jobs = f.jobs;
    const rejected = await prepareMaps({...f, cacheRoot:path.join(bundle, 'invalid-header-'+size),
      portableIndex, portableAssetRoot:bundle});
    assert.equal(rejected.selected, 1);
    assert.equal(f.jobs, jobs + 1, 'matching checksum cannot bypass PNG header validation');
  }
  fs.appendFileSync(path.join(f.gameRoot,'data/Map001.json'),' ');
  const stale=await prepareMaps({...f,cacheRoot:path.join(bundle,'stale-cache'),
    portableIndex,portableAssetRoot:bundle});
  assert.equal(stale.compilationHits,0,'changed map input rejects compiled metadata');
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
  assert.equal(fs.readdirSync(path.join(cachePath(g),'maps/entries')).length,0);
});
test('provably unprofitable geometry avoids native packing and snapshots; uncertain cases retain exact admission', async t => {
  const f = fixture(t);
  for (const name of ['B', 'C']) fs.writeFileSync(path.join(f.gameRoot, 'img/tilesets', name + '.png'),
    png(48, 48, Buffer.alloc(48 * 48 * 4, 73)));
  const map = { ...f.map, width: 20, height: 20, data: [...Array(400).fill(1), ...Array(2000).fill(0)] };
  fs.writeFileSync(path.join(f.gameRoot, 'data/Map001.json'), JSON.stringify(map));
  const rejected = await prepareMaps(f);
  assert.equal(rejected.earlyRefusals, 1); assert.equal(f.jobs, 0); assert.equal(rejected.installed, 0);
  assert.equal(fs.readdirSync(path.join(cachePath(f), 'maps/sources')).length, 0);
  assert.equal((await prepareMaps(f)).negativeHits, 1);
  const ordinary = fixture(t), accepted = await prepareMaps(ordinary);
  assert.equal(accepted.earlyRefusals, 0); assert.equal(ordinary.jobs, 1); assert.equal(accepted.installed, 1);
});

test('unprofitable and unsupported decisions are cached without adding source snapshots',async t=>{
  const f=fixture(t);let attempts=0;
  f.native.assets.processTiles=async()=>{attempts++;throw Object.assign(new Error('unsupported rectangle'),{code:'PMJS_TILE_UNSUPPORTED'});};
  assert.equal((await prepareMaps(f)).refused,1);
  assert.equal((await prepareMaps(f)).negativeHits,1);assert.equal(attempts,1);
  assert.equal(fs.readdirSync(path.join(cachePath(f),'maps/sources')).length,0);
  const g=fixture(t),original=g.native.assets.processTiles;
  g.native.assets.processTiles=async(...args)=>{const descriptor=await original(...args);
    descriptor.pages[0].width=descriptor.pages[0].height=1024;
    fs.writeFileSync(path.join(args[1],'tiles-0.png'),png(1024,1024,Buffer.alloc(1024*1024*4,73)));return descriptor;};
  const refused=await prepareMaps(g);assert.match(refused.maps[0].reason,/not smaller/);
  assert.equal((await prepareMaps(g)).negativeHits,1);assert.equal(g.jobs,1);
  assert.equal(fs.readdirSync(path.join(cachePath(g),'maps/sources')).length,0);
});
test('leased decrypted sources are reused directly without a second encoded snapshot',async t=>{
  const f=fixture(t),decryptedKey='a'.repeat(64),directory=path.join(cachePath(f),'entries',decryptedKey);fs.mkdirSync(directory,{recursive:true});
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
  const lease=fs.readdirSync(cachePath(f)).find(name=>name.startsWith('.lease-'));
  assert.ok(JSON.parse(fs.readFileSync(path.join(cachePath(f),lease))).keys.includes(decryptedKey));
  const warm=await prepareMaps(f);assert.equal(warm.validation.hashedFiles,0);
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
