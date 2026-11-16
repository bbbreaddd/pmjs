'use strict';
const assert=require('node:assert/strict');
const test=require('node:test');
const vm=require('node:vm');
const {runModule}=require('./helpers/runtime-context.cjs');
function fixture() {
  const calls=[], released=[];
  const context=vm.createContext({console,NativeHost:{runtime:{env:()=>''},
    canvas:{create(width,height){calls.push(['create',width,height]);return {handle:91,width,height};},
      drawImage(...args){calls.push(['draw',...args]);},release(handle){released.push(['canvas',handle]);}},
    images:{release(handle){released.push(['image',handle]);}}}});
  for(const name of ['events','canvas','elements'])runModule(context,'js/pmjs-web/'+name+'.js');
  const canvas=new context.CanvasElement();canvas.width=8;canvas.height=6;
  return {canvas,calls,released};
}
test('GPU canvas sampling stays on GPU and pixel access materializes its owned image once',()=>{
  const {canvas,calls,released}=fixture(), image={handle:31,width:8,height:6};
  canvas._setRenderImage(image);
  assert.equal(canvas._pmjsNativeTextureSource(),image);
  assert.equal(canvas._nativeCanvas,null);assert.equal(calls.length,0);
  const revision=canvas.__pmjsContentRevision;
  const resource=canvas._ensureNativeCanvas();
  assert.deepEqual(calls,[['create',8,6],['draw',91,31,0,0,8,6,0,0,8,6,1,false]]);
  assert.deepEqual(released,[['image',31]]);
  assert.equal(canvas.__pmjsContentRevision,revision);
  assert.equal(canvas._pmjsNativeTextureSource(),resource);
  canvas._ensureNativeCanvas();assert.equal(calls.length,2);
  canvas._releaseNativeCanvas();assert.deepEqual(released,[['image',31],['canvas',91]]);
});
test('GPU canvas replacement and resize release obsolete ownership without readback',()=>{
  const {canvas,calls,released}=fixture();
  canvas._setRenderImage({handle:31});canvas._setRenderImage({handle:32});
  assert.deepEqual(released,[['image',31]]);
  canvas.width=8;
  assert.deepEqual(released,[['image',31],['image',32]]);
  assert.equal(canvas._renderImage,null);assert.equal(calls.length,0);
});
