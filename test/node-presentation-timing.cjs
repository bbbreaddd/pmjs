'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const native = require(path.resolve(process.argv[2]));
native.initialize({gameRoot:path.resolve(process.argv[3]),width:64,height:64,windowTitle:'presentation timing'});
native.beginFrame();
native.render.quad(0,0,64,64,0,1,0,1);
native.renderFrame();
native.swapFrame();
const before = native.render.stats().presentationTimings;
assert.equal(before.enabled,true);
assert.equal(before.completion.calls,1);
assert.equal(before.swap.calls,1);
// An offscreen snapshot cannot add a window-completion wait or presentation.
native.beginFrame();
native.render.setRenderTargetSize(16,16);
native.render.quad(0,0,16,16,1,0,0,1);
const image=native.render.renderToImage(16,16);
try {
 const after = native.render.stats().presentationTimings;
 assert.equal(after.completion.calls,before.completion.calls);
 assert.equal(after.swap.calls,before.swap.calls);
 assert.equal(after.windowBind.calls,before.windowBind.calls);
 native.renderFrame();
 native.swapFrame();
 const final = native.render.stats().presentationTimings;
 assert.equal(final.completion.calls,2);
 assert.equal(final.swap.calls,2);
 for(const phase of ['scene','presentation','windowBind','firstWindowWrite','completion','swap']) {
  assert.ok(Number.isFinite(final[phase].wallMs) && final[phase].wallMs>=0);
  assert.ok(Number.isFinite(final[phase].cpuMs) && final[phase].cpuMs>=0);
 }
}finally{native.images.release(image.handle);}
