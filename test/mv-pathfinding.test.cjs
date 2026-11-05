'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');
const source = fs.readFileSync(require.resolve('../js/pmjs-mv/pathfinding.js'), 'utf8');
function fixture() {
  let ordinary = 0, enabled = true;
  function Character(x,y) { this.x=x;this.y=y; }
  const original=function(){ordinary++;return 7;};
  Character.prototype.findDirectionTo=original;
  Character.prototype.searchLimit=function(){return 15;};
  Character.prototype.deltaXFrom=function(x){return realm.$gameMap.deltaX(this.x,x);};
  Character.prototype.deltaYFrom=function(y){return realm.$gameMap.deltaY(this.y,y);};
  const map={blocked:new Set(),loop:false,w:7,h:7,width(){return this.w;},height(){return this.h;},
    roundXWithDirection(x,d){x+=d===6?1:d===4?-1:0;return this.loop?(x+this.w)%this.w:x;},
    roundYWithDirection(y,d){y+=d===2?1:d===8?-1:0;return this.loop?(y+this.h)%this.h:y;},
    deltaX(x,y){let d=x-y;if(this.loop && Math.abs(d)>this.w/2)d+=d<0?this.w:-this.w;return d;},
    deltaY(x,y){let d=x-y;if(this.loop && Math.abs(d)>this.h/2)d+=d<0?this.h:-this.h;return d;},
    distance(x,y,gx,gy){return Math.abs(this.deltaX(x,gx))+Math.abs(this.deltaY(y,gy));}};
  Character.prototype.canPass=function(x,y,d){return this.passable(x,y,d);};
  Character.prototype.passable=function(x,y,d){const m=realm.$gameMap,nx=m.roundXWithDirection(x,d),ny=m.roundYWithDirection(y,d);
    return nx>=0 && ny>=0 && nx<m.w && ny<m.h && !m.blocked.has(nx+','+ny);};
  map.isValid=function(x,y){return x>=0 && y>=0 && x<this.w && y<this.h;};
  map.isLoopHorizontal=function(){return this.loop;};map.isLoopVertical=function(){return this.loop;};
  map.roundX=function(x){return this.loop?(x+this.w)%this.w:x;};
  map.roundY=function(y){return this.loop?(y+this.h)%this.h:y;};
  function GameMap(){};GameMap.prototype=map;
  const realm={Game_CharacterBase:Character,Game_Map:GameMap,Game_Character:Character,$gameMap:map,PMJS:{optimizations:{register(){},isEnabled:()=>enabled,refuse(){enabled=false;}},
    methods:{matchesSource:fn=>fn===original || Object.values(map).includes(fn) || fn===Character.prototype.canPass || typeof fn==='function' && fn.name==='fixtureModulo',own(def){Character.prototype.findDirectionTo=def.replace(Character.prototype.findDirectionTo);}}}};
  vm.runInNewContext('Number.prototype.mod = function fixtureModulo(n) { return ((this % n) + n) % n; };\n'+source,realm);
  return {realm,map,character:new Character(1,1),ordinary:()=>ordinary,disable(){enabled=false;}};
}
test('orthogonal routing, occupied goals and changed blockers keep first-step choices',()=>{
  const h=fixture(),c=h.character;
  assert.equal(c.findDirectionTo(4,1),6);
  h.map.blocked.add('2,1');h.map.blocked.add('1,2');
  assert.equal(c.findDirectionTo(4,1),8);
  h.map.blocked.delete('2,1');h.map.blocked.add('4,1');
  assert.equal(c.findDirectionTo(4,1),6);
  assert.equal(c.findDirectionTo(1,1),0);assert.equal(h.ordinary(),0);
});
test('looping geometry and replacement maps use current geometry',()=>{
  const h=fixture(),c=h.character;h.map.loop=true;
  assert.equal(c.findDirectionTo(6,1),4);
  h.realm.$gameMap=Object.assign({},h.map,{loop:false,w:10,blocked:new Set()});
  assert.equal(c.findDirectionTo(6,1),6);
});
test('nested and disabled calls use the original; exceptions release the workspace',()=>{
  const h=fixture(),c=h.character,pass=c.passable;let nested=false;
  c.passable=function(x,y,d){if(!nested){nested=true;assert.equal(c.findDirectionTo(4,1),7);}return pass.call(this,x,y,d);};
  assert.equal(c.findDirectionTo(4,1),6);assert.equal(h.ordinary(),1);
  c.passable=()=>{throw new Error('blocked query');};assert.throws(()=>c.findDirectionTo(4,1),/blocked query/);
  c.passable=pass;assert.equal(c.findDirectionTo(4,1),6);
  h.disable();assert.equal(c.findDirectionTo(4,1),7);assert.equal(h.ordinary(),2);
});
test('a proved pure search stops at the distance bound while an unproved search completes',()=>{
  const h=fixture(),c=h.character;
  c.searchLimit=()=>3;
  let proofs=0;
  h.realm.PMJS.mv.pathfinding.isPureSearch=()=>{proofs++;return true;};
  assert.equal(c.findDirectionTo(6,6),2);
  const first=h.realm.PMJS.mv.pathfinding.diagnostics();
  assert.equal(first.finalized,1);assert.equal(proofs,1);
  h.realm.PMJS.mv.pathfinding.isPureSearch=()=>false;
  assert.equal(c.findDirectionTo(6,6),2);
  const second=h.realm.PMJS.mv.pathfinding.diagnostics();
  assert.equal(second.finalized,1);assert.ok(second.expanded-first.expanded>first.expanded);
});
