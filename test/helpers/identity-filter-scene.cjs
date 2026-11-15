'use strict';
const assert = require('node:assert/strict');
const shaders = require('./color-matrix-shaders.cjs');

function createIdentityFilterScene(native, { width, height, candidate } = {}) {
  const schema = native.scene.schema, noParent = 0xffffffff;
  const identity = [1,0,0,0,0,0,1,0,0,0,0,0,1,0,0,0,0,0,1,0];
  candidate = candidate || native.render.createFilterProgram(shaders.fragment, shaders.vertex);
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
      if (options.readback !== false) pixels=Buffer.from(native.canvas.captureSceneRawPremultiplied());
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
  return { candidate, reference, render, dispose() {
    for(const layer of layers) native.render.releaseTileLayer(layer);
    for(const canvas of canvases) native.canvas.release(canvas.handle);
  } };
}

module.exports = { createIdentityFilterScene };
