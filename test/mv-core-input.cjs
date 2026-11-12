'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const binary = process.argv[2];
const names = ['ok','cancel','menu','escape','shift','control','tab','pageup','pagedown','left','right','up','down','debug','action','2','10','01'];
function compare(label, commands) {
  let now = 0, retryPending = false, retries = 0, prevented = 0;
  const pads = [];
  const context = vm.createContext({ Date: { now: () => now }, Utils: { isNwjs: () => false },
    document: { addEventListener() {} }, window: { addEventListener() {} }, navigator: { getGamepads: () => pads },
    ResourceHandler: { exists: () => retryPending, retry: () => retries++ } });
  vm.runInContext(fs.readFileSync(path.join(__dirname,'reference/mv161-input.js'),'utf8'), context);
  const input = context.Input; input.initialize();
  const expected = [], updates = [];
  for (const [index, command] of commands.entries()) {
    const [kind, ...args] = command.split(' ');
    if (kind === 'down') {
      retryPending = args[1] === '1';
      input._onKeyDown({keyCode:Number(args[0]),preventDefault(){prevented++;}});
    } else if (kind === 'up') input._onKeyUp({keyCode:Number(args[0])});
    else if (kind === 'clear') input._onLostFocus();
    else if (kind === 'repeat') { input.keyRepeatWait=Number(args[0]);input.keyRepeatInterval=Number(args[1]); }
    else if (kind === 'keymap' || kind === 'padmap') {
      const mapper=kind==='keymap'?input.keyMapper:input.gamepadMapper;
      if(args[1]==='-')delete mapper[args[0]];else mapper[args[0]]=args[1];
    } else if (kind === 'pad') {
      pads[Number(args[0])] = {index:Number(args[0]),connected:args[1]==='1',buttons:args[2]==='-'?[]:[...args[2]].map(value=>({pressed:value==='1'})),axes:[Number(args[3]),Number(args[4])]};
    } else if (kind === 'update') {
      now=Number(args[0]);input.update();updates.push(index);
      expected.push([input.dir4,input.dir8,input.date,retries,prevented,...names.map(name=>Number(input.isPressed(name)) | Number(input.isTriggered(name))<<1 | Number(input.isRepeated(name))<<2 | Number(input.isLongPressed(name))<<3)]);
    } else throw new Error('Unknown reference command '+command);
  }
  const result=spawnSync(binary,['--trace'],{input:commands.join('\n')+'\n',encoding:'utf8',maxBuffer:8*1024*1024});
  assert.equal(result.status,0,result.stderr);
  const actual=result.stdout.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
  assert.equal(actual.length,expected.length,label+' update count');
  for(let i=0;i<expected.length;i++)assert.deepEqual(actual[i],expected[i],label+' at '+commands.slice(Math.max(0,updates[i]-12),updates[i]+1).join('; '));
  console.log(label+': '+expected.length+' stock/native updates match');
}
let clock=1000;
const update=()=>`update ${clock+=17}`;
compare('repeat boundaries, aliases, focus clear and resource retry',[
  'down 90 0',...Array.from({length:65},update),'down 13 0','up 90',update(),
  'down 27 0',update(),'down 38 0',update(),'down 39 0',update(),'up 39',update(),
  'up 38','down 37 0',update(),'down 38 0',update(),'down 39 0','down 40 0',update(),
  'clear',update(),'down 32 1',update(),'down 32 0',update(),'down 144 0',update(),
  'down 98 0',update(),'up 0',update(),'down 8 0','down 34 0',update()
]);
compare('gamepad transitions, thresholds, aliases and disconnection',[
  'pad 0 1 00000000000000000 0 0',update(),'down 90 0',update(),
  'pad 0 1 10000000000000000 0.5 -0.5',update(),'up 90',update(),
  'pad 0 1 10000000000000000 0.5001 -0.5001',update(),
  'pad 1 1 00010000000000000 0 0',update(),
  'pad 0 1 00000000000000000 0 0',update(),
  'pad 1 0 00010000000000000 0 0',update(),update(),
  'clear',update(),'pad 1 1 - -1 1',update(),
  'padmap 0 action','pad 0 1 10000000000000000 0 0',update()
]);
compare('configurable mappings, enumeration and repeat intervals',[
  'keymap 65 10','keymap 66 2','keymap 67 01','down 65 0','down 66 0','down 67 0',update(),
  'clear','keymap 65 action','down 65 0','repeat 3 2',...Array.from({length:10},update),
  'repeat 0 0',update(),'repeat -1 -2',update(),update(),'keymap 65 -','up 65',update(),
  'keymap 65 ok','up 65',update()
]);
const random=[];let seed=38129;
function next(n){seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n;}
const keys=[9,13,16,17,18,27,32,33,34,37,38,39,40,45,81,87,88,90,96,98,100,102,104,120,144,0,65];
for(let i=0;i<2500;i++){
  const choice=next(12);
  if(choice<4)random.push(`down ${keys[next(keys.length)]} ${next(15)===0?1:0}`);
  else if(choice<7)random.push(`up ${keys[next(keys.length)]}`);
  else if(choice===7)random.push('clear');
  else if(choice===8)random.push(`pad ${next(2)} ${next(8)!==0?1:0} ${Array.from({length:17},()=>next(8)===0?'1':'0').join('')} ${[0,0.5,-0.5,0.7,-1][next(5)]} ${[0,0.5,-0.5,1,-0.8][next(5)]}`);
  random.push(update());
}
compare('deterministic mixed-device trace',random);
