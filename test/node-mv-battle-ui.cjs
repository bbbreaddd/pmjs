'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {png}=require('./helpers/png.cjs');
const native=require(path.resolve(process.argv[2])),binding=native.mvEngine,api={...binding};
const trace=[];
for(const name of ['newGame','load','startBattle','acknowledge','step','chooseAction','openTitle','setRandomStream']) {
  api[name]=(owner,...args)=>{if(owner===session)trace.push([name,structuredClone(args)]);return binding[name](owner,...args);};
}
const assets=path.resolve(process.argv[3]),root=fs.mkdtempSync(path.join(assets,'mv-battle-ui-'));
fs.mkdirSync(path.join(root,'img/system'),{recursive:true});
fs.copyFileSync(path.join(assets,'testfont.ttf'),path.join(root,'font.ttf'));
const skin=new Uint8Array(192*192*4);
function fill(x,y,w,h,color) { for(let yy=y;yy<y+h;++yy)for(let xx=x;xx<x+w;++xx)skin.set(color,(yy*192+xx)*4); }
fill(0,0,96,96,[25,25,25,255]);fill(96,0,96,96,[200,200,200,255]);fill(96,96,48,48,[0,100,255,255]);
for(let i=0;i<32;++i)fill(102+i%8*12,150+Math.floor(i/8)*12,1,1,i===19?[0,0,0,255]:i===20?[255,0,0,255]:i===21?[0,255,0,255]:[255,255,255,255]);
fs.writeFileSync(path.join(root,'img/system/Window.png'),png(192,192,skin));
fs.writeFileSync(path.join(root,'img/system/Damage.png'),png(100,50,new Uint8Array(100*50*4).fill(255)));
native.initialize({gameRoot:root,width:816,height:624,windowTitle:'Battle window contents'});
const before=native.canvas.memory().liveCount;
const data={system:{startMapId:1,startX:1,startY:1,partyMembers:[1,2],optDisplayTp:true,skillTypes:['','Magic'],terms:{basic:['Level','Lv','HP','HP','MP','MP','TP','TP']}},
 actors:[null,{name:'Alpha',classId:1,initialLevel:1},{name:'Beta',classId:1,initialLevel:1}],
 classes:[null,{params:Array.from({length:8},()=>[0,100]),traits:[{code:41,dataId:1,value:0}],learnings:[{level:1,skillId:4},{level:1,skillId:5}]}],
 skills:[null,{id:1,name:'Attack',scope:1,occasion:1,hitType:0,successRate:100,damage:{type:1,formula:'10',variance:0}},
 {id:2,name:'Guard',scope:11,occasion:1,stypeId:0,damage:{type:0}},null,
 {id:4,name:'Spark',tpGain:10,scope:1,occasion:1,stypeId:1,mpCost:15,hitType:0,successRate:100,damage:{type:1,formula:'35',variance:0}},
 {id:5,name:'Heal',scope:7,occasion:1,stypeId:1,mpCost:5,hitType:0,successRate:100,damage:{type:3,formula:'25',variance:0}}],
 enemies:[null,{name:'Target',params:[1000,0,1,1,1,1,1,1],actions:[],dropItems:[]}],troops:[null,{members:[{enemyId:1,x:300,y:300}]}],
 tilesets:[null,{flags:[0]}],maps:{1:{width:20,height:15,data:Array(20*15*6).fill(0),tilesetId:1,events:[]}}};
const session=api.create(data),settings={fontFile:'font.ttf'};
function render(owner=session) { native.beginFrame();api.present(owner);native.renderFrame();return Buffer.from(native.canvas.captureSceneRawPremultiplied()); }
function press(input) { api.step(session,input);api.step(session,{}); }
function freshMatches(pixels,label) {
 const fresh=binding.create(data);
 try { for(const [name,args] of trace)binding[name](fresh,...args);binding.attach(fresh,settings);assert.deepEqual(render(fresh),pixels,label); }
 finally { binding.dispose(fresh); }
}
function work() { const images=native.images.memory(0);return {layouts:native.canvas.glyphStats().layoutRequests,regionUpdates:images.textureRegionUpdates,fullUpdates:images.textureFullUpdates}; }
function enter(saved,escape=true) { api.load(session,saved);api.setRandomStream(session,Array(1000).fill(0.5));api.startBattle(session,1,escape,false);while(api.snapshot(session).message.busy)api.acknowledge(session);while(api.snapshot(session).message.openness>0)api.step(session,{}); }
try {
 api.newGame(session);api.attach(session,settings);const baseline=api.save(session);
 enter(baseline);render();const idle=work();
 assert.ok(native.canvas.memory().cpuPixelBytes < 816 * 624 * 4, 'window-sized battle text canvases stay smaller than one full-screen surface');
 api.step(session,{});const first=render();assert.deepEqual(work(),idle,'unchanged status and commands do not rasterize or upload again');
 for(let i=0;i<8;++i)api.step(session,{});const blink=render();
 assert.deepEqual(work(),idle,'cursor animation does not invalidate window contents');assert.notDeepEqual(blink,first,'cursor continues to animate');
 press({direction:2});render();assert.deepEqual(work(),idle,'moving the command cursor reuses labels');
 freshMatches(render(),'retained command selection matches fresh drawing');
 press({direction:8});press({ok:true});render();
 press({direction:2});press({ok:true});const skills=render();assert.equal(api.snapshot(session).ui.category,1);
 freshMatches(skills,'skill list matches fresh drawing');const selected=work();
 press({direction:2});render();assert.deepEqual(work(),selected,'skill cursor does not redraw skill names');
 press({cancel:true});freshMatches(render(),'closing the skill list removes its old contents');
 const changed=structuredClone(baseline);changed.actors._data[1]._hp=25;changed.actors._data[1]._mp=70;changed.actors._data[1]._paramPlus[0]=50;
 enter(changed);const values=render();freshMatches(values,'HP, MP and maximum HP changes refresh numbers, colors and gradients');
 assert.notDeepEqual(values,first,'changed actor values are visibly updated');
 const reordered=structuredClone(changed);reordered.party._actors=[2,1];enter(reordered);freshMatches(render(),'party order changes refresh status rows');
 const single=structuredClone(changed);single.party._actors=[1];enter(single,false);freshMatches(render(),'party removal and disabled escape refresh without stale rows');
 enter(changed);render();api.setRandomStream(session,Array(1000).fill(0.5));api.chooseAction(session,0,4,0,false);api.chooseAction(session,1,4,0,false);
 let updated=false;
 for(let tick=0;tick<500;++tick) { api.step(session,{});const state=api.snapshot(session);if(state.actors[1].mp===55) { updated=true;break; } }
 assert.equal(updated,true);freshMatches(render(),'action MP cost and battle log refresh retained contents');
 for(let tick=0;tick<500;++tick) { api.step(session,{});if(api.snapshot(session).actors[2].mp===85)break; }
 freshMatches(render(),'a different actor action updates the log and status');
 api.load(session,baseline);for(let tick=0;tick<60;++tick)api.step(session,{});render();const mapBytes=native.canvas.memory().cpuPixelBytes;
 api.step(session,{cancel:true});for(let tick=0;tick<60;++tick)api.step(session,{});
 const menuFirst=render();const menuIdle=work();
 assert.ok(native.canvas.memory().cpuPixelBytes - mapBytes < 816 * 624 * 4, 'menu windows use window-sized text surfaces rather than full-screen canvases');
 api.step(session,{});assert.deepEqual(render(),menuFirst);
 assert.deepEqual(work(),menuIdle,'unchanged menu windows do not clear, rasterize, or upload again');
 press({direction:2});const menuMoved=render();
 assert.deepEqual(work(),menuIdle,'moving the menu cursor reuses window text contents');
 assert.notDeepEqual(menuMoved,menuFirst,'moving the menu cursor visibly updates the selection');
 freshMatches(menuMoved,'reused menu window contents match fresh drawing');
 let settled;
 for(let cycle=0;cycle<3;++cycle) {
   api.openTitle(session);for(let tick=0;tick<40;++tick)api.step(session,{});render();
   const count=native.canvas.memory().liveCount;if(settled===undefined)settled=count;else assert.equal(count,settled,'battle/title cycles release retained window resources');
   enter(baseline);render();
 }
} finally { api.dispose(session);assert.equal(native.canvas.memory().liveCount,before,'disposing the session releases all owned window contents');fs.rmSync(root,{recursive:true,force:true}); }
