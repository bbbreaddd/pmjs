'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {createHostContext}=require('./helpers/mz-host-context.cjs');
const {runModule}=require('./helpers/runtime-context.cjs');
const native=require(path.resolve(process.argv[2]));
native.initialize({gameRoot:path.resolve(process.argv[3]),width:32,height:24,windowTitle:'RenderTexture GPU ownership'});
try {
  const c=createHostContext(native,{graphics:false});
  for(const file of ['optimizations','compatibility'])runModule(c,'js/pmjs-core/'+file+'.js');
  vm.runInContext(fs.readFileSync(process.argv[4],'utf8'),c,{filename:'pixi.js'});
  c.Tilemap=class Tilemap {};
  c.nativeBootPhase=()=>{};c.NativeHost.runtime.loadScript=()=>{};
  const setup=fs.readFileSync(path.resolve(__dirname,'../js/pmjs-pixi4/setup.js'),'utf8');
  vm.runInContext(setup.slice(0,setup.indexOf("NativeHost.runtime.loadScript('js/libs/pixi-picture.js')")),c);
  for(const file of ['render-preflight','scene-primitives','scene-filters','scene-packet','scene-prepare','scene-classify','scene-encoders','scene-effects','renderer-managers','renderer-facade'])
    runModule(c,'js/pmjs-pixi4/'+file+'.js');
  c.pmjsPixiRenderPreflight.scan();
  const renderer=c.createNativePixiRenderer({width:32,height:24,transparent:true});
  let readbacks=0;
  const readback=c.NativeHost.render.renderToCanvas;
  c.NativeHost.render={...c.NativeHost.render,renderToCanvas(...args){readbacks++;return readback(...args);}};
  function block(color,alpha=1,x=0,y=0,w=8,h=6) {
    const node=new c.PIXI.Graphics();node.beginFill(color,alpha);node.drawRect(x,y,w,h);node.endFill();return node;
  }
  const target=c.PIXI.RenderTexture.create(8,6);
  const source=new c.PIXI.Container();source.addChild(block(0xff0000,0.5,0,0,8,3));source.addChild(block(0x0000ff,1,0,3,8,3));
  const reference=new c.CanvasElement();reference.width=8;reference.height=6;
  c.PMJS.pixi4.renderStageToCanvas(source,reference,false,renderer);
  const expected=Array.from(native.canvas.readPremultipliedPixels(reference._ensureNativeCanvas().handle,0,0,8,6));
  const expectedTop=Array.from(native.canvas.readPixels(reference._ensureNativeCanvas().handle,4,1,1,1));
  readbacks=0;
  renderer.render(source,target,true);
  const canvas=target.baseTexture.__pmjsRenderCanvas;
  assert.ok(canvas._renderImage);assert.equal(canvas._nativeCanvas,null);assert.equal(readbacks,0);
  const snapshot=c.document.createElement('canvas');snapshot.width=8;snapshot.height=6;
  snapshot.getContext('2d').drawImage(canvas,0,0);
  const pixel=(canvas,x,y)=>Array.from(native.canvas.readPixels(canvas._ensureNativeCanvas().handle,x,y,1,1));
  assert.deepEqual(pixel(canvas,4,1),expectedTop);
  assert.deepEqual(Array.from(native.canvas.readPremultipliedPixels(canvas._ensureNativeCanvas().handle,0,0,8,6)),expected,'GPU backing matches the independent CPU readback path');assert.deepEqual(pixel(canvas,4,4),[0,0,255,255]);
  renderer.render(block(0x00ff00),target,true);
  assert.deepEqual(pixel(snapshot,4,1),expectedTop,'retained draws keep the old capture');
  assert.deepEqual(pixel(canvas,4,1),[0,255,0,255]);
  renderer.render(block(0xff0000,0.5,0,0,4,6),target,false);
  assert.deepEqual(pixel(canvas,6,2),[0,255,0,255],'clear=false preserves old target pixels');
  const blended=pixel(canvas,2,2);assert.ok(Math.abs(blended[0]-128)<=1&&Math.abs(blended[1]-127)<=1&&blended[3]===255);
  native.beginFrame();native.render.setScreenRenderSize(32,24);native.render.setClearBeforeRender(true);
  native.render.quad(0,0,32,24,0,1,0,1);native.renderScene();
  native.beginFrame();native.render.setClearBeforeRender(false);
  renderer.render(block(0xff0000,1,0,0,1,1),target,true);
  assert.deepEqual(pixel(canvas,6,4),[0,0,0,0],'explicit target clear does not inherit screen clear policy');
  native.render.setClearBeforeRender(true);
  renderer.render(block(0x0000ff),target,true);
  target.resize(4,3);renderer.render(block(0x0000ff),target,true);
  assert.equal(canvas.width,4);assert.equal(canvas.height,3);
  canvas.getContext('2d').fillStyle='#ffffff';canvas.getContext('2d').fillRect(0,0,1,1);
  assert.deepEqual(pixel(canvas,0,0),[255,255,255,255]);
  assert.deepEqual(pixel(canvas,2,1),[0,0,255,255]);
  const view=new c.PIXI.RenderTexture(target.baseTexture,new c.PIXI.Rectangle(1,1,2,1));
  assert.deepEqual(Array.from(renderer.extract.pixels(view)),[0,0,255,255,0,0,255,255]);view.destroy(false);
  renderer.render(block(0x0000ff),target,true);
  function frame(stage) {
    native.beginFrame();renderer.render(stage);native.renderScene();
    return Buffer.from(native.canvas.captureSceneRawPremultiplied());
  }
  const stage=new c.PIXI.Container(), cached=stage.addChild(new c.PIXI.Container());
  cached.x=4;cached.y=3;
  const drawing=cached.addChild(block(0xff0000,0.5));
  const live=frame(stage);
  cached.cacheAsBitmap=true;assert.deepEqual(frame(stage),live,'cache pixels match live rendering');
  drawing.clear();drawing.beginFill(0x00ff00,0.5);drawing.drawRect(0,0,8,6);drawing.endFill();
  assert.deepEqual(frame(stage),live,'cache retains its snapshot after source changes');
  cached.cacheAsBitmap=false;const changed=frame(stage);assert.notDeepEqual(changed,live);
  cached.cacheAsBitmap=true;assert.deepEqual(frame(stage),changed,'cache reset captures current source');
  stage.cacheAsBitmap=true;assert.deepEqual(frame(stage),changed,'nested cache captures finish before outer encoding');
  stage.cacheAsBitmap=false;cached.cacheAsBitmap=false;
  const blurStage=new c.PIXI.Container();
  const blurSprite=blurStage.addChild(new c.PIXI.Sprite(c.PIXI.Texture.fromCanvas(reference)));
  blurSprite.x=8;blurSprite.y=8;blurSprite.filters=[new c.PIXI.filters.BlurFilter(2,2,1)];
  blurSprite.cacheAsBitmap=true;const gpuBlur=frame(blurStage);blurSprite.cacheAsBitmap=false;
  const gpuCapture=c.NativeHost.render.renderToImage;
  c.NativeHost.render.renderToImage=function(width,height) {
    const backing=native.canvas.create(width,height);
    try {return readback(backing.handle,true,true);}
    finally {native.canvas.release(backing.handle);}
  };
  let cpuBlur;
  try {blurSprite.cacheAsBitmap=true;cpuBlur=frame(blurStage);}
  finally {c.NativeHost.render.renderToImage=gpuCapture;blurSprite.cacheAsBitmap=false;}
  assert.deepEqual(gpuBlur,cpuBlur,'filtered GPU cache preserves CPU capture pixels');
  const image=canvas._renderImage.handle;
  const sibling=new c.PIXI.RenderTexture(target.baseTexture);
  target.destroy(false);assert.equal(canvas._renderImage.handle,image);
  sibling.destroy(true);assert.equal(canvas._renderImage,null);
  snapshot._releaseNativeCanvas();reference._releaseNativeCanvas();
  assert.equal(readbacks,0,'RenderTexture and bitmap caches must not use CPU render capture');
  console.log(JSON.stringify({version:c.PIXI.VERSION,ok:true,renderToCanvasCalls:readbacks}));
} finally {native.runtime.quit();}
