'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const {spawnSync} = require('node:child_process');
if (!process.argv.includes('--worker')) {
 const results = [1,4].map(textures=>{
  const child=spawnSync(process.execPath,[__filename,process.argv[2],'--worker'],{env:{...process.env,PMJS_TILE_BATCH_TEXTURES:String(textures),PMJS_GRAPHICS_DIAGNOSTICS:'1'},encoding:'utf8'});
  assert.equal(child.status,0,child.stderr);return JSON.parse(child.stdout.trim().split('\n').at(-1));
 });
 assert.deepEqual(results[0].hashes,results[1].hashes,'texture changes, fifth-texture flush, overlaps, alpha and animation preserve pixels');
 assert.ok(results[1].draws<results[0].draws,JSON.stringify(results));
 console.log(JSON.stringify({comparisons:results[0].hashes.length,draws:results.map(r=>r.draws)}));
} else {
 const native=require(path.resolve(process.argv[2]));
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'pmjs-four-tiles-'));
 native.initialize({gameRoot:root,width:40,height:32,windowTitle:'four texture tiles'});
 const images=[0,1,2,3,4].map(i=>{
  const image=native.canvas.create(8+i,8);const pixels=new Uint8Array((8+i)*8*4);
  for(let p=0;p<pixels.length;p+=4){pixels[p]=(p+i*23)%91;pixels[p+1]=i*17;pixels[p+2]=63;pixels[p+3]=127;}
  native.canvas.writePremultipliedPixels(image.handle,0,0,8+i,8,pixels);return image;
 });
 const tiles=[];for(let i=0;i<30;i++)tiles.push(0,0,(i%7)*4,Math.floor(i/7)*4,8,8,1,0,[0,1,0,2,3,1,4][i%7]);
 const layer=native.render.createTileLayer(new Float32Array(tiles),images.map(i=>i.handle));
 const schema=native.scene.schema,hashes=[];
 try {
  for(const masked of [false,true])for(const nearest of [false,true])for(const animation of [0,1,2]){
   const values=new Float32Array(schema.valueStride);values.set([1,0,0,1,0.25,0.5,0.73]);values.set([animation,0],15);if(masked)values.set([1,0,0,1,0,0],22);
   native.beginFrame();native.scene.submit(schema.version,new Uint32Array([4,0xffffffff,layer,0xc3e7af,0,(nearest?8:0)|(masked?4:0),masked?images[0].handle:0]),values,1);native.renderScene();
   hashes.push(crypto.createHash('sha256').update(Buffer.from(native.canvas.captureSceneRawPremultiplied())).digest('hex'));
  }
  console.log(JSON.stringify({hashes,draws:native.render.stats().tileDrawCalls}));
 } finally {native.render.releaseTileLayer(layer);images.forEach(i=>native.canvas.release(i.handle));fs.rmSync(root,{recursive:true,force:true});}
}
