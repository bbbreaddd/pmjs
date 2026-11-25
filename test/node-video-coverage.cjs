'use strict';
process.env.PMJS_GRAPHICS_DIAGNOSTICS='1';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHostContext } = require('./helpers/mz-host-context.cjs');
const { runModule } = require('./helpers/runtime-context.cjs');
const native = require(path.resolve(process.argv[2]));
const ordinary = process.argv.includes('--ordinary-rendering');
native.initialize({ gameRoot: path.resolve(process.argv[3]), width: 32, height: 24, windowTitle: 'Sprite draw culling' });
try {
  const c = createHostContext(native, { graphics: false });
  for (const file of ['optimizations', 'compatibility']) runModule(c, 'js/pmjs-core/' + file + '.js');
  Object.assign(c,{setTimeout,clearTimeout,setInterval,clearInterval});
  vm.runInContext(fs.readFileSync(process.argv[4],'utf8'),c,{filename:'pixi.js'});
  c.nativeBootPhase = () => {}; c.NativeHost.runtime.loadScript = () => {};
  let renderer;
  if (Number.parseInt(c.PIXI.VERSION,10) === 5) {
    for (const file of ['setup','scene','filters','renderer']) runModule(c,'js/pmjs-pixi5/'+file+'.js');
    renderer = new c.PIXI.Renderer({width:32,height:24,transparent:true});
  } else {
    c.Tilemap = class Tilemap {};
    const setup = fs.readFileSync(require.resolve('../js/pmjs-pixi4/setup.js'),'utf8');
    vm.runInContext(setup.slice(0,setup.indexOf("NativeHost.runtime.loadScript('js/libs/pixi-picture.js')")),c);
    for (const file of ['render-preflight','scene-primitives','scene-filters','scene-packet',
      'scene-prepare','scene-classify','scene-encoders','scene-effects','renderer-managers','renderer-facade'])
      runModule(c,'js/pmjs-pixi4/'+file+'.js');
    c.pmjsPixiRenderPreflight.scan();
    renderer = c.createNativePixiRenderer({width:32,height:24,transparent:true});
  }
  if(Number.parseInt(c.PIXI.VERSION,10)!==5) {
    c.PIXI.utils.EventEmitter.call(renderer);
    for(const method of ['on','once','off','emit','listeners','removeListener'])
      renderer[method]=c.PIXI.utils.EventEmitter.prototype[method];
  }
  const stage = new c.PIXI.Container(), layer = new c.PIXI.Container();
  const makeSprite = color => {
    const canvas = c.document.createElement('canvas'); canvas.width = canvas.height = 2;
    const context = canvas.getContext('2d'); context.fillStyle = color; context.fillRect(0,0,2,2);
    const resource = native.images.loadBytes(Buffer.from(canvas.toDataURL().split(',')[1], 'base64'));
    const source = new c.Image();
    source._nativeImage = resource; source.width = source.naturalWidth = 2;
    source.height = source.naturalHeight = 2; source.complete = true; source._src = "fixture.png";
    const base = Number.parseInt(c.PIXI.VERSION,10) === 5 ?
      new c.PIXI.BaseTexture(source,{scaleMode:c.PIXI.SCALE_MODES.NEAREST,mipmap:c.PIXI.MIPMAP_MODES.OFF}) :
      new c.PIXI.BaseTexture(source,c.PIXI.SCALE_MODES.NEAREST);
    base.mipmap = false;
    const sprite = new c.PIXI.Sprite(new c.PIXI.Texture(base));
    sprite.width = 32; sprite.height = 24; return sprite;
  };
  const background = makeSprite('#0000ff'), video = makeSprite('#ff0000');
  stage.addChild(background); stage.addChild(layer); layer.addChild(video);
  let referenceMesh;
  if(ordinary) {
    const base=background.texture.baseTexture,source=base.source||base.resource.source;
    referenceMesh=native.render.createMesh(source._nativeImage.handle,
      new Float32Array([1000,1000,1004,1000,1000,1004]),
      new Float32Array([0,0,1,0,0,1]),[0,1,2],4);
    const scene=c.NativeHost.scene,submit=scene.submit;
    c.NativeHost.scene={...scene,submit(version,metadata,values,count) {
      const nextMetadata=new Uint32Array((count+1)*7),nextValues=new Float32Array((count+1)*41);
      nextMetadata.set(metadata.subarray(0,count*7));nextValues.set(values.subarray(0,count*41));
      nextMetadata.set([8,0xffffffff,referenceMesh,0xffffff,0,0,0],count*7);
      nextValues[count*41]=nextValues[count*41+3]=nextValues[count*41+6]=1;
      return submit.call(scene,version,nextMetadata,nextValues,count+1);
    }};
  }
  const children = stage.children.slice(), events = [], captured = [], skippedFrames = [];
  const captureFrames = process.argv[5] === '--capture-frames';
  const unsupported = [];
  let callbacks = 0;
  renderer.on('prerender', () => {
    callbacks++; events.push('pre');
    assert.equal(background.visible, true);
    assert.deepEqual(stage.children, children);
  });
  renderer.on('postrender', () => events.push('post'));
  function check(skips, expected) {
    native.beginFrame(); const before = native.render.stats().coveredCommandsSkipped;
    renderer.render(stage); native.renderScene();
    const actual = Buffer.from(native.canvas.captureSceneRawPremultiplied());
    if(captureFrames) captured.push(Array.from(actual));
    const skipped = native.render.stats().coveredCommandsSkipped-before;
    if(captureFrames) skippedFrames.push(skipped);
    if(ordinary) assert.equal(skipped,0); else if(skips===true) assert.ok(skipped>0); else assert.equal(skipped,skips);
    for (let y=0; y<24; y++) for(let x=0; x<32; x++) {
      const pixel = typeof expected === 'function' ? expected(x,y) : expected;
      for(let ch=0; ch<4; ch++) assert.ok(Math.abs(actual[(y*32+x)*4+ch]-pixel[ch])<=1,
        `pixel ${x},${y} channel ${ch}: ${actual[(y*32+x)*4+ch]} versus ${pixel[ch]}`);
    }
    assert.equal(background.visible, true); assert.equal(video.parent, layer);
  }
  function alphaFilter(alpha) {
    if(Number.parseInt(c.PIXI.VERSION,10)===5) return new c.PIXI.filters.AlphaFilter(alpha);
    const filter = new c.PIXI.filters.ColorMatrixFilter(), matrix = filter.matrix.slice();
    matrix[18] = alpha; filter.matrix = matrix; return filter;
  }
  check(1,[255,0,0,255]);
  background.filters = [alphaFilter(0.5)];
  check(true,[255,0,0,255]); background.filters = null;
  video.texture.baseTexture.mipmap = true; check(1,[255,0,0,255]);
  video.texture.baseTexture.mipmap = false;
  layer.renderable = false; check(0,[0,0,255,255]); layer.renderable = true;
  layer.visible = false; check(0,[0,0,255,255]); layer.visible = true;
  video.alpha = 0.5; check(0,[128,0,127,255]); video.alpha = 1;
  renderer.once('prerender', () => { video.alpha = 0.5; });
  check(0,[128,0,127,255]); video.alpha = 1;
  const filter = alphaFilter(0.5);
  layer.filters = [filter]; check(0,[128,0,127,255]); layer.filters = null;
  stage.filters = [filter]; check(0,[128,0,0,128]); stage.filters = null;
  video.width = 16;
  check(0,x => x<16 ? [255,0,0,255] : [0,0,255,255]); video.width = 32;
  check(1,[255,0,0,255]);
  const mask = makeSprite('#ffffff'); mask.width = 16; layer.addChild(mask); video.mask = mask;
  if(Number.parseInt(c.PIXI.VERSION,10)===5) {
    const before=c.PMJS.compat.count('render.mask');
    check(0,[0,0,255,255]);
    assert.equal(c.PMJS.compat.count('render.mask'),before+1);
    unsupported.push({frame:11,capability:'render.mask'});
  } else check(0,x => x<16 ? [255,0,0,255] : [0,0,255,255]);
  video.mask = null; layer.removeChild(mask); mask.destroy();
  layer.removeChild(video); layer.addChild(video); check(1,[255,0,0,255]);
  const inner = new c.PIXI.Container(); inner.addChild(makeSprite('#00ff00'));
  const target = Number.parseInt(c.PIXI.VERSION,10)===5 ?
    c.PIXI.RenderTexture.create({width:16,height:12}) : c.PIXI.RenderTexture.create(16,12);
  renderer.once('prerender',()=>renderer.render(inner,target,true));
  check(1,[255,0,0,255]);
  assert.deepEqual(events.slice(-4),['pre','pre','post','post']);
  let filterApplyCalls=0, filterTargetPixels;
  if(Number.parseInt(c.PIXI.VERSION,10)!==5) {
    const feedback=c.PIXI.RenderTexture.create(16,12);
    const custom=new c.PIXI.Filter(undefined,
      'varying vec2 vTextureCoord; uniform sampler2D uSampler; void main(){gl_FragColor=texture2D(uSampler,vTextureCoord);}');
    custom.apply=function(manager,input,output,clear) {
      filterApplyCalls++;renderer.render(inner,feedback,true);
      manager.applyFilter(this,input,output,clear);
    };
    background.filters=[custom];check(true,[255,0,0,255]);background.filters=null;
    filterTargetPixels=Array.from(renderer.extract.pixels(feedback));
    for(let i=0;i<filterTargetPixels.length;i++)assert.equal(filterTargetPixels[i],[0,255,0,255][i%4]);
    assert.equal(filterApplyCalls,1);feedback.destroy(true);
  }
  assert.equal(callbacks,Number.parseInt(c.PIXI.VERSION,10)===5?15:17);
  assert.equal(events.filter(e=>e==='post').length,callbacks);
  assert.deepEqual(Object.keys(c.PMJS.compat.dump()).filter(k=>k.startsWith('render.')),
    Number.parseInt(c.PIXI.VERSION,10)===5?['render.mask']:[]);
  inner.destroy({children:true});target.destroy(true);
  stage.destroy({children:true});
  if(referenceMesh)native.render.releaseTileLayer(referenceMesh);
  console.log(JSON.stringify({ok:true,pixi:c.PIXI.VERSION,ordinary,callbacks,unsupported,
    ...(captureFrames?{frames:captured,skippedFrames,filterApplyCalls,filterTargetPixels}:{})}));
} finally { native.runtime.quit(); }
