'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),crypto=require('node:crypto');
const {fixture:mapFixture}=require('../../helpers/map-image-context.cjs');
const adapter=fs.readFileSync(require.resolve('../../../patches/omori/tileset-loading.js'),'utf8');
function fixture({qualified=true,enabled=true}={}){
 const f=mapFixture(),events=[],refused=[];
 f.data.tilesets=[{image:'Used.png'},{image:'Unused.png'},{image:'Used.png'}];
 f.index[1].sources=['img/tilesets/Used.png'];f.index[1].contractHash=crypto.createHash('sha256').update(JSON.stringify(f.data)).digest('hex');
 function Spriteset_Map(){this._tilemap={bitmaps:[],refreshTileset(){events.push('refresh');}};}
 Spriteset_Map.prototype.loadTileset=function(){events.push('ordinary');return 'guest-result';};
 const original=Spriteset_Map.prototype.loadTileset;
 f.context.Spriteset_Map=Spriteset_Map;
 f.PMJS.phases={on(_phase,_id,callback){callback();}};
 f.PMJS.optimizations={register(){},isEnabled:()=>enabled,refuse(_id,reason){refused.push(reason);}};
 const source=qualified?adapter.replace(/'[a-f0-9]{64}'/,"'"+crypto.createHash('sha256').update(original.toString()).digest('hex')+"'"):adapter;
 vm.runInContext(source,f.context);
 return {...f,events,refused,original,Spriteset_Map};
}
test('reviewed tiled loading validates one batch, preserves bitmap ownership and refreshes after loading',()=>{
 const f=fixture(),s=new f.Spriteset_Map(),bitmaps=s._tilemap.bitmaps;let checks=0;
 f.PMJS.maps.tiledContract=()=>{checks++;return true;};s.loadTileset();
 assert.equal(checks,1);assert.equal(s._tilemap.bitmaps,bitmaps);assert.equal(bitmaps.length,3);
 assert.deepEqual(f.loads.map(x=>x.context),['set-a','','set-a']);assert.deepEqual(f.events,['refresh']);
 assert.equal(s._tileset,f.data.tilesets);
});
test('ordinary maps and unrecognized or disabled loaders keep their original callbacks',()=>{
 const f=fixture(),s=new f.Spriteset_Map();f.context.$gameMap.isTiledMap=()=>false;
 assert.equal(s.loadTileset(),'guest-result');assert.deepEqual(f.events,['ordinary']);
 for(const options of [{qualified:false},{enabled:false}]){
  const other=fixture(options);assert.equal(other.Spriteset_Map.prototype.loadTileset,other.original);
 }
});
test('tileset refresh and assignment occur only after all loads succeed',()=>{
 const f=fixture(),s=new f.Spriteset_Map();
 f.ImageManager.loadParserTileset=function(){throw new Error('load failed');};
 assert.throws(()=>s.loadTileset(),/load failed/);assert.deepEqual(f.events,[]);assert.equal(s._tileset,undefined);
});
