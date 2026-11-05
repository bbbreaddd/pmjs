'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { createMvBlurContext } = require('./helpers/mv-blur-context.cjs');
const stock = require('./helpers/mv-reviewed-methods.cjs');
const native = require(path.resolve(process.argv[2]));
native.initialize({ gameRoot: path.resolve(process.argv[3]), width: 32, height: 32, windowTitle: 'Bitmap color transforms' });
const contexts = [false, true].map(disabled => {
  const c = createMvBlurContext(native, { disableOptimizations: disabled ?
    ['bitmap.native-adjustTone', 'bitmap.native-rotateHue'] : [] });
  c.PMJS.phases.emit('afterGuestPlugins'); return c;
});
let nativeCalls = 0;
for (const name of ['adjustTone', 'rotateHue']) {
  const operation = native.canvas[name];
  native.canvas[name] = function(...args) { nativeCalls++; return operation(...args); };
}
const handles = [];
function bitmap(context, w, h) {
  const b = new context.Bitmap(w, h); handles.push(b._canvas._ensureNativeCanvas().handle); return b;
}
function handle(b) { return b._canvas._ensureNativeCanvas().handle; }
function read(b) { return Buffer.from(native.canvas.readPremultipliedPixels(handle(b), 0, 0, b.width, b.height)); }
let seed = 0x12345678;
function pixels(w, h) {
  return Uint8Array.from({ length:w*h*4 }, () => { seed = (Math.imul(seed,1664525)+1013904223)>>>0; return seed>>>24; });
}
const tone = [[0.5,-0.5,1.5], [-255,255,127.5], [1e100,-1e100,0], [1,0,0]];
const hues = [-720,-60,-0.5,0.5,59.999999,60,120,180,240,300,360,719.75,1e100];
let comparisons = 0;
try {
  for (const [w,h] of [[1,1],[17,13],[256,256],[640,480]]) {
    const pair = contexts.map(c => bitmap(c,w,h));
    if (w === 17) for (const b of pair) {
      b._context.translate(9, -2); b._context.globalAlpha = 0.25;
      b._context.globalCompositeOperation = 'multiply';
      b._context.beginPath(); b._context.rect(0, 0, 1, 1); b._context.clip();
    }
    const input = pixels(w,h);
    if (w === 256) for (let alpha=0;alpha<256;alpha++) for (let color=0;color<256;color++)
      input.set([color,255-color,(color*73+alpha)&255,alpha],(alpha*256+color)*4);
    for (const [name,args] of [...tone.map(a=>['adjustTone',a]), ...hues.map(h=>['rotateHue',[h]])]) {
      for (const b of pair) {
        native.canvas.writePremultipliedPixels(handle(b),0,0,w,h,input);
        b[name](...args);
      }
      assert.deepEqual(read(pair[0]),read(pair[1]), `${w}x${h} ${name} ${args}`);
      comparisons++;
    }
  }
  assert.equal(nativeCalls, comparisons, 'every eligible transform used the native operation');
  // Deferred drawing and queued copies keep the content version they captured.
  for (const method of ['adjustTone','rotateHue']) {
    const source = bitmap(contexts[0],8,8), copy = native.canvas.create(8,8); handles.push(copy.handle);
    source.fillAll('red');
    native.canvas.drawImage(copy.handle,handle(source),0,0,8,8,0,0,8,8,1);
    source[method](120,0,0);
    const captured = native.canvas.readPixels(copy.handle,0,0,8,8);
    for (let i=0;i<captured.length;i+=4) assert.deepEqual(Array.from(captured.slice(i,i+4)),[255,0,0,255]);
    assert.equal(source.dirtyCalls,2);
  }
  assert.throws(()=>native.canvas.rotateHue(0,45), /invalid canvas/);
  assert.throws(()=>native.canvas.adjustTone(handles[0],Infinity,0,0), /non-finite/);
  assert.throws(()=>native.canvas.rotateHue(handles[0],NaN), /non-finite/);
  console.log(JSON.stringify({comparisons, exactPremultipliedBytes:true, ownership:true}));
  if (process.argv.includes('--benchmark')) {
    const results = [];
    for (const [w,h] of [[64,64],[640,480],[1024,1024]]) {
      const pair = contexts.map(c=>bitmap(c,w,h)), input=pixels(w,h);
      for (const [name,args] of [['adjustTone',[17.5,-29.5,41]], ['rotateHue',[37]]]) {
        const samples = [[],[]];
        for (let sample=-30;sample<7;sample++) for (const arm of sample%2 ? [1,0]:[0,1]) {
          const b=pair[arm];native.canvas.writePixels(handle(b),0,0,w,h,input);
          const start=performance.now();
          // The game runs in the host realm; VM global lookups would inflate the control.
          if (arm === 1) stock[name].apply(b,args); else b[name](...args);
          const ms=performance.now()-start;
          if(sample>=0) samples[arm].push(ms);
        }
        const median=a=>a.slice().sort((a,b)=>a-b)[Math.floor(a.length/2)];
        results.push({method:name,width:w,height:h,warmupCalls:30,nativeMs:median(samples[0]),stockMs:median(samples[1]),samples});
      }
    }
    console.log('bitmap-color-benchmark '+JSON.stringify(results));
  }
} finally {
  for (const h of handles) native.canvas.release(h);
  native.runtime.quit();
}
