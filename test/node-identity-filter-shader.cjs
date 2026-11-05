'use strict';
process.env.PMJS_GRAPHICS_DIAGNOSTICS = '1';
const assert = require('node:assert/strict');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const shaders = require('./helpers/color-matrix-shaders.cjs');
const native = require(path.resolve(process.argv[2]));
const [width, height] = (process.argv[4] || '256x64').split('x').map(Number);
native.initialize({gameRoot: path.resolve(process.argv[3]), width, height,
  windowTitle: 'identity filter shader'});
assert.throws(() => native.render.createFilterPlan({frame:[0,0,1,1],resolutions:[1,1],passes:[]}),
  /requires at least one pass/);
const schema = native.scene.schema, noParent = 0xffffffff;
const identity = [1,0,0,0,0,0,1,0,0,0,0,0,1,0,0,0,0,0,1,0];
const creationStarted = performance.now();
const candidate = native.render.createFilterProgram(shaders.fragment, shaders.vertex);
const creationMs = performance.now() - creationStarted;
// A semantically identical, unrecognized program keeps every reference operation.
const reference = native.render.createFilterProgram(shaders.fragment + '\n// reference\n', shaders.vertex);
const pot=n=>2**Math.ceil(Math.log2(n));
const neighbor = native.render.createFilterProgram(
  'varying vec2 vTextureCoord; uniform sampler2D uSampler; void main(){'+
  'gl_FragColor=texture2D(uSampler,vTextureCoord+vec2('+3/pot(width+8)+','+3/pot(height+8)+'));}',
  shaders.vertex);
const canvases = [];
let seed = 0x51201234;
function random() {seed = (Math.imul(seed,1664525)+1013904223)>>>0; return seed>>>24;}
function image() {
  const canvas = native.canvas.create(width, height); canvases.push(canvas);
  const pixels = new Uint8Array(width*height*4);
  for (let at=0;at<pixels.length;at+=4) {
    const alpha=random(); pixels.set([random()%(alpha+1),random()%(alpha+1),random()%(alpha+1),alpha],at);
  }
  native.canvas.writePremultipliedPixels(canvas.handle,0,0,width,height,pixels);
  return canvas;
}
const background=image(), first=image(), second=image();
const layers=[0,0.5].map(x=>native.render.createTileLayer(
  new Float32Array([0,0,x,0,width,height,0,0,0]),[first.handle]));
function record(kind,parent=noParent,resource=0,blend=0,flags=0) {
  const values=new Float32Array(schema.valueStride); values.set([1,0,0,1,0,0,1]);
  return {metadata:[kind,parent,resource,0xffffff,blend,flags,0],values};
}
function sprite(canvas,parent=noParent) {
  const entry=record(1,parent,canvas.handle,0,8);
  entry.values.set([0,0,width,height,width,height],9); return entry;
}
function render(program,options={}) {
  const matrix=identity.slice();
  if(options.black) matrix[3]=matrix[8]=matrix[13]=-1;
  matrix[4]=options.offset || 0;
  const uniforms=program.uniforms.flatMap(u=>u.name==='m'?matrix:[options.alpha ?? 1]);
  const pass={program:program.handle,input:0,output:1,clear:!!options.clear,
    blend:options.passBlend || 0,uniforms,samplers:[],transform:options.passTransform || [1,0,0,1,0,0]};
  const plan=native.render.createFilterPlan({frame:options.frame || [-4,-4,width+8,height+8],
    resolutions:options.multiple?[1,1,1]:[options.resolution || 1,1],
    passes:options.multiple?[{...pass,output:2},{...pass,input:2}]:[pass]});
  const entries=[sprite(background)];
  let parent=1;
  if(options.nested) {
    const outer=options.neighbor?native.render.createFilterPlan({
      frame:[-4,-4,width+8,height+8],resolutions:[1,1],passes:[{
        program:neighbor.handle,input:0,output:1,clear:false,blend:0,uniforms:[],samplers:[]
      }]}):plan;
    entries.push(record(6,noParent,outer.handle,31)); parent=2;
  }
  const begin=record(6,options.nested?1:noParent,plan.handle,31,options.clip?1:0);
  if(options.clip) begin.values.set(options.clip,17);
  begin.values[34]=options.groupBlend || 0;
  begin.values[9]=options.black && options.enabled !== false ? 1 : 0;
  entries.push(begin);
  if(!options.noFill) {
    const fill=record(3,parent,0,0,options.fillClip?1:0); fill.metadata[3]=options.black?0:0x131a27;
    fill.values[6]=options.fillAlpha ?? 1;
    if(options.fillClip) fill.values.set(options.fillClip,17);
    entries.push(fill);
  }
  const queuedImage=options.queuedImageRelease?native.images.loadBytes(native.canvas.encodePng(first.handle)):null;
  const a=sprite(queuedImage||first,parent), b=sprite(second,parent);
  if(options.fractional) a.values[4]=0.5;
  if(options.scaled) a.values[0]=2;
  if(options.rotated) a.values.set([0,1,-1,0],0);
  if(options.fringe) a.values.set([2,0,0,2,-4,-4],0);
  if(options.childClip) {a.metadata[5]|=1;a.values.set([11,13,211,49],17);}
  if(options.mask) {a.metadata[5]|=4;a.metadata[6]=second.handle;a.values.set([1,0,0,1,0,0],22);}
  if(options.childBlend) a.metadata[4]=options.childBlend;
  if(options.tiling) {a.metadata[0]=2;a.values.set([options.origin ?? 0.5,0.5],15);}
  if(options.linear) a.metadata[5]&=~8;
  if(options.small) { a.values.set([0,0,2,2,2,2],9); b.values.set([0,0,2,2,2,2],9); }
  let queuedLayer=null;
  if(options.tile) {
    if(options.queuedLayerRelease) queuedLayer=native.render.createTileLayer(
      new Float32Array([0,0,-4,-4,width,height,0,0,0]),[first.handle]);
    const tile=record(4,parent,queuedLayer||layers[options.fractionalTile?1:0],0,8);
    tile.values.set([options.animation || 0,0],15); entries.push(tile);
  }
  for(let index=0;index<(options.count ?? 2);index++) entries.push(index%2?b:a);
  if(options.overlayFill) {
    const fill=record(3,parent); fill.metadata[3]=0xa19385; fill.values[6]=0.7; entries.push(fill);
  }
  if(options.clearRectangleResolution !== undefined) {
    const clear=record(10,parent);
    clear.values[7]=1;clear.values[8]=1;
    clear.values[13]=width/2;clear.values[14]=height/2;
    clear.values[33]=options.clearRectangleResolution;
    entries.push(clear);
  }
  entries.push(record(7,parent));
  if(options.nested) entries.push(record(7,1));
  const before=native.render.stats();
  native.beginFrame();
  native.scene.submit(schema.version,new Uint32Array(entries.flatMap(e=>e.metadata)),
    new Float32Array(entries.flatMap(e=>Array.from(e.values))),entries.length);
  if(queuedImage) native.images.release(queuedImage.handle);
  if(queuedLayer) assert.equal(native.render.releaseTileLayer(queuedLayer),true);
  let pixels;
  if(options.offscreen) {
    const target=native.canvas.create(width,height);
    native.render.renderToCanvas(target.handle);
    pixels=Buffer.from(native.canvas.readPremultipliedPixels(target.handle,0,0,width,height));
    native.canvas.release(target.handle);
  } else {
    native.renderScene();
    if (options.timingOnly) native.render.finish();
    else pixels=Buffer.from(native.canvas.captureSceneRawPremultiplied());
  }
  const after=native.render.stats();
  if(queuedImage) assert.ok(!native.images.memory(100).largest.some(item=>item.handle===queuedImage.handle),
    'queued image ownership ends after rendering');
  if(queuedLayer) assert.equal(native.render.releaseTileLayer(queuedLayer),false,
    'queued tile ownership ends after rendering');
  return {pixels,specialized:after.identityFilterShaderDrawCalls-before.identityFilterShaderDrawCalls,
    filters:after.filterDrawCalls-before.filterDrawCalls,
    blackGroups:after.constantBlackGroups-before.constantBlackGroups,
    blackSkipped:after.constantBlackGroupsSkipped-before.constantBlackGroupsSkipped,
    blackSourceDraws:after.constantBlackSourceDraws-before.constantBlackSourceDraws,
    blackBorderDraws:after.constantBlackBorderDraws-before.constantBlackBorderDraws,
    spriteDraws:after.spriteDrawCalls-before.spriteDrawCalls};
}
let comparisons=0;
function compare(name,options) {
  const control=render(reference,options), optimized=render(candidate,options);
  assert.ok(control.pixels.equals(optimized.pixels), name+' complete RGBA');
  const shaderEligible=!(options.offset || options.alpha !== undefined && options.alpha !== 1 ||
    options.clear || options.passBlend || options.multiple || options.passTransform || options.resolution && options.resolution !== 1);
  assert.equal(optimized.specialized,shaderEligible?(options.nested?2:1):0,name+' specialization');
  assert.equal(optimized.filters,control.filters,name+' filter execution preserved');
  comparisons++;
}
try {
  if (process.argv.includes('--benchmark')) {
    const timed = (program, options, count = 1) => {
      native.render.finish();
      const start = performance.now();
      let specialized = 0;
      for (let frame = 0; frame < count; frame++)
        specialized += render(program, { ...options, timingOnly: true }).specialized;
      return { ms: (performance.now() - start) / count, specialized };
    };
    const firstNonIdentity = timed(candidate, { offset: 0.1 });
    const firstIdentity = timed(candidate, {});
    for (let warm = 0; warm < 3; warm++) { timed(reference, {}); timed(candidate, {}); }
    const general = [], identity = [];
    for (let sample = 0; sample < 5; sample++) {
      const order = sample % 2 ? [[candidate, identity], [reference, general]] :
        [[reference, general], [candidate, identity]];
      for (const [program, results] of order) results.push(timed(program, {}, 10));
    }
    console.log('identity-benchmark ' + JSON.stringify({ width, height, creationMs,
      firstNonIdentity, firstIdentity, general, identity }));
  }
  assert.deepEqual(render(reference,{clearRectangleResolution:2}).pixels,
    render(reference,{clearRectangleResolution:1}).pixels,'rectangle clears use the actual target resolution');
  compare('padded opaque group',{});
  compare('integer tile geometry',{tile:true});
  compare('animated tile',{tile:true,animation:1});
  compare('fractional tile geometry',{tile:true,fractionalTile:true});
  compare('fractional tile animation',{tile:true,animation:0.5});
  compare('main frame',{frame:[0,0,width,height]});
  compare('child scissor',{childClip:true});
  compare('full output clip',{clip:[0,0,width,height]});
  compare('linear source',{linear:true});
  for(const origin of [0,0.5,1,127.5]) compare('tiling origin '+origin,{tiling:true,origin});
  for(const alpha of [1,254/255,128/255,0,254/255,1])
    compare('backdrop transition '+alpha,{fillAlpha:alpha});
  for(const offset of [0,0.0000005,0.1,0]) compare('matrix transition '+offset,{offset});
  for(const [name,options] of [
    ['filter alpha',{alpha:0.9999999}],['no opaque fill',{noFill:true}],
    ['partial fill',{fillClip:[0,0,width-1,height]}],['partial output',{clip:[8,8,240,48]}],
    ['cropped frame',{frame:[8,8,width-16,height-16]}],
    ['fractional frame',{frame:[-3.5,-3.5,width+7,height+7]}],['resolution two',{resolution:2}],
    ['fractional camera',{fractional:true}],['scaled draw',{scaled:true}],['rotated draw',{rotated:true}],
    ['nested groups',{nested:true}],['mask',{mask:true}],['destructive clear',{clear:true}],
    ['modified pass blend',{passBlend:1}],['modified group blend',{groupBlend:1}],
    ['modified child blend',{childBlend:2}],['multiple passes',{multiple:true}],
    ['output transform',{passTransform:[1,0,0,1,1,0]}],['offscreen',{offscreen:true}]
  ]) compare(name,options);
  const changedVertex=native.render.createFilterProgram(shaders.fragment,shaders.vertex+'\n// changed vertex\n');
  assert.equal(render(changedVertex).specialized,0);
  const crlf=native.render.createFilterProgram(shaders.fragment.replaceAll('\n','\r\n'),shaders.vertex.replaceAll('\n','\r\n'));
  assert.ok(render(crlf).pixels.equals(render(reference).pixels));
  assert.equal(render(crlf).specialized,1);
  let blackComparisons=0;
  function compareBlack(name,options={},eligible=true) {
    const settings={...options,black:true};
    const control=render(candidate,{...settings,enabled:false});
    const optimized=render(candidate,settings);
    if(!control.pixels.equals(optimized.pixels)) {
      let count=0; const first=[];
      for(let at=0;at<control.pixels.length;at+=4) {
        if(control.pixels.subarray(at,at+4).equals(optimized.pixels.subarray(at,at+4))) continue;
        count++;
        if(first.length<5) first.push({x:at/4%width,y:Math.floor(at/4/width),
          control:Array.from(control.pixels.subarray(at,at+4)),candidate:Array.from(optimized.pixels.subarray(at,at+4))});
      }
      console.error(JSON.stringify({name,count,first}));
    }
    assert.ok(control.pixels.equals(optimized.pixels),name+' black complete RGBA');
    assert.equal(control.blackGroups,0,name+' disabled path');
    assert.equal(optimized.blackGroups+optimized.blackSkipped,eligible?1:0,name+' black eligibility');
    assert.equal(optimized.filters,control.filters,name+' original filter passes');
    blackComparisons++;
  }
  for(const [name,options] of [
    ['padded',{}],['viewport frame',{frame:[0,0,width,height]}],
    ['tiles',{tile:true}],['fractional tiles',{tile:true,fractionalTile:true}],
    ['animated tiles',{tile:true,animation:1}],['fractional sprite',{fractional:true}],
    ['rotated sprite',{rotated:true}],['scaled sprite',{scaled:true}],
    ['tiling',{tiling:true}],['linear',{linear:true}],['child clip',{childClip:true}],
    ['nested',{nested:true}],
    ['source fringe',{fringe:true}],['queued image',{queuedImageRelease:true}],
    ['queued image fringe',{queuedImageRelease:true,fringe:true}],
    ['queued tile',{tile:true,queuedLayerRelease:true}],
    ['neighbor samples',{nested:true,neighbor:true,fringe:true}],
    ['neighbor with overlay',{nested:true,neighbor:true,fringe:true,overlayFill:true}]
  ]) compareBlack(name,options);
  for(const [name,options] of [
    ['no backing',{noFill:true}],['partial backing',{fillAlpha:254/255}],
    ['transparent backing',{fillAlpha:0}],['backing clip',{fillClip:[0,0,width-1,height]}],
    ['output clip',{clip:[8,8,width-8,height-8]}],
    ['partial tone',{alpha:0.9999999}],['different matrix',{offset:0.1}],
    ['resolution',{resolution:0.5}],['fractional filter frame',{frame:[-3.5,-3.5,width+7,height+7]}],
    ['cropped filter frame',{frame:[8,8,width-16,height-16]}],['masked child',{mask:true}],
    ['child blend',{childBlend:1}],['group blend',{groupBlend:1}],['pass clear',{clear:true}],
    ['pass blend',{passBlend:1}],['multiple passes',{multiple:true}],
    ['pass transform',{passTransform:[1,0,0,1,1,0]}],['offscreen',{offscreen:true}]
  ]) compareBlack(name,options,false);
  for(const fillAlpha of [1,254/255,0,1])
    compareBlack('backing recovery '+fillAlpha,{fillAlpha},fillAlpha===1);
  for(const count of [1,2,4,16,64]) {
    compareBlack('full-screen cost gate '+count,{count,frame:[0,0,width,height]});
    compareBlack('tiny corner cost gate '+count,{count,small:true,frame:[0,0,width,height]});
    const kept=render(candidate,{black:true,count,small:true,frame:[0,0,width,height]});
    assert.equal(kept.blackSkipped,1,'expensive border rewrite skipped');
    assert.equal(kept.blackSourceDraws,count);
    assert.equal(kept.blackBorderDraws,count*2);
    assert.ok(kept.spriteDraws >= 1 && kept.spriteDraws <= count+1,
      'tiny draws and background retain ordinary batching');
  }
  assert.equal(render(reference,{black:true}).blackGroups,0,'unknown fragment fallback');
  assert.equal(render(changedVertex,{black:true}).blackGroups,0,'unknown vertex fallback');
  console.log(JSON.stringify({comparisons,blackComparisons,modifiedVertexFallback:true,crlfExact:true}));
} finally {
  for(const layer of layers) native.render.releaseTileLayer(layer);
  for(const canvas of canvases) native.canvas.release(canvas.handle);
  native.runtime.quit();
}
