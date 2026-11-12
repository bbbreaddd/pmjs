'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {temporaryDirectory} = require('./helpers/temp.cjs');
const {png} = require('./helpers/png.cjs');
const {spritePacket,drawPacket} = require('./helpers/sparse-palette.cjs');
const native = require(path.resolve(process.argv[2]));
const budget = Number(process.argv[3] || 8000);
const root = temporaryDirectory('animation-pressure-');
const pixels = Buffer.alloc(4096*48*4);
for (let y=0;y<48;y++) for(let x=0;x<4096;x++) {
  const i=(y*4096+x)*4;
  const key=x%32+(y%16)*32;
  pixels.set([key%256,Math.floor(key/256)*80,key*53%256,(x+y)%3*127],i);
}
const sourceBytes=png(4096,48,pixels);
for(const name of ['sheet.png','other.png'])fs.writeFileSync(path.join(root,name),sourceBytes);
native.initialize({gameRoot:root,width:100,height:60,windowTitle:'Animation cache pressure',imageWarmCacheBytes:0,preparedFrameCacheBytes:budget});
// The first memory query creates the diagnostic fallback texture.
native.images.memory();
(async()=>{
 let image,other,reference;
 try {
  const directory=path.join(root,'prepared');fs.mkdirSync(directory);
  const descriptor=await native.assets.processImage('sheet.png',directory,{grid:[256,4]});
  const sourceIdentity=native.assets.sourceIdentity('sheet.png');
  const storage=await native.assets.classifyImageStorage(path.join(root,'sheet.png'));
  assert.ok(storage.paletteBits);
  native.assets.installImageStorage([{source:'sheet.png',sourceIdentity,storage}]);
  native.assets.installPrepared([{source:'sheet.png',sourceIdentity,directory,descriptor}]);
  const otherIdentity=native.assets.sourceIdentity('other.png');
  native.assets.installImageStorage([{source:'other.png',sourceIdentity:otherIdentity,storage}]);
  native.assets.installPrepared([{source:'other.png',sourceIdentity:otherIdentity,directory,descriptor}]);
  image=await native.images.loadAsync('sheet.png');
  other=await native.images.loadAsync('other.png');
  reference=native.canvas.create(4096,48);native.canvas.writePixels(reference.handle,0,0,4096,48,pixels);
  const expected=new Map();
  function packet(image,n,packed) {
   const result=spritePacket(native,image,{nearest:false,crop:[n*32+0.25,0.5,31.5,23],scale:1.1,premultiplied:image===reference});
   if(packed)result.metadata[5]&=~(1<<17);
   return result;
  }
  for(const packed of [false,true])for(let n=0;n<24;n++)expected.set(`${n}-${packed}`,drawPacket(native,packet(reference,n,packed)));
  function frame(n,packed,target=image) {
   const actual=drawPacket(native,packet(target,n,packed)),referencePixels=expected.get(`${n}-${packed}`);
   let delta=0;for(let i=0;i<actual.length;i++)delta=Math.max(delta,Math.abs(actual[i]-referencePixels[i]));
   assert.ok(delta<=1,`frame ${n}, packed ${packed} pixel delta ${delta}`);
  }
  for(let i=0;i<144;i++){frame(i%24,!!(i%2));frame((i+7)%24,!!(i%2),other);}
  const warm=native.images.memory();
  for(let i=0;i<144;i++){frame(i%24,!!(i%2));frame((i+7)%24,!!(i%2),other);}
  const after=native.images.memory();
  assert.equal(after.renderReadbacks,warm.renderReadbacks,'steady drawing must not add GPU readbacks');
  assert.equal(after.sourceTextureBuilds,0,'missing compiled data must not be rebuilt during gameplay');
  assert.equal(after.paletteReadbacks,0,'drawing must not read the palette back from the GPU');
  assert.equal(after.preparedFrameConversions,warm.preparedFrameConversions,'warm cycles must not repeatedly convert evicted frames');
  assert.equal(after.preparedFrameCacheMisses,warm.preparedFrameCacheMisses);
  assert.equal(after.preparedPageDecodes,warm.preparedPageDecodes);
  assert.equal(after.textureUploadBytes,warm.textureUploadBytes);
  assert.ok(after.preparedFrameCacheBytes<=budget);
  assert.ok(after.preparedPageTextureBytes<=32*1024*1024);
  if(budget>=3536&&budget<24*3536) {
   assert.ok(after.preparedFrameCacheEvictions>0,'fixture did not create cache pressure');
   assert.ok(after.preparedFrameCacheEvictions<=34,'cache admission did not stop under repeated pressure');
  }
 } finally {
  if(image)native.images.release(image.handle);if(other)native.images.release(other.handle);if(reference)native.canvas.release(reference.handle);
  native.beginFrame();assert.equal(native.images.memory().preparedFrameCacheBytes,0);
  native.runtime.quit();
 }
})().catch(e=>{console.error(e);process.exitCode=1;});
