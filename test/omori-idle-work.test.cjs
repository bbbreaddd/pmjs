'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
function fixture(module, setup) {
  const c = vm.createContext({ PMJS:{ phases:{on(_phase,_id,fn){fn();}},
    optimizations:{register(){},isEnabled(){return true;}},methods:{matchesSource(){return true;}} } });
  vm.runInContext(setup,c);
  vm.runInContext(fs.readFileSync(require.resolve('../patches/omori/'+module+'.js'),'utf8'),c);
  return source => vm.runInContext(source,c);
}
test('mirror integer writes notify for changes and preserve other variable assignments',()=>{
  const run=fixture('mirror-variable',`function Game_Variables(){this._data=[];this.calls=0;}
    Game_Variables.prototype.setValue=function(id,value){this.calls++;this._data[id]=value;};
    var v=new Game_Variables();`);
  run('v.setValue(17,0);v.setValue(17,0)');assert.equal(run('v.calls'),1);
  run('v.setValue(17,1);v.setValue(17,0);v.setValue(18,0);v.setValue(18,0)');assert.equal(run('v.calls'),5);
  run('v.setValue(17,0.5);v.setValue(17,0.5);v.setValue(17,"0")');assert.equal(run('v.calls'),8);
  run('v.setValue(17,1e20);v.setValue(17,1e20)');assert.equal(run('v.calls'),10);
});
test('empty pictures skip only after cleanup; showing, children and effects keep updates',()=>{
  const setup=`var picture=null;
    function Sprite_Picture(){this.visible=true;this.bitmap={};this._pictureName='old';this.children=[];this._horrorFilters={};this.calls=0;}
    Sprite_Picture.prototype.picture=function(){return picture;};
    Sprite_Picture.prototype.update=function(){this.calls++;if(!picture){this.bitmap=null;this.visible=false;this._pictureName='';}else{this.visible=true;this.bitmap={};this._pictureName=picture.name;}};
    var s=new Sprite_Picture();`;
  const run=fixture('empty-picture-sprites',setup);
  run('s.update();s.update()');assert.equal(run('s.calls'),1);
  run("picture={name:'shown'};s.update()");assert.equal(run('s.visible'),true);assert.equal(run('s.calls'),2);
  run('picture=null;s.update();s.update()');assert.equal(run('s.calls'),3);
  for(const action of ['s.children=[{}]','s._horrorFiltersSource={}','s._horrorFilters={noiseFilter:{}}','s.filters=[{}]']){
    const r=fixture('empty-picture-sprites',setup);r('s.update();'+action+';s.update()');assert.equal(r('s.calls'),2,action);
  }
});

test('unused follower lookup wakes immediately when party membership grows',()=>{
  const run=fixture('follower-actor',`var $gameParty={_actors:[1,2],allMembers:function(){return this._actors;},battleMembers:function(){return this.allMembers();}};
    function Game_Party(){};Game_Party.prototype.battleMembers=$gameParty.battleMembers;Game_Party.prototype.allMembers=$gameParty.allMembers;
    function Game_Follower(){};Game_Follower.prototype.actor=function(){return $gameParty.battleMembers()[this._memberIndex];};
    var follower=new Game_Follower();follower._memberIndex=2;`);
  assert.equal(run('follower.actor()'),undefined);
  run('$gameParty._actors.push(3)');assert.equal(run('follower.actor()'),3);
  run('$gameParty._actors.splice(0,1)');assert.equal(run('follower.actor()'),undefined);
});
