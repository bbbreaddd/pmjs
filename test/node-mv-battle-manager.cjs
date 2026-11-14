'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const api = require(path.resolve(process.argv[2])).mvEngine;
const { createScriptRuntime } = require('../runner/mv-script-runtime.cjs');
const { fixture } = require('./helpers/mv-session-fixture.cjs');

test('native battles dispatch manager stages with live actions, state and orders', t => {
  const data=fixture([]);
  data.enemies=[null,{id:1,name:'Target',params:[100,0,1,1,1,1,1,1],traits:[],actions:[],dropItems:[],exp:0,gold:3}];
  data.troops=[null,{id:1,members:[{enemyId:1,x:0,y:0}],pages:[]}];
  data.skills[2]={id:2,stypeId:1,hitType:1,successRate:100,scope:1,occasion:0,mpCost:2,tpCost:0,speed:0,repeats:1,damage:{type:1,formula:'7',variance:0,critical:false,elementId:0},effects:[]};
  const session=api.create(data); t.after(()=>api.dispose(session));
  const runtime=createScriptRuntime(api,session), scope=runtime.scope, manager=scope.BattleManager;
  for(const [name,key] of Object.entries({Actors:'actors',Classes:'classes',Skills:'skills',Items:'items',Weapons:'weapons',Armors:'armors',Enemies:'enemies',Troops:'troops',States:'states',System:'system'}))scope['$data'+name]=data[key];
  api.newGame(session); api.setRandomStream(session,Array(2000).fill(0.5));
  const trace=[];
  for(const name of ['setup','startInput','startTurn','makeActionOrders','endAction','processVictory','makeRewards','gainRewards','endBattle']) {
    const original=manager[name]; manager[name]=function(...args){trace.push(name);return original.apply(this,args);};
  }
  const makeRewards=manager.makeRewards;
  manager.makeRewards=function(){makeRewards.call(this);this._rewards.gold*=3;this._rewards.items.push(scope.$dataItems[1]);};
  const originalStart=manager.startAction;
  let action;
  manager.startAction=function(){
    action=this._action; assert.equal(action.subject(),scope.$gameActors.actor(1));
    action.setSkill(2); originalStart.call(this);
    assert.equal(this._phase,'action'); assert.equal(this._action,action);
    assert.equal(this._targets[0],scope.$gameTroop.members()[0]);
  };
  scope.Game_Action.prototype.itemHit=function(){assert.equal(this,manager._action);return 1;};
  scope.Game_Action.prototype.itemEva=()=>0;
  api.startBattle(session,1,true,true); api.acknowledge(session);
  for(let frame=0;frame<150 && !manager.isInputting();++frame){api.acknowledge(session);api.step(session,{});}
  assert.equal(manager._phase,'input'); manager._escapeRatio=0.9; assert.equal(manager._escapeRatio,0.9);
  api.chooseAction(session,0,2,0,false);
  for(let frame=0;frame<300 && !trace.includes('endAction');++frame){api.acknowledge(session);api.step(session,{});}
  assert.ok(trace.includes('makeActionOrders')); assert.ok(trace.includes('endAction'));
  assert.equal(api.snapshot(session).battle.enemies[0].hp,93);
  assert.equal(api.snapshot(session).actors[1].mp,8);
  const savedId=action._itemId; assert.equal(savedId,2);
  scope.$gameTroop.members()[0].gainHp(-100);
  for(let frame=0;frame<150 && !trace.includes('endBattle');++frame){api.acknowledge(session);api.step(session,{});}
  assert.equal(trace.filter(name=>name==='processVictory').length,1);
  assert.equal(trace.filter(name=>name==='endBattle').length,1);
  assert.equal(manager._phase,'battleEnd');
  assert.equal(scope.$gameParty.gold(),9); assert.equal(scope.$gameParty.numItems(scope.$dataItems[1]),1);
  const retained=action, subject=retained.subject();
  api.newGame(session); api.startBattle(session,1,true,true); api.acknowledge(session);
  for(let frame=0;frame<150 && !manager.isInputting();++frame){api.acknowledge(session);api.step(session,{});}
  api.chooseAction(session,0,2,0,false);
  for(let frame=0;frame<150 && action===retained;++frame){api.acknowledge(session);api.step(session,{});}
  assert.notEqual(action,retained); assert.equal(retained.subject(),subject);
  retained.setSkill(1); assert.equal(action._itemId,2, 'retained actions do not attach to a later battle');
});
