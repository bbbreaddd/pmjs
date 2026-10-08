'use strict';
process.env.PMJS_GRAPHICS_DIAGNOSTICS = '1';
const assert = require('node:assert/strict');
const path = require('node:path');
const shaders = require('./helpers/color-matrix-shaders.cjs');
const native = require(path.resolve(process.argv[2]));
const [width, height] = (process.argv[4] || '256x64').split('x').map(Number);
native.initialize({gameRoot: path.resolve(process.argv[3]), width, height,
  windowTitle: 'identity filter shader'});
const schema = native.scene.schema, noParent = 0xffffffff;
const identity = [1,0,0,0,0,0,1,0,0,0,0,0,1,0,0,0,0,0,1,0];
const candidate = native.render.createFilterProgram(shaders.fragment, shaders.vertex);
// A semantically identical, unrecognized program keeps every reference operation.
const reference = native.render.createFilterProgram(shaders.fragment + '\n// reference\n', shaders.vertex);
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
  const matrix=identity.slice(); matrix[4]=options.offset || 0;
  const uniforms=program.uniforms.flatMap(u=>u.name==='m'?matrix:[options.alpha ?? 1]);
  const pass={program:program.handle,input:0,output:1,clear:!!options.clear,
    blend:options.passBlend || 0,uniforms,samplers:[],transform:options.passTransform || [1,0,0,1,0,0]};
  const plan=native.render.createFilterPlan({frame:options.frame || [-4,-4,width+8,height+8],
    resolutions:options.multiple?[1,1,1]:[options.resolution || 1,1],
    passes:options.multiple?[{...pass,output:2},{...pass,input:2}]:[pass]});
  const entries=[sprite(background)];
  let parent=1;
  if(options.nested) {entries.push(record(6,noParent,plan.handle,31)); parent=2;}
  const begin=record(6,options.nested?1:noParent,plan.handle,31,options.clip?1:0);
  if(options.clip) begin.values.set(options.clip,17);
  begin.values[34]=options.groupBlend || 0;
  entries.push(begin);
  if(!options.noFill) {
    const fill=record(3,parent,0,0,options.fillClip?1:0); fill.metadata[3]=0x131a27;
    fill.values[6]=options.fillAlpha ?? 1;
    if(options.fillClip) fill.values.set(options.fillClip,17);
    entries.push(fill);
  }
  const a=sprite(first,parent), b=sprite(second,parent);
  if(options.fractional) a.values[4]=0.5;
  if(options.scaled) a.values[0]=2;
  if(options.rotated) a.values.set([0,1,-1,0],0);
  if(options.childClip) {a.metadata[5]|=1;a.values.set([11,13,211,49],17);}
  if(options.mask) {a.metadata[5]|=4;a.metadata[6]=second.handle;a.values.set([1,0,0,1,0,0],22);}
  if(options.childBlend) a.metadata[4]=options.childBlend;
  if(options.tiling) {a.metadata[0]=2;a.values.set([options.origin ?? 0.5,0.5],15);}
  if(options.linear) a.metadata[5]&=~8;
  if(options.tile) {
    const tile=record(4,parent,layers[options.fractionalTile?1:0],0,8);
    tile.values.set([options.animation || 0,0],15); entries.push(tile);
  }
  entries.push(a,b,record(7,parent));
  if(options.nested) entries.push(record(7,1));
  const before=native.render.stats();
  native.beginFrame();
  native.scene.submit(schema.version,new Uint32Array(entries.flatMap(e=>e.metadata)),
    new Float32Array(entries.flatMap(e=>Array.from(e.values))),entries.length);
  let pixels;
  if(options.offscreen) {
    const target=native.canvas.create(width,height);
    native.render.renderToCanvas(target.handle);
    pixels=Buffer.from(native.canvas.readPremultipliedPixels(target.handle,0,0,width,height));
    native.canvas.release(target.handle);
  } else {native.renderScene();pixels=Buffer.from(native.canvas.captureSceneRawPremultiplied());}
  const after=native.render.stats();
  return {pixels,specialized:after.identityFilterShaderDrawCalls-before.identityFilterShaderDrawCalls,
    filters:after.filterDrawCalls-before.filterDrawCalls};
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
  console.log(JSON.stringify({comparisons,modifiedVertexFallback:true,crlfExact:true}));
} finally {
  for(const layer of layers) native.render.releaseTileLayer(layer);
  for(const canvas of canvases) native.canvas.release(canvas.handle);
  native.runtime.quit();
}
