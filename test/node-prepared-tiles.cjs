'use strict';
const diagnostics = !process.argv.includes('--diagnostics-off');
process.env.PMJS_GRAPHICS_DIAGNOSTICS = diagnostics ? '1' : '0';
process.env.UV_THREADPOOL_SIZE = '1';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { png } = require('./helpers/png.cjs');
const native = require(path.resolve(process.argv[2]));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pmjs-tiles-'));
const pixels = Buffer.alloc(512*512*4);
for (let y = 0; y < 512; ++y) for (let x = 0; x < 512; ++x)
  pixels.set([(x*37+y*3)%256,(y*17+x)%256,(x+y*31)%256, (x+y)%3 ? 255 : 97],(y*512+x)*4);
fs.writeFileSync(path.join(root,'source.png'),png(512,512,pixels));
fs.copyFileSync(path.join(root,'source.png'),path.join(root,'snapshot.png'));
const widePixels=Buffer.alloc(8192*64*4);
for(let y=0;y<64;y++) for(let x=0;x<8192;x++) widePixels.set([x%256,y*3,(x*71+y)%256,255],(y*8192+x)*4);
fs.writeFileSync(path.join(root,'wide.png'),png(8192,64,widePixels));
fs.copyFileSync(path.join(root,'wide.png'),path.join(root,'wide-snapshot.png'));
const paddedSources = [[512,0,32,32],[-32,0,32,32],[0,512,32,32],[0,-32,32,32],
  [496,0,32,32],[-16,0,32,32],[0,496,32,32],[0,-16,32,32],[496,496,32,32]];
for (const [index,source] of paddedSources.entries()) {
  const expectedPixels = Buffer.alloc(32*32*4);
  for (let y=0;y<32;y++) for (let x=0;x<32;x++) {
    const sx=source[0]+x, sy=source[1]+y;
    if (sx>=0 && sy>=0 && sx<512 && sy<512)
      pixels.copy(expectedPixels,(y*32+x)*4,(sy*512+sx)*4,(sy*512+sx)*4+4);
  }
  fs.writeFileSync(path.join(root,`expected-${index}.png`),png(32,32,expectedPixels));
}
native.initialize({gameRoot:root,width:128,height:96,windowTitle:'prepared tiles',imageWarmCacheBytes:0});
const schema = native.scene.schema;
function frame(image, source, transform, nearest, offset = [0,0], animation = [0,0], options = {}) {
  const layer = native.render.createTileLayer(new Float32Array([...source.slice(0,2),0,0,...source.slice(2),...animation,0]),[image.handle]);
  assert.ok(layer);
  const metadata = new Uint32Array([4,0xffffffff,layer,0xc3e7af,options.blend || 0,(nearest?8:0)|(options.clip?1:0),0]);
  const values = new Float32Array(schema.valueStride); values.set([...transform,0.73]); values.set(offset,15); if(options.clip) values.set([13.5,10.25,45.75,38.5],17);
  let packetMetadata=metadata,packetValues=values,count=1;
  if(options.filter) {
    count=3;packetMetadata=new Uint32Array(schema.metadataStride*3);packetValues=new Float32Array(schema.valueStride*3);
    packetMetadata.set([6,0xffffffff,options.filter,0xffffff,31,0,0]);
    metadata[1]=0;packetMetadata.set(metadata,schema.metadataStride);
    packetMetadata.set([7,0,0,0xffffff,0,0,0],schema.metadataStride*2);
    packetValues.set([1,0,0,1,0,0,1]);packetValues.set(values,schema.valueStride);
    packetValues.set([1,0,0,1,0,0,1],schema.valueStride*2);
  }
  native.beginFrame(); native.scene.submit(schema.version,packetMetadata,packetValues,count); native.renderScene();
  if(options.offscreen) {
    const canvas=native.canvas.create(128,96);
    native.render.renderToCanvas(canvas.handle);
    const result=Buffer.from(native.canvas.readPremultipliedPixels(canvas.handle,0,0,128,96));
    native.canvas.release(canvas.handle);
    native.render.releaseTileLayer(layer);return result;
  }
  const result = Buffer.from(native.canvas.captureSceneRawPremultiplied());
  native.render.releaseTileLayer(layer); return result;
}
async function main() {
  const rectangles = [[0,0,32,32],[32,0,32,32],[64,0,32,32],[480,480,32,32],[0,0,16,16],[16,16,16,16]];
  const directory = path.join(root,'set'); fs.mkdirSync(directory);
  const descriptor = await native.assets.processTiles([{file:path.join(root,'snapshot.png'),rectangles}],directory);
  assert.equal(await native.assets.processTiles([{file:path.join(root,'snapshot.png'),rectangles}],directory,descriptor),rectangles.length);
  assert.equal(descriptor.version,1);
  assert.ok(descriptor.pages.every(page=>page.width<=2048&&page.height<=2048));
  const set = {identity:'set-a',directory,descriptor:structuredClone(descriptor)};
  Object.assign(set.descriptor.sources[0],{source:'source.png',snapshot:path.join(root,'snapshot.png'),sourceIdentity:native.assets.sourceIdentity('source.png')});
  assert.equal(native.assets.installTileSets([Object.freeze({ ...set })]),1);
  assert.equal(native.assets.installTileSets([set], true),1);
  assert.equal(native.assets.installTileSetCatalog([set]),1);
  for (const source of ['../outside.png', '/tmp/outside.png']) {
    const unsafe = structuredClone(set);
    unsafe.descriptor.sources[0].source = source;
    assert.throws(() => native.assets.installTileSetCatalog([unsafe]), /cannot resolve tile source/);
  }
  const [view, shared] = await Promise.all([native.images.loadAsync('source.png',false,'set-a'),native.images.loadAsync('source.png',false,'set-a')]);
  assert.equal(view.handle,shared.handle);
  const original = native.images.load('source.png');
  assert.notEqual(view.handle,original.handle);
  assert.deepEqual([view.width,view.height],[512,512]);
  const transforms = [[1,0,0,1,5,6],[2,0,0,2,5.25,6.5],[1.31,0.17,-0.2,1.19,28.25,15.5],[-1.75,0,0,1.5,94,20]];
  const program=native.render.createFilterProgram(
    'varying vec2 vTextureCoord; uniform sampler2D uSampler; void main(){gl_FragColor=texture2D(uSampler,vTextureCoord);}',
    'attribute vec2 aVertexPosition; attribute vec2 aTextureCoord; uniform mat3 projectionMatrix; varying vec2 vTextureCoord; void main(){gl_Position=vec4((projectionMatrix*vec3(aVertexPosition,1.0)).xy,0,1);vTextureCoord=aTextureCoord;}');
  const plans=[0.5,1,2].map(resolution=>native.render.createFilterPlan({frame:[0,0,128,96],resolutions:[resolution,resolution],
    passes:[{program:program.handle,input:0,output:1,clear:false,blend:0,uniforms:[],samplers:[]}]}));
  let comparisons = 0;
  for (const source of rectangles) for (const transform of transforms) {
    assert.deepEqual(frame(view,source,transform,true),frame(original,source,transform,true),JSON.stringify({source,transform})); comparisons++;
  }
  for(const options of [{clip:true},{blend:1},{blend:2},{blend:3},{offscreen:true},...plans.map(plan=>({filter:plan.handle}))]) {
    assert.deepEqual(frame(view,rectangles[0],transforms[2],true,[0,0],[0,0],options),
      frame(original,rectangles[0],transforms[2],true,[0,0],[0,0],options));comparisons++;
  }
  assert.equal(native.images.memory().tileMaterializations,0);
  assert.equal(native.images.memory().tileRegions>0,diagnostics);
  for (let phase=0;phase<3;phase++) {
    assert.deepEqual(frame(view,[0,0,32,32],transforms[1],true,[phase*32,0],[1,0]),
      frame(original,[0,0,32,32],transforms[1],true,[phase*32,0],[1,0])); comparisons++;
  }
  const slot = native.images.tileSlot(view.handle,1024,1024);
  assert.deepEqual([slot.width,slot.height],[1024,1024]);
  const ordinarySlot = native.canvas.create(1024,1024);
  native.canvas.drawImage(ordinarySlot.handle,original.handle,0,0,512,512,0,0,512,512,1);
  assert.deepEqual(frame(slot,[0,0,32,32],transforms[2],true),frame(ordinarySlot,[0,0,32,32],transforms[2],true),'logical MZ slot render must match Canvas snapshot quantization');
  const snapshot = native.canvas.create(1024,1024);
  native.canvas.drawImage(snapshot.handle,slot.handle,0,0,1024,1024,0,0,1024,1024,1);
  assert.deepEqual(Buffer.from(native.canvas.readPixels(snapshot.handle,0,0,1024,1024)),
    Buffer.from(native.canvas.readPixels(ordinarySlot.handle,0,0,1024,1024)));
  // Unknown regions and authored linear sampling retain ordinary source pixels.
  for (const [source,nearest] of [[[250,250,32,32],true],[[0,0,32,32],false]]) {
    assert.deepEqual(frame(view,source,transforms[2],nearest),frame(original,source,transforms[2],nearest)); comparisons++;
  }
  assert.equal(native.images.memory().tileMaterializations>0,diagnostics);
  // Expected tiles retain in-bounds pixels and transparent padding on every edge.
  for (const [index,source] of paddedSources.entries()) {
    const expected = native.images.load(`expected-${index}.png`);
    const expectedFrame = frame(expected,[0,0,32,32],transforms[0],true);
    for (const image of [original,view]) {
      assert.deepEqual(frame(image,source,transforms[0],true),expectedFrame,
        `transparent tile padding: ${JSON.stringify(source)}`);
      comparisons++;
    }
    native.images.release(expected.handle);
  }
  native.images.release(view.handle);native.images.release(shared.handle);
  assert.equal(native.images.memory().warmFileCount,
    set.descriptor.pages.length + set.descriptor.sources.length,
    'shared tile owners must count each captured page and snapshot once');
  native.images.release(slot.handle);
  native.images.release(original.handle);native.canvas.release(snapshot.handle);native.canvas.release(ordinarySlot.handle);
  native.beginFrame();
  assert.equal(native.images.memory().warmFileCount,0,'zero-budget tile eviction retained warm file ownership');
  assert.equal(native.images.memory().tileHits,diagnostics ? 1 : 0);
  // Invalid pages leave existing owners intact and load the captured ordinary source.
  const corruptDirectory=path.join(root,'corrupt-set');fs.mkdirSync(corruptDirectory);
  const corruptDescriptor=await native.assets.processTiles([{file:path.join(root,'snapshot.png'),rectangles}],corruptDirectory);
  Object.assign(corruptDescriptor.sources[0],set.descriptor.sources[0]);
  fs.writeFileSync(path.join(corruptDirectory,corruptDescriptor.pages[0].path),'invalid PNG');
  assert.equal(native.assets.installTileSets([{identity:'corrupt',directory:corruptDirectory,descriptor:corruptDescriptor}]),1);
  const expected=native.images.load('source.png');
  const replacement=png(512,512,Buffer.alloc(512*512*4,255));
  const busy=new Promise((resolve,reject)=>crypto.pbkdf2('tiles','worker',100000,32,'sha256',(error)=>error?reject(error):resolve()));
  const fallbackPending=native.images.loadAsync('source.png',false,'corrupt');
  fs.writeFileSync(path.join(root,'source.png'),replacement);
  await busy;
  const ordinaryFallback=await fallbackPending;
  assert.deepEqual(frame(ordinaryFallback,rectangles[0],transforms[0],true),frame(expected,rectangles[0],transforms[0],true));
  fs.copyFileSync(path.join(root,'snapshot.png'),path.join(root,'source.png'));
  assert.equal(native.images.memory().tileFallbacks['page-validation']>0,diagnostics);
  native.images.release(ordinaryFallback.handle);native.images.release(expected.handle);native.beginFrame();
  // Large logical UVs and fractional cameras exercise sampler quantization at
  // distant sheet edges, independently of the packed page's dimensions.
  const wideRects=[0,1024,4096,6144,8160].map(x=>[x,16,32,32]);
  const wideDirectory=path.join(root,'wide-set');fs.mkdirSync(wideDirectory);
  const wideDescriptor=await native.assets.processTiles([{file:path.join(root,'wide-snapshot.png'),rectangles:wideRects}],wideDirectory);
  Object.assign(wideDescriptor.sources[0],{source:'wide.png',snapshot:path.join(root,'wide-snapshot.png'),sourceIdentity:native.assets.sourceIdentity('wide.png')});
  assert.equal(native.assets.installTileSets([{identity:'wide',directory:wideDirectory,descriptor:wideDescriptor}]),1);
  const wideView=await native.images.loadAsync('wide.png',false,'wide'),wideOriginal=native.images.load('wide.png');
  for(const rect of wideRects) for(const transform of transforms) {
    assert.deepEqual(frame(wideView,rect,transform,true),frame(wideOriginal,rect,transform,true),JSON.stringify({rect,transform}));comparisons++;
  }
  const croppedSlot=native.images.tileSlot(wideView.handle,1024,1024),croppedCanvas=native.canvas.create(1024,1024);
  native.canvas.drawImage(croppedCanvas.handle,wideOriginal.handle,0,0,8192,64,0,0,8192,64,1);
  assert.equal(croppedSlot,null,'oversized sources use the ordinary Canvas slot path');
  native.canvas.release(croppedCanvas.handle);
  // Replacing the public file cannot change an already retained logical view.
  const saved=frame(wideView,wideRects[2],transforms[0],true);
  fs.writeFileSync(path.join(root,'replacement.png'),png(8192,64,Buffer.alloc(8192*64*4,255)));
  fs.renameSync(path.join(root,'replacement.png'),path.join(root,'wide.png'));
  assert.deepEqual(frame(wideView,wideRects[2],transforms[0],true),saved);
  assert.deepEqual(frame(wideView,[2048,16,32,32],transforms[0],true),frame(wideOriginal,[2048,16,32,32],transforms[0],true));
  native.images.release(wideView.handle);native.images.release(wideOriginal.handle);native.beginFrame();
  const staleSet = { identity: 'stale-set', directory, descriptor: structuredClone(descriptor) };
  Object.assign(staleSet.descriptor.sources[0], { source: 'source.png', snapshot: path.join(root, 'snapshot.png'),
    sourceIdentity: native.assets.sourceIdentity('source.png') });
  assert.equal(native.assets.installTileSets([staleSet], true), 1);
  for (const missing of [path.join(directory, descriptor.pages[0].path), path.join(root, 'snapshot.png')]) {
    const bytes = fs.readFileSync(missing); fs.unlinkSync(missing);
    assert.equal(native.assets.installTileSetCatalog([staleSet]), 1, 'catalog installation must not open missing tile files');
    native.assets.consumePreparationInvalidations();
    const fallback = await native.images.loadAsync('source.png', false, staleSet.identity);
    assert.equal(native.assets.consumePreparationInvalidations() & 2, 2, 'stale pages and snapshots request map regeneration');
    const ordinary = native.images.load('source.png');
    assert.deepEqual(frame(fallback, rectangles[0], transforms[0], true), frame(ordinary, rectangles[0], transforms[0], true));
    native.images.release(fallback.handle); native.images.release(ordinary.handle); native.beginFrame();
    fs.writeFileSync(missing, bytes);
    assert.equal(native.assets.installTileSets([staleSet], true), 1);
  }
  assert.equal(native.assets.installTileSets([staleSet], true), 1);
  assert.equal(native.assets.installTileSetCatalog([staleSet]), 1);
  native.assets.consumePreparationInvalidations();
  fs.writeFileSync(path.join(root, 'source.png'), png(512,512,Buffer.alloc(512*512*4, 255)));
  const changedSource = await native.images.loadAsync('source.png', false, staleSet.identity);
  const changedOrdinary = native.images.load('source.png');
  assert.deepEqual(frame(changedSource, rectangles[0], transforms[0], true),
    frame(changedOrdinary, rectangles[0], transforms[0], true));
  assert.equal(native.assets.consumePreparationInvalidations() & 2, 2, 'changed original source requests map regeneration');
  native.images.release(changedSource.handle); native.images.release(changedOrdinary.handle);
  if (!diagnostics) {
    const memory=native.images.memory();
    for (const field of ['tileHits','tileRegions','tileMaterializations','tilePageDecodes','tilePageUploads']) assert.equal(memory[field],0);
    assert.deepEqual(memory.tileRegionSets,{}); assert.deepEqual(memory.tileFallbacks,{});
  }
  console.log(JSON.stringify({comparisons,memory:native.images.memory()}));
}
main().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>{native.runtime.quit();fs.rmSync(root,{recursive:true,force:true});});
