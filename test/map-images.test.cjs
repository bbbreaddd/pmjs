'use strict';
const assert=require('node:assert/strict');
const test=require('node:test');
const crypto=require('node:crypto');
const {fixture}=require('./helpers/map-image-context.cjs');
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

test('one parser batch validates once and preserves image scopes, target ownership and unused sheets',()=>{
 const f=fixture();let checks=0;f.PMJS.maps.tiledContract=()=>{checks++;return true;};
 f.index[1].sources=['img/tilesets/Used.png'];f.PMJS.images.preparedTileSet='caller';
 const names=['../img/tilesets/Used.png','../img/tilesets/Unused.png','../img/tilesets/Used.png'];
 const tail={retained:true},bitmaps=[null,null,null,tail];
 f.PMJS.maps.loadParserTilesets(names,bitmaps);
 assert.equal(checks,1);assert.equal(f.PMJS.images.preparedTileSet,'caller');
 assert.deepEqual(f.loads.map(x=>x.context),['set-a','','set-a']);assert.equal(bitmaps[0]._pmjsPreparedTileSet,'set-a');
 assert.equal(bitmaps[1]._pmjsPreparedTileSet,undefined);assert.equal(bitmaps[3],tail);
 assert.deepEqual(names,['../img/tilesets/Used.png','../img/tilesets/Unused.png','../img/tilesets/Used.png']);
});
test('each new parser batch observes map edits and refuses stale prepared content',()=>{
 const f=fixture(),bitmaps=[];f.PMJS.maps.loadParserTilesets(['Used.png'],bitmaps);
 f.data.layers[0].data[0]=99;f.PMJS.maps.loadParserTilesets(['Used.png'],bitmaps);
 assert.equal(f.loads.at(-1).context,'');assert.equal(bitmaps[0]._pmjsPreparedTileSet,undefined);
 assert.equal(f.PMJS.maps.stats.reasons['tiled-content-changed'],1);
});
test('parser overrides keep their ordinary per-image callbacks and mutation checks',()=>{
 const f=fixture(),original=f.ImageManager.loadParserTileset;let callbacks=0;
 f.ImageManager.loadParserTileset=function(){if(++callbacks===2)f.data.layers[0].data[0]=99;return original.apply(this,arguments);};
 f.PMJS.maps.loadParserTilesets(['A.png','B.png'],[]);
 assert.equal(callbacks,2);assert.deepEqual(f.loads.map(x=>x.context),['set-a','']);
});
test('parser batch exceptions retain earlier results and restore outer preparation scope',()=>{
 const f=fixture({onParserLoad(name){if(name==='Broken.png')throw new Error('decode failed');return {};}});
 const untouched={},bitmaps=[null,untouched];f.PMJS.images.preparedTileSet='caller';
 assert.throws(()=>f.PMJS.maps.loadParserTilesets(['Good.png','Broken.png'],bitmaps),/decode failed/);
 assert.equal(bitmaps[0]._pmjsPreparedTileSet,'set-a');assert.equal(bitmaps[1],untouched);
 assert.equal(f.PMJS.images.preparedTileSet,'caller');
});

test('empty parser batches do not validate or disturb an existing bitmap array',()=>{
 const f=fixture(),sentinel={},bitmaps=[sentinel];
 f.PMJS.maps.tiledContract=()=>{throw new Error('No image selection required');};
 f.PMJS.maps.loadParserTilesets([],bitmaps);assert.deepEqual(bitmaps,[sentinel]);assert.equal(f.loads.length,0);
});
test('nested parser batches restore the outer image selection after unused-source loads',()=>{
 let f;f=fixture({onParserLoad(name){if(name==='Used.png'){
  f.PMJS.maps.loadParserTilesets(['Unused.png'],[]);assert.equal(f.PMJS.images.preparedTileSet,'set-a');
 }return {};}});
 f.index[1].sources=['img/tilesets/Used.png'];f.PMJS.images.preparedTileSet='caller';
 f.PMJS.maps.loadParserTilesets(['Used.png'],[]);
 assert.deepEqual(f.loads.map(x=>x.context),['set-a','']);assert.equal(f.PMJS.images.preparedTileSet,'caller');
});
