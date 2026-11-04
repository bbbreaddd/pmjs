'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { temporaryDirectory } = require('./helpers/temp.cjs');

function runGuest(source, options = {}) {
  const directory = temporaryDirectory('event-ordering-');
  const runtime = path.resolve(__dirname, '..');
  const addon = path.join(directory, 'addon.cjs');
  fs.writeFileSync(addon, `let polls=0; module.exports={
    initialize(){}, pollEvents(){return !globalThis.finished && ++polls<200;},
    beginFrame(){}, renderFrame(){}, swapFrame(){
      if(${Number(options.frameCostMs) || 0})Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,${Number(options.frameCostMs) || 0});
    },
    runtime:{env(){return '';},monotonicNow(){return performance.now();},quit(){}},
    fs:{mountWritableOverlay(){},updateWritableOverlay(){},readBytes(){return Buffer.from('{}');},
      readText(){return '{}';},readBytesAsync(){return Promise.resolve(Buffer.from('{}'));}},
    render:{},scene:{},images:{},assets:{},
    input:{snapshot(){return {};},consumePressed(){}},canvas:{},media:{}
  };`);
  const bootstrap = path.join(directory, 'bootstrap.js');
  fs.writeFileSync(bootstrap, `globalThis.PMJS={config:{}};
    const fs=__pmjsBuiltinRequire('node:fs');
    for(const module of ['pmjs-web/events','pmjs-web/scheduler','pmjs-web/filesystem',
      'pmjs-web/requests','pmjs-rpgmaker/main-loop','pmjs-mv/main-loop']) {
      NativeHost.runtime.runScript(fs.readFileSync(${JSON.stringify(runtime)}+'/js/'+module+'.js','utf8'));
    }
    globalThis.trace=[]; ${source}
    globalThis.__pmjsRender=()=>{if(complete())globalThis.finished=true;};`);
  const result = spawnSync(process.execPath, ['-e', `
    require(${JSON.stringify(path.join(runtime, 'runner/index.cjs'))}).run(${JSON.stringify({
      addon, bootstrap, gameRoot: directory, saveRoot: path.join(directory, 'save'),
      width: 64, height: 64, renderHz: options.renderHz || 60, assetPreparation: 'off'
    })}).then(()=>console.log('TRACE:'+JSON.stringify(globalThis.trace)),e=>{console.error(e);process.exitCode=1;});
  `], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, options.expectedError ? 1 : 0, result.stderr || String(result.error));
  if (options.expectedError) { assert.match(result.stderr, options.expectedError); return; }
  const marker = result.stdout.split('\n').find(line => line.startsWith('TRACE:'));
  assert.ok(marker, result.stdout);
  return JSON.parse(marker.slice(6));
}

test('runner checkpoints between deferred tasks, timers, and animation callbacks', () => {
  const trace = runGuest(`
    for(let i=0;i<100;i++)PMJS.tasks.enqueue(()=>{
      trace.push('task:'+i);Promise.resolve().then(()=>Promise.resolve()).then(()=>trace.push('micro:'+i));
    });
    setTimeout(()=>{trace.push('timer:A');Promise.resolve().then(()=>trace.push('timer:micro'));},0);
    setTimeout(()=>trace.push('timer:B'),0);
    requestAnimationFrame(()=>{trace.push('raf:A');Promise.resolve().then(()=>trace.push('raf:micro'));});
    requestAnimationFrame(()=>trace.push('raf:B'));
    function complete(){return trace.includes('micro:99')&&trace.includes('timer:B')&&trace.includes('raf:B');}
  `);
  for (let i = 0; i < 99; i++) assert.ok(trace.indexOf('micro:' + i) < trace.indexOf('task:' + (i + 1)), trace.join(','));
  assert.ok(trace.indexOf('timer:micro') < trace.indexOf('timer:B'), trace.join(','));
  assert.ok(trace.indexOf('raf:micro') < trace.indexOf('raf:B'), trace.join(','));
});

test('nextTick precedes immediates, Promises, timer callbacks and filesystem completions', () => {
  const trace = runGuest(`
    process.nextTick(()=>trace.push('tick:top'));
    Promise.resolve().then(()=>trace.push('promise:top'));
    setImmediate(()=>{
      trace.push('immediate');
      process.nextTick(()=>trace.push('tick:immediate'));
      Promise.resolve().then(()=>trace.push('promise:immediate'));
    });
    setTimeout(()=>{
      trace.push('timer');
      process.nextTick(()=>trace.push('tick:timer'));
      Promise.resolve().then(()=>trace.push('promise:timer'));
    },0);
    fsModule.readFile('file',()=>{
      trace.push('filesystem');
      process.nextTick(()=>trace.push('tick:filesystem'));
      Promise.resolve().then(()=>trace.push('promise:filesystem'));
    });
    function complete(){
      return ['tick:top','promise:top','tick:immediate','promise:immediate',
        'tick:timer','promise:timer','tick:filesystem','promise:filesystem']
        .every(value=>trace.includes(value));
    }
  `);
  for (const source of ['top', 'immediate', 'timer', 'filesystem']) {
    assert.ok(trace.indexOf('tick:' + source) < trace.indexOf('promise:' + source), trace.join(','));
  }
  assert.ok(trace.indexOf('tick:top') < trace.indexOf('immediate'), trace.join(','));
});

test('warm images become listener-ready before twenty saturated frames', () => {
  const trace = runGuest(`
    PMJS.images={shouldRetainPixels(){return false;},loadCompleted(){}};
    globalThis.trackNativeResource=result=>result;
    globalThis.releaseNativeResource=()=>{};
    NativeHost.images.loadAsync=()=>Promise.resolve({width:48,height:32});
    NativeHost.runtime.runScript(fs.readFileSync(${JSON.stringify(path.resolve(__dirname, '../js/pmjs-web/elements.js'))},'utf8'));
    NativeHost.runtime.runScript(fs.readFileSync(${JSON.stringify(path.resolve(__dirname, '../js/pmjs-web/image-element.js'))},'utf8'));
    let frames=0,ready=0;
    const images=[];
    function draw(){
      frames++;
      if(frames===1)for(let i=0;i<17;i++){
        const image=new NativeImage();images.push(image);
        image.onload=()=>{
          if(!image.complete||image.width!==48||image.height!==32)throw new Error('incomplete image');
          ready++;trace.push(['ready',i,frames]);
        };
        image.src='image-'+i+'.png';
      }
      requestAnimationFrame(draw);
    }
    requestAnimationFrame(draw);
    function complete(){return ready===17;}
  `, { frameCostMs: 20 });
  assert.equal(trace.length, 17);
  assert.ok(trace.every(row => row[2] < 20), JSON.stringify(trace));
});

test('runner logs a throwing Node filesystem callback like NW.js and keeps delivering guest work', () => {
  const trace = runGuest(`
    fsModule.readFile('file',()=>{throw new Error('filesystem callback');});
    fsModule.readFile('file',()=>trace.push('next'));
    requestAnimationFrame(()=>trace.push('raf'));
    function complete(){return trace.includes('next')&&trace.includes('raf');}
  `);
  assert.deepEqual([...trace].sort(), ['next', 'raf']);
});

test('async filesystem callback rejections use their own guest route and keep the worker alive', () => {
  const trace = runGuest(`
    globalThis.pmjsReportUnhandledPromiseRejection=(reason,promise,origin)=>{
      trace.push(['rejection',reason.message,origin,promise instanceof Promise]);
    };
    const target=new EventTarget();
    target.addEventListener('click',async()=>{throw new Error('async browser listener');});
    target.dispatchEvent({type:'click'});
    fsModule.readFile('file',async()=>{throw new Error('async filesystem callback');});
    setTimeout(()=>trace.push('continued'),0);
    function complete(){return trace.some(x=>Array.isArray(x)&&x[0]==='rejection')&&trace.includes('continued');}
  `);
  assert.deepEqual(trace.filter(entry => Array.isArray(entry)).map(entry => entry.slice(1)).sort(), [
    ['async browser listener', 'browser', true],
    ['async filesystem callback', 'node', true]
  ]);
  assert.ok(trace.includes('continued'));
});

test('readFile without a callback follows the Node 9 warning and fallback behavior', () => {
  const trace = runGuest(`
    let scheduled=0,reads=0;
    const enqueue=PMJS.tasks.enqueue,readBytesAsync=NativeHost.fs.readBytesAsync;
    PMJS.tasks.enqueue=function(){scheduled++;return enqueue.apply(this,arguments);};
    NativeHost.fs.readBytesAsync=function(){reads++;return readBytesAsync.apply(this,arguments);};
    const calls=[],warnings=[];
    process.on('warning',warning=>warnings.push(warning.code));
    for(const args of [['file'],['file',{encoding:'utf8'}]]){
      try{fsModule.readFile(...args);calls.push('returned');}
      catch(error){calls.push(error.name+': '+error.message);}
    }
    setTimeout(()=>trace.push(...calls,scheduled,reads,warnings[0]),0);
    function complete(){return trace.length===5;}
  `);
  assert.deepEqual(trace.slice(0, 2), ['returned', 'returned']);
  assert.ok(trace[2] > 0);
  assert.equal(trace[3], 2);
  assert.equal(trace[4], 'DEP0013');
});

for (const renderHz of [30, 60]) test('runner service Promise readiness precedes the host ticker, rate=' + renderHz, () => {
  const trace = runGuest(`
    let ready=false;
    PMJS.rpgmaker={audio:{update(){Promise.resolve().then(()=>Promise.resolve()).then(()=>{ready=true;});}}};
    PMJS.mv={};
    globalThis.SceneManager={_scene:null,ticker:{_pmjsHostDriven:true,update(){trace.push('ticker:'+ready);}}};
    requestAnimationFrame(()=>trace.push('raf:'+ready));
    function complete(){return trace.includes('raf:true');}
  `, { renderHz });
  assert.ok(trace.includes('ticker:true'), trace.join(','));
  assert.ok(!trace.includes('ticker:false'));
});

test('runner shutdown cancels browser timers and discards queued results', () => {
  const trace = runGuest(`
    let ended=false;
    PMJS.tasks.onStop(()=>trace.push('stopped'));
    requestAnimationFrame(()=>{
      setInterval(()=>trace.push('late-timer'),1);
      PMJS.tasks.enqueue(()=>trace.push('late-task'),{discard:()=>trace.push('released')});
      ended=true;
    });
    function complete(){return ended;}
  `);
  assert.ok(trace.includes('released') || trace.includes('late-task'));
  assert.equal(trace.at(-1), 'stopped');
});

test('runner XHR checkpoints between DONE and load, and between independent completions', () => {
  const trace = runGuest(`
    for(const name of ['A','B']){
      const xhr=new XMLHttpRequest();xhr.open('GET','data/'+name+'.json');
      xhr.onreadystatechange=()=>{trace.push(name+':state:'+xhr.readyState);
        if(xhr.readyState===4)Promise.resolve().then(()=>trace.push(name+':micro'));};
      xhr.onload=()=>trace.push(name+':load');xhr.onloadend=()=>trace.push(name+':end');xhr.send();
    }
    function complete(){return trace.includes('A:end')&&trace.includes('B:end');}
  `);
  for (const name of ['A', 'B']) {
    assert.ok(trace.includes(name + ':state:2'));
    assert.ok(trace.includes(name + ':state:3'));
    assert.ok(trace.indexOf(name + ':micro') < trace.indexOf(name + ':load'), trace.join(','));
  }
  const first = trace.indexOf('A:load') < trace.indexOf('B:load') ? 'A' : 'B';
  const second = first === 'A' ? 'B' : 'A';
  assert.ok(trace.indexOf(first + ':micro') < trace.indexOf(second + ':load'));
});

test('discarded guest rejections reach browser and Node handlers through the real process bridge', () => {
  const trace = runGuest(`
    globalThis.pmjsReportUnhandledPromiseRejection=(reason,promise,origin)=>{
      trace.push([reason.message,origin]);
      if(reason.message==='timer')setTimeout(()=>promise.catch(()=>{}),0);
    };
    globalThis.pmjsReportHandledPromiseRejection=()=>trace.push('handled');
    setTimeout(()=>{Promise.reject(new Error('timer'));},0);
    setImmediate(()=>{Promise.resolve().then(()=>{Promise.reject(new Error('chain'));});});
    PMJS.tasks.nextTick(async()=>{await Promise.resolve();Promise.reject(new Error('await'));});
    fsModule.readFile('file',()=>{Promise.reject(new Error('filesystem'));});
    const target=new EventTarget();
    target.addEventListener('click',()=>{Promise.reject(new Error('event'));});
    target.dispatchEvent({type:'click'});
    requestAnimationFrame(()=>{Promise.reject(new Error('raf'));});
    NativeHost.runtime.runScript('Promise.reject(new Error("script"));');
    function complete(){return trace.filter(Array.isArray).length===7&&trace.includes('handled');}
  `);
  assert.deepEqual(trace.filter(Array.isArray).sort(), [
    ['await','node'], ['chain','node'], ['event','browser'], ['filesystem','node'],
    ['raf','browser'], ['script','browser'], ['timer','browser']
  ]);
  assert.ok(trace.includes('handled'));
});

test('infrastructure rejections remain fatal after guest callbacks have run', () => {
  runGuest(`
    setTimeout(()=>trace.push('guest'),0);
    __pmjsBuiltinRequire('node:timers').setImmediate(()=>{
      Promise.reject(new Error('host infrastructure rejection'));
    });
    function complete(){return false;}
  `, { expectedError: /host infrastructure rejection/ });
});

test('a host filesystem rejection created during guest work remains fatal', () => {
  runGuest(`
    NativeHost.fs.readBytesAsync=()=>{
      Promise.reject(new Error('host backend failure'));
      return Promise.resolve(Buffer.from('{}'));
    };
    setTimeout(()=>fsModule.readFile('file',()=>trace.push('read')),0);
    function complete(){return false;}
  `, { expectedError: /host backend failure/ });
});

test('discarded rejections from the host-driven guest ticker and onerror retain browser origin', () => {
  const trace = runGuest(`
    globalThis.pmjsReportUnhandledPromiseRejection=(reason,promise,origin)=>trace.push([reason.message,origin]);
    globalThis.onerror=()=>{Promise.reject(new Error('onerror'));return true;};
    setTimeout(()=>{throw new Error('timer error');},0);
    globalThis.SceneManager={ticker:{_pmjsHostDriven:true,update(){
      if(!this.rejected){this.rejected=true;Promise.reject(new Error('ticker'));}
    }}};
    function complete(){return trace.length===2;}
  `);
  assert.deepEqual(trace.sort(), [['onerror','browser'],['ticker','browser']]);
});
