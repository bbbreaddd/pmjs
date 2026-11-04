'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../../../patches/isat/loop-recovery.js'), 'utf8');
function fixture(enabled = true, altered = false) {
 const hooks = {}, warnings = [];
 const context = vm.createContext({console: {warn: x => warnings.push(x)},
  PMJS: {isatSourceQualification: {verified:true}, optimizations: {register() {}, isEnabled: () => enabled, refuse: (...args) => warnings.push(args)},
   phases: {on(name,owner,fn) {hooks[name] = fn;}}}});
 vm.runInContext(`function Game_Actor(id) {this._actorId=id;this._classId=1;this._level=1;this._exp={1:0};this._hp=10;this._mp=4;this._states=[];this._skills=[];this.refreshes=0;this.recoveries=0;}
 var Olivia={AntiPlayerStress:{LevelFullHp:true,LevelFullMp:true}};
 Object.defineProperty(Game_Actor.prototype,'mhp',{get:function(){return this._level*10;}});
 Object.defineProperty(Game_Actor.prototype,'mmp',{get:function(){return this._level*4;}});
 Game_Actor.prototype.currentClass=function(){return {learnings:[{level:2,skillId:6},{level:3,skillId:7}]};};
 Game_Actor.prototype.learnSkill=function(id){this._skills.push(id);};
 Game_Actor.prototype.currentExp=function(){return this._exp[this._classId];};
 Game_Actor.prototype.skills=function(){return this._skills.slice();};
 Game_Actor.prototype.isMaxLevel=function(){return this._level>=45;};
 Game_Actor.prototype.nextLevelExp=function(){return this._level;};
 Game_Actor.prototype.currentLevelExp=function(){return this._level-1;};
 Game_Actor.prototype.levelDown=function(){this._level--;};
 Game_Actor.prototype.refresh=function(){this.refreshes++;if(this.fail)throw Error('refresh');};
 Game_Actor.prototype.changeExp=(function(exp, show) {
    this._exp[this._classId] = Math.max(exp, 0);
    var lastLevel = this._level;
    var lastSkills = this.skills();
    while (!this.isMaxLevel() && this.currentExp() >= this.nextLevelExp()) {
        this.levelUp();
    }
    while (this.currentExp() < this.currentLevelExp()) {
        this.levelDown();
    }
    if (show && this._level > lastLevel) {
        this.displayLevelUp(this.findNewSkills(lastSkills));
    }
    this.refresh();
});
 Olivia.AntiPlayerStress.___Game_Actor_levelUp___=(function() {
    this._level++;
    this.currentClass().learnings.forEach(function(learning) {
        if (learning.level === this._level) {
            this.learnSkill(learning.skillId);
        }
    }, this);
});
 Game_Actor.prototype.levelUp=(function() {
    Olivia.AntiPlayerStress.___Game_Actor_levelUp___.call(this);
    if (!this._bypassLevelUpRecover) {
        this.levelUpRecover();
    }
});
 Game_Actor.prototype.levelUpRecover=(function() {
    if (Olivia.AntiPlayerStress.LevelFullHp) {
        this._hp = this.mhp;
    }
    if (Olivia.AntiPlayerStress.LevelFullMp) {
        this._mp = this.mmp;
    }
    this.refresh();
});
 function Game_Interpreter() {this._list=event.list;}
 Game_Interpreter.prototype.command315=function(){return target.changeExp(requested,false);};
 var event={name:'LOOP_PartyLvlsnSkills',list:Array.from({length:245},function(){return {code:0,parameters:[]};})};
 [2,3,4].forEach(function(id,i){event.list[i]={code:315,parameters:[0,id,1,0,9999999,false]};event.list[11+i]={code:315,parameters:[0,id,0,0,id===3?112486:104287,false]};});
 var $dataCommonEvents={105:event}, variables={1:1,2:2};
 var $gameVariables={value:function(id){return variables[id];}},target=new Game_Actor(2),requested=44;
 var interpreter=new Game_Interpreter();`,context);
 context.__pmjsBuiltinRequire = require;
 require('../../helpers/runtime-context.cjs').runModule(context, 'js/pmjs-core/methods.js');
 const patched = source.replace(/methodMatches\(([^,]+), '([a-f0-9]+)'\)/g, (text, expression, digest) => {
   const method = vm.runInContext(expression.replace(/^actor\./, 'Game_Actor.prototype.').replace(/^stress\./, 'Olivia.AntiPlayerStress.'), context);
   return text.replace(digest, context.PMJS.methods.fingerprint(context.PMJS.methods.sourceOf(method)));
 });
 if(altered) vm.runInContext('Game_Actor.prototype.levelUp=function(){this._level++;};',context);
 vm.runInContext(patched,context);hooks.afterGuestPlugins();
 return {context,warnings,run: code => vm.runInContext(code,context)};
}
function state(f) {return JSON.parse(f.run('JSON.stringify({level:target._level,exp:target.currentExp(),hp:target._hp,mp:target._mp,skills:target._skills,states:target._states})'));}

test('first-loop recovery preserves levels, EXP, learned skills and final HP/MP',()=>{
 const control=fixture(false),candidate=fixture();control.run('interpreter.command315()');candidate.run('interpreter.command315()');
 assert.deepEqual(state(candidate),state(control));assert.equal(candidate.run('target.refreshes'),2);assert.equal(control.run('target.refreshes'),45);
 assert.equal(candidate.run('Object.hasOwn(target,"_bypassLevelUpRecover")'),false);
});
test('an identical saved command list retains recovery batching without changing execution state',()=>{
 const control=fixture(false),candidate=fixture();
 for(const f of [control,candidate]) f.run('interpreter._list=JSON.parse(JSON.stringify(event.list));interpreter.command315()');
 assert.deepEqual(state(candidate),state(control));
 assert.equal(candidate.run('target.refreshes'),2);
 assert.equal(control.run('target.refreshes'),45);
 assert.equal(candidate.run('Object.hasOwn(target,"_bypassLevelUpRecover")'),false);
});
test('changes to saved or authored commands revoke copied-list qualification',()=>{
 for(const mutation of ['interpreter._list[20].parameters=[99]', 'event.list[20].parameters=[99]']) {
  const f=fixture();
  f.run('interpreter._list=JSON.parse(JSON.stringify(event.list));interpreter.command315();target._level=1;target._exp[1]=0;target.refreshes=0;');
  f.run(mutation+';interpreter.command315()');
  assert.equal(f.run('target.refreshes'),45,mutation);
 }
});
test('ordinary EXP, other events, other loops and existing bypasses retain guest behavior',()=>{
 for(const setup of ['interpreter._list=[]','variables[1]=2','variables[2]=3','target._actorId=1','target._states=[4]','target._hp=0','target._bypassLevelUpRecover=true','target._level=2','event.list[0].parameters[4]=2']) {
  const c=fixture(false),f=fixture();c.run(setup);f.run(setup);c.run('interpreter.command315()');f.run('interpreter.command315()');assert.deepEqual(state(f),state(c));assert.equal(f.run('target.refreshes'),c.run('target.refreshes'),setup);
 }
 const f=fixture();f.run('target.changeExp(44,false)');assert.equal(f.run('target.refreshes'),45);
});
test('exceptions restore the bypass flag and command context',()=>{
 const f=fixture();assert.throws(()=>f.run('target.fail=true;interpreter.command315()'),/refresh/);
 assert.equal(f.run('Object.hasOwn(target,"_bypassLevelUpRecover")'),false);
 f.run('target.fail=false;target._level=1;target.refreshes=0;target.changeExp(44,false)');assert.equal(f.run('target.refreshes'),45);
});
test('modified level hooks refuse installation and later replacements bypass batching',()=>{
 const f=fixture(true,true);assert.equal(f.warnings.length,1);
 const g=fixture();g.run('var recover=target.levelUpRecover; target.levelUpRecover=function(){return recover.call(this);}; interpreter.command315()');assert.equal(g.run('target.refreshes'),45);
});
