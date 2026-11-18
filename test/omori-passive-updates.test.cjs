'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture() {
  const context = vm.createContext({
    PMJS: {
      optimizations: { register() {}, isEnabled: () => true },
      phases: {
        on(_phase, _owner, callback) {
          callback();
        }
      }
    }
  });
  vm.runInContext(
    `
    class Character {
      constructor(page) {
        this.data=page;this._stopCount=0;this._alertLock=0;this.calls=0;
        this._pattern=1;this._moveType=0;this._trigger=0;this._stepAnime=false;
      }
      page(){return this.data;}
      isMoving(){return false;}
      isJumping(){return false;}
      isOriginalPattern(){return this._pattern===1;}
      setStepAnime(value){this._stepAnime=value;}
      setPattern(value){this._pattern=value;}
      setMoveSpeed(value){this._moveSpeed=value;}
      lock(){this._locked=true;}
      unlock(){this._locked=false;}
      resetStopCount(){this._stopCount=0;}
      checkStop(threshold){return this._stopCount>threshold;}
      update(){this.calls++;this._stopCount++;if(!this._erased)this._alertLock--;}
    }
    var Game_CharacterBase=Character;
    class Game_Event extends Character {
      erase(){this._erased=true;this.data=null;this.setupPage();}
      setupPage(){this._trigger=this.data?this.data.trigger:0;this._stepAnime=!!(this.data&&this.data.stepAnime);}
    }
    class Game_Map {
      constructor(events){this._events=events;this._commonEvents=[{calls:0,update(){this.calls++;}}];}
      mapId(){return 1;}
      events(){return this._events.filter(Boolean);}
      setupEvents(){}
      updateEvents(){for(const event of this.events())event.update();for(const event of this._commonEvents)event.update();}
      isAnyEventStarting(){return this.events().some(event=>event._starting);}
    }
    class Scene_Map {start(){}}
    var originalStart=Scene_Map.prototype.start;
    var originalStarting=Game_Map.prototype.isAnyEventStarting;
    var originalEventProperties=Object.getOwnPropertyNames(Game_Event.prototype).sort().join(',');
    var DataManager={makeSaveContents(){return {events:$gameMap._events};}};
    var JsonEx={stringify:JSON.stringify};
    var empty={trigger:0,moveType:0,stepAnime:false,list:[{code:108},{code:0}]};
    var scripted={trigger:1,moveType:0,stepAnime:false,list:[{code:355},{code:0}]};
    var a=new Game_Event(empty),b=new Game_Event(null),c=new Game_Event(scripted);
    var $gameMap=new Game_Map([null,a,b,c]);
  `,
    context
  );
  for (const file of ['js/pmjs-mv/update-scheduler.js', 'patches/omori/update-scheduler.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context, {
      filename: file
    });
  }
  return context;
}
const run = (context, source) => vm.runInContext(source, context);

test('installation follows map construction and removes its start hook', () => {
  const context = fixture();
  assert.equal(run(context, 'PMJS.mv.eventUpdateSchedule'), undefined);
  run(
    context,
    'new Scene_Map().start();var installed=PMJS.mv.eventUpdateSchedule;new Scene_Map().start();'
  );
  assert.equal(run(context, 'Scene_Map.prototype.start===originalStart'), true);
  assert.equal(run(context, 'PMJS.mv.eventUpdateSchedule===installed'), true);
  assert.equal(run(context, 'Game_Map.prototype.isAnyEventStarting===originalStarting'), true);
  assert.equal(
    run(
      context,
      "Object.getOwnPropertyNames(Game_Event.prototype).sort().join(',')===originalEventProperties"
    ),
    true
  );
});

test('only passive pages sleep while common events and other pages keep updating', () => {
  const context = fixture();
  run(context, 'new Scene_Map().start();for(var i=0;i<40;i++)$gameMap.updateEvents();');
  assert.deepEqual(
    JSON.parse(
      run(context, 'JSON.stringify([a.calls,b.calls,c.calls,$gameMap._commonEvents[0].calls])')
    ),
    [1, 1, 40, 40]
  );
  run(context, 'var saved=DataManager.makeSaveContents();');
  assert.deepEqual(
    JSON.parse(
      run(context, 'JSON.stringify([a._stopCount,b._stopCount,c._stopCount,a._alertLock])')
    ),
    [40, 40, 40, -40]
  );
  assert.equal(run(context, 'Object.getOwnPropertySymbols(a).length'), 0);
  run(context, 'a.data=scripted;a.setupPage();for(var i=0;i<5;i++)$gameMap.updateEvents();');
  assert.equal(run(context, 'a.calls'), 6);
  run(context, 'a.data=empty;a.setupPage();for(var i=0;i<5;i++)$gameMap.updateEvents();');
  assert.equal(run(context, 'a.calls'), 7);
});

test('explicit page notifications wake sleepers without observing raw fields', () => {
  const context = fixture();
  run(
    context,
    'new Scene_Map().start();$gameMap.updateEvents();a.data=scripted;PMJS.mv.eventUpdateSchedule.notify(a);for(var i=0;i<4;i++)$gameMap.updateEvents();'
  );
  assert.equal(run(context, 'a.calls'), 5);
  assert.equal(
    run(context, "Object.hasOwn(Object.getOwnPropertyDescriptor(a,'_stopCount'),'value')"),
    true
  );
});

test('counter resets discard elapsed time before the reset without waking the model', () => {
  const context = fixture();
  run(
    context,
    `new Scene_Map().start();for(var i=0;i<20;i++)$gameMap.updateEvents();
    a.resetStopCount();for(var i=0;i<3;i++)$gameMap.updateEvents();
    PMJS.mv.eventUpdateSchedule.synchronize(a);`
  );
  assert.equal(run(context, 'a._stopCount'), 3);
  assert.equal(run(context, 'a._alertLock'), -23);
  assert.equal(run(context, 'a.calls'), 1);
});

test('an explicit notification during dispatch preserves a following turn', () => {
  const context = fixture();
  run(
    context,
    `new Scene_Map().start();$gameMap.updateEvents();
    a.update=function(){Character.prototype.update.call(this);delete this.update;PMJS.mv.eventUpdateSchedule.notify(this);};
    PMJS.mv.eventUpdateSchedule.notify(a);
    $gameMap.updateEvents();$gameMap.updateEvents();$gameMap.updateEvents();`
  );
  assert.equal(run(context, 'a.calls'), 3);
});

test('checkStop observes elapsed idle ticks without waking an event',()=>{
 const context=fixture();
 run(context,'new Scene_Map().start();for(var i=0;i<20;i++)$gameMap.updateEvents();');
 assert.equal(run(context,'a.checkStop(10)'),true);
 assert.equal(run(context,'a.calls'),1);
});
test('erasure preserves prior alert ticks and stops subsequent alert catch-up',()=>{
 const context=fixture();
 run(context,'new Scene_Map().start();for(var i=0;i<20;i++)$gameMap.updateEvents();a.erase();for(var i=0;i<10;i++)$gameMap.updateEvents();DataManager.makeSaveContents();');
 assert.equal(run(context,'a._alertLock'),-20);
 assert.equal(run(context,'a._stopCount'),30);
});

test('stationary action pages sleep, catch up counters and wake for interaction and page changes',()=>{
 const c=fixture();run(c,`var action={trigger:0,moveType:0,stepAnime:false,list:[{code:355},{code:0}]};
  a.data=action;a.setupPage();new Scene_Map().start();for(var i=0;i<30;i++)$gameMap.updateEvents();`);
 assert.equal(run(c,'a.calls'),1);run(c,'a.lock();for(var i=0;i<3;i++)$gameMap.updateEvents();');
 assert.equal(run(c,'a.calls'),4);run(c,'a.unlock();$gameMap.updateEvents();for(var i=0;i<5;i++)$gameMap.updateEvents();');
 assert.equal(run(c,'a.calls'),5);run(c,'PMJS.mv.eventUpdateSchedule.synchronize(a)');assert.equal(run(c,'a._stopCount'),39);
 run(c,'a.data=scripted;a.setupPage();for(var i=0;i<3;i++)$gameMap.updateEvents();');assert.equal(run(c,'a.calls'),8);
});
