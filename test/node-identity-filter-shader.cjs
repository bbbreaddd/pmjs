'use strict';
process.env.PMJS_GRAPHICS_DIAGNOSTICS = '1';
const assert = require('node:assert/strict');
const path = require('node:path');
const shaders = require('./helpers/color-matrix-shaders.cjs');
const native = require(path.resolve(process.argv[2]));
const [width, height] = (process.argv[4] || '256x64').split('x').map(Number);
native.initialize({gameRoot: path.resolve(process.argv[3]), width, height,
  windowTitle: 'identity filter shader',
  ...(process.env.PMJS_TEST_PROGRAM_CACHE_ROOT ? { programCacheRoot: process.env.PMJS_TEST_PROGRAM_CACHE_ROOT } : {}) });
assert.throws(() => native.render.createFilterPlan({frame:[0,0,1,1],resolutions:[1,1],passes:[]}),
  /requires at least one pass/);
const { createIdentityFilterScene } = require('./helpers/identity-filter-scene.cjs');
const scene = createIdentityFilterScene(native, { width, height });
const { candidate, reference, render } = scene;
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
  scene.dispose();
  native.runtime.quit();
}
