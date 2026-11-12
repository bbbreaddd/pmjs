'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {spawnSync}=require('node:child_process');
let clock=1000;
function compare(label,commands){
  let now=0;
  const context=vm.createContext({Date:{now:()=>now},Utils:{isSupportPassiveEvent:()=>false},
    Graphics:{pageToCanvasX:x=>x,pageToCanvasY:y=>y,isInsideCanvas:(x,y)=>x>=0&&y>=0&&x<100&&y<80},
    document:{addEventListener(){}},window:{navigator:{},addEventListener(){}}});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'reference/mv161-touch-input.js'),'utf8'),context);
  const input=context.TouchInput;input.initialize();const expected=[],updates=[];
  for(const [index,line]of commands.entries()){
    const [kind,...raw]=line.split(' '),a=raw.map(Number),event={preventDefault(){}};
    if(kind==='down'){now=a[3];input._onMouseDown({...event,button:a[0],pageX:a[1],pageY:a[2]});}
    else if(kind==='move')input._onMouseMove({pageX:a[0],pageY:a[1]});
    else if(kind==='up')input._onMouseUp({button:a[0],pageX:a[1],pageY:a[2]});
    else if(kind==='wheel')input._onWheel({...event,deltaX:a[0],deltaY:a[1]});
    else if(kind==='start'){
      now=a[2];const changed=Array.from({length:a[1]},(_,i)=>({pageX:a[3+i*2],pageY:a[4+i*2]}));
      input._onTouchStart({...event,touches:Array(a[0]).fill({}),changedTouches:changed});
    }else if(kind==='touchmove')input._onTouchMove({changedTouches:[{pageX:a[0],pageY:a[1]}]});
    else if(kind==='end')input._onTouchEnd({changedTouches:[{pageX:a[0],pageY:a[1]}]});
    else if(kind==='cancel')input._onTouchCancel(event);
    else if(kind==='pointer')input._onPointerDown({...event,pointerType:a[0]?'touch':'mouse',isPrimary:!!a[1],pageX:a[2],pageY:a[3]});
    else if(kind==='repeat'){input.keyRepeatWait=a[0];input.keyRepeatInterval=a[1];}
    else if(kind==='clear')input.clear();
    else if(kind==='update'){
      input.update();updates.push(index);expected.push([Number(input.isPressed()),Number(input.isTriggered()),Number(input.isRepeated()),Number(input.isLongPressed()),Number(input.isCancelled()),Number(input.isMoved()),Number(input.isReleased()),input.x,input.y,input.wheelX,input.wheelY,input.date]);
    }else throw new Error(kind);
  }
  const result=spawnSync(process.argv[2],['--trace'],{input:commands.join('\n')+'\n',encoding:'utf8',maxBuffer:4*1024*1024});
  assert.equal(result.status,0,result.stderr);
  const actual=result.stdout.trim().split('\n').filter(Boolean).map(JSON.parse);
  assert.equal(actual.length,expected.length);
  for(let i=0;i<actual.length;i++)assert.deepEqual(actual[i],expected[i],label+' at '+commands.slice(Math.max(0,updates[i]-8),updates[i]+1).join('; '));
  console.log(label+': '+actual.length+' stock/native updates match');
}
compare('pointer timing, gesture boundaries and wheel accumulation',[
  'down 0 5 6 1000',...Array(35).fill('update'),'move -5 99','wheel 1 3','wheel 4 -1','update','up 0 100 200','update','update',
  'move 10 20','down 1 5 5 2000','down 2 5 5 2001','update','up 2 5 5','update',
  'down 0 100 80 3000','update','up 0 -1 -2','update','start 2 2 4000 4 5 6 7','update',
  'touchmove -20 50','end 5 6','update','start 1 1 5000 1 2','cancel','update',
  'pointer 1 0 30 40','update','pointer 1 1 31 41','update','clear','update',
  'down 0 3 4 6000','up 0 4 5','update','repeat 0 0','down 0 2 3 7000','update'
]);
const random=[];let seed=732;
const next=n=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n;};
for(let i=0;i<1200;i++){
  const x=next(130)-15,y=next(110)-15;
  switch(next(10)){
    case 0:random.push(`down ${next(3)} ${x} ${y} ${clock++}`);break;
    case 1:random.push(`up ${next(3)} ${x} ${y}`);break;
    case 2:random.push(`move ${x} ${y}`);break;
    case 3:random.push(`wheel ${next(9)-4} ${next(9)-4}`);break;
    case 4:random.push(`start ${next(3)+1} 1 ${clock++} ${x} ${y}`);break;
    case 5:random.push(`touchmove ${x} ${y}`);break;
    case 6:random.push(`end ${x} ${y}`);break;
    case 7:random.push('cancel');break;
    case 8:random.push(`pointer 1 ${next(2)} ${x} ${y}`);break;
    case 9:random.push('clear');break;
  }
  random.push('update');
}
compare('mixed pointer/touch trace',random);
