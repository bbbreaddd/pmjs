'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { png } = require('./helpers/png.cjs');
const assets = path.resolve(process.argv[3]);
const root = fs.mkdtempSync(path.join(assets,'mv-presentation-'));
fs.mkdirSync(path.join(root,'img/system'),{recursive:true}); fs.mkdirSync(path.join(root,'img/tilesets'),{recursive:true});
fs.copyFileSync(path.join(assets,'testfont.ttf'),path.join(root,'font.ttf'));
const skin = new Uint8Array(192*192*4).fill(255);
for (let y=96;y<144;++y) for(let x=96;x<144;++x) {
  const offset=(y*192+x)*4, edge=x<100 || x>=140 || y<100 || y>=140;
  skin[offset]=edge ? 255 : 0; skin[offset+1]=0; skin[offset+2]=edge ? 0 : 255;
}
for (const [index,rgb] of [[19,[0,0,0]],[20,[255,0,0]],[21,[0,0,255]]]) {
  const at=((150+Math.floor(index/8)*12)*192+102+(index%8)*12)*4;
  skin.set([...rgb,255],at);
}
fs.writeFileSync(path.join(root,'img/system/Window.png'),png(192,192,skin));
fs.writeFileSync(path.join(root,'img/system/Damage.png'),png(100,50,new Uint8Array(100*50*4).fill(255)));
fs.writeFileSync(path.join(root,'img/tilesets/Tiles.png'),png(96,48,new Uint8Array(96*48*4).fill(255)));
const wav=Buffer.alloc(44+48000*4*2);
wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);
wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(2,22);
wav.writeUInt32LE(48000,24);wav.writeUInt32LE(192000,28);wav.writeUInt16LE(4,32);wav.writeUInt16LE(16,34);
wav.write('data',36);wav.writeUInt32LE(wav.length-44,40);
for(const folder of ['bgm','bgs']) {
  fs.mkdirSync(path.join(root,'audio',folder),{recursive:true});
  for(const name of ['Field','Battle']) fs.writeFileSync(path.join(root,'audio',folder,name+'.ogg'),wav);
}
const encKey=Buffer.from('000102030405060708090a0b0c0d0e0f','hex');
const encryptedBody=Buffer.concat([Buffer.from('5250474d560000000003010000000000','hex'),wav]);
for(let i=0;i<16;++i) encryptedBody[16+i]^=encKey[i];
fs.writeFileSync(path.join(root,'audio/bgm/Encrypted.rpgmvo'),encryptedBody);
const native = require(path.resolve(process.argv[2]));
native.initialize({gameRoot:root,width:320,height:240,windowTitle:'Native message screen fade'});
const command = (code,parameters=[])=>({code,parameters,indent:0});
const tiles = Array(8*5*6).fill(0); tiles.fill(1,0,40);
const session = native.mvEngine.create({system:{startMapId:1,startX:1,startY:1,partyMembers:[1]},actors:[null,{}],
  tilesets:[null,{flags:[0,0],tilesetNames:['','','','','','Tiles']}],maps:{1:{width:8,height:5,tilesetId:1,data:tiles,
    events:[null,{id:1,x:2,y:2,pages:[{conditions:{},image:{direction:2,pattern:1},trigger:3,priorityType:0,moveSpeed:3,
      list:[command(221),command(101,['',0,0,2]),command(401,['Visible after fade']),command(0)]}]}]}}});
const hostInputSession = native.mvEngine.create({system:{startMapId:1,startX:1,startY:1,partyMembers:[]},maps:{1:{width:4,height:4,data:Array(96).fill(0),events:[]}}});
try {
  native.mvEngine.newGame(hostInputSession);
  const snapshot = native.input.snapshot;
  native.input.snapshot = () => { throw new Error('native core input must not round-trip through JavaScript'); };
  try { native.pollEvents();native.mvEngine.step(hostInputSession);native.finishLogicStep(); }
  finally { native.input.snapshot = snapshot; }
  assert.equal(native.mvEngine.snapshot(hostInputSession).ticks,1);
  assert.equal(native.mvEngine.snapshot(hostInputSession).player.x,1);
} finally { native.mvEngine.dispose(hostInputSession); }
function render() { native.beginFrame();native.mvEngine.present(session);native.renderFrame();return native.canvas.captureSceneRawPremultiplied(); }
try {
  native.mvEngine.newGame(session); native.mvEngine.attach(session,{fontFile:'font.ttf'});
  assert.equal(render()[0],255);
  for(let tick=0;tick<30;++tick)native.mvEngine.step(session,{});
  assert.equal(native.mvEngine.snapshot(session).message.busy,true);
  const pixels=render();
  assert.equal(pixels[0],0,'screen fade hides the map');
  assert.ok(pixels[(80*320+20)*4]>100,'message windows remain above the screen fade');
  native.mvEngine.openTitle(session);
  for(let tick=0;tick<80;++tick)native.mvEngine.step(session,{});
  const title=render(), color=(x,y)=>Array.from(title.subarray((y*320+x)*4,(y*320+x)*4+3));
  const border=color(240,20), center=color(240,25);
  assert.ok(border[0]>border[2], 'cursor preserves its four-pixel top border');
  assert.ok(center[2]>center[0], 'cursor center begins after four pixels rather than stretching its border');
  const song=name=>({name,volume:90,pitch:100,pan:0});
  const audio=native.mvEngine.create({
    system:{startMapId:1,startX:1,startY:1,partyMembers:[1],battleBgm:song('Battle')},
    actors:[null,{classId:1,initialLevel:1}],classes:[null,{params:Array.from({length:8},()=>[0,100]),traits:[]}],
    skills:[null,{scope:1,occasion:1,hitType:0,successRate:100,damage:{type:1,formula:'99999',variance:0}}],
    enemies:[null,{params:[1,0,1,1,1,1,1,1],actions:[],dropItems:[]}],troops:[null,{members:[{enemyId:1}]}],
    tilesets:[null,{flags:[0]}],maps:{1:{width:8,height:5,data:Array(8*5*6).fill(0),tilesetId:1,events:[],autoplayBgm:true,bgm:song('Field'),autoplayBgs:true,bgs:song('Field')}}
  });
  const renderAudio=()=>{native.beginFrame();native.mvEngine.present(audio);native.renderFrame();};
  try {
    native.mvEngine.newGame(audio);native.mvEngine.attach(audio,{fontFile:'font.ttf'});
    const saved=native.mvEngine.save(audio);
    saved.system._bgmOnSave.pos=0.25;saved.system._bgsOnSave.pos=0.35;
    native.mvEngine.load(audio,saved);renderAudio();
    native.mvEngine.setRandomStream(audio,Array(100).fill(0.5));
    native.mvEngine.startBattle(audio,1,true,false);renderAudio();
    const battlePixels=native.canvas.captureSceneRawPremultiplied();
    const gaugePixel=x=>Array.from(battlePixels.subarray((110*320+x)*4,(110*320+x)*4+3));
    assert.deepEqual(gaugePixel(20),[186,0,69], 'HP gauge interpolates the first skin color');
    assert.deepEqual(gaugePixel(140),[34,0,221], 'HP gauge interpolates the second skin color');
    while(native.mvEngine.snapshot(audio).message.busy)native.mvEngine.acknowledge(audio);
    native.mvEngine.step(audio,{});native.mvEngine.chooseAction(audio,0,1,0,false);
    for(let tick=0;tick<1000 && native.mvEngine.snapshot(audio).battle.active;++tick)native.mvEngine.step(audio,{});
    assert.equal(native.mvEngine.snapshot(audio).battle.active,false);
    renderAudio();
    while(native.mvEngine.snapshot(audio).message.busy)native.mvEngine.acknowledge(audio);
    native.mvEngine.step(audio,{});renderAudio();
    const restored=native.mvEngine.save(audio).system;
    assert.equal(restored._bgmOnSave.name,'Field');assert.ok(restored._bgmOnSave.pos>=0.2,'battle restores the map music position');
    assert.equal(restored._bgsOnSave.name,'Field');assert.ok(restored._bgsOnSave.pos>=0.3,'battle restores the ambient sound position');
  } finally { native.mvEngine.dispose(audio); }

  const encAudio=native.mvEngine.create({
    system:{startMapId:1,startX:1,startY:1,partyMembers:[1],hasEncryptedAudio:true,encryptionKey:'000102030405060708090a0b0c0d0e0f'},
    actors:[null,{classId:1,initialLevel:1}],classes:[null,{params:Array.from({length:8},()=>[0,100]),traits:[]}],
    tilesets:[null,{flags:[0]}],maps:{1:{width:8,height:5,data:Array(8*5*6).fill(0),tilesetId:1,events:[],autoplayBgm:true,bgm:song('Encrypted')}}
  });
  try {
    native.mvEngine.newGame(encAudio);native.mvEngine.attach(encAudio,{fontFile:'font.ttf'});
    const saved=native.mvEngine.save(encAudio);
    saved.system._bgmOnSave.pos=0.25;
    native.mvEngine.load(encAudio,saved);
    native.beginFrame();native.mvEngine.present(encAudio);native.renderFrame();
    const state=native.mvEngine.save(encAudio).system;
    assert.equal(state._bgmOnSave.name,'Encrypted');
    assert.ok(state._bgmOnSave.pos>=0.2,'encrypted rpgmvo BGM plays and preserves seek position');
  } finally { native.mvEngine.dispose(encAudio); }

} finally { native.mvEngine.dispose(session);fs.rmSync(root,{recursive:true,force:true}); }
