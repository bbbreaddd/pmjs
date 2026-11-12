'use strict';

const assert = require('node:assert/strict');
const api = require(require('node:path').resolve(process.argv[2])).mvEngine;
const fixture = {
  system: { startMapId: 1, startX: 1, startY: 1, partyMembers: [1] },
  actors: [null, { characterName: 'Actor', characterIndex: 0 }],
  tilesets: [null, { flags: [0] }],
  maps: { 1: { width: 4, height: 4, data: Array(4 * 4 * 6).fill(0), tilesetId: 1, events: [] } },
};
const first = api.create(fixture), second = api.create(fixture);
api.newGame(first); api.newGame(second);
api.step(first, { direction: 6 });
assert.equal(api.snapshot(first).player.x, 2);
assert.equal(api.snapshot(second).player.x, 1);
const saved = api.save(second);
assert.equal(api.save(second).system._saveCount, saved.system._saveCount + 1);
api.step(second, { direction: 2 });
api.load(second, saved);
assert.equal(api.snapshot(second).player.y, 1);
assert.throws(() => api.load(second, { ...saved, map: { _mapId: 999 } }), /unknown map/);
assert.equal(api.snapshot(second).player.y, 1);
assert.equal(fixture.system.startX, 1);
api.dispose(first);
assert.throws(() => api.step(first, {}), /disposed/);
assert.throws(() => api.snapshot({}), /invalid engine session/);
assert.throws(() => api.snapshot(second.player), /invalid engine session/);
assert.equal(api.snapshot(second).player.x, 1);
const cyclic = {}; cyclic.self = cyclic;
assert.throws(() => api.create(cyclic), /nesting limit/);
assert.throws(() => api.create({ ...fixture, skills: [null, { damage: { type: 1, formula: 'a.atk b.def' } }] }), /damage formula/);
api.dispose(second);
const equipment = api.create({ ...fixture,
  actors: [null, { classId: 1, initialLevel: 1, equips: [0,1,1] }],
  classes: [null, { params: Array.from({ length: 8 }, () => [0,10]), traits: [{ code: 52, dataId: 1, value: 0 }] }],
  armors: [null, { etypeId: 3, atypeId: 1, params: [0,0,0,10,0,0,0,0], traits: [] }],
});
api.newGame(equipment);
assert.equal(api.snapshot(equipment).actors[1].parameters[3], 20, 'initial equipment in the wrong slot must be discarded');
api.dispose(equipment);
console.log('native MV binding ownership checks passed');
const resumed = api.create(fixture);
try {
  const state = structuredClone(saved);
  state.variables._data[1] = 'SUNNY';
  state.player._spriteOffsetX = -3; state.player._customFrameWidth = 16;
  state.map._interpreter = { _mapId: 1, _eventId: 0, _index: 0, _list: [
    {code:121,indent:0,parameters:[2,2,0]}, {code:0,indent:0,parameters:[]}], _branch:{0:true},
    _childInterpreter: { _mapId:1,_eventId:0,_index:0,_waitCount:2,_list:[
      {code:122,indent:0,parameters:[1,1,1,0,'!']},{code:0,indent:0,parameters:[]}],_branch:{} } };
  api.load(resumed,state);
  const roundtrip=api.save(resumed);
  assert.equal(roundtrip.variables._data[1],'SUNNY');
  assert.equal(roundtrip.player._spriteOffsetX,-3);
  assert.equal(roundtrip.player._customFrameWidth,16);
  assert.equal(roundtrip.map._interpreter._childInterpreter._waitCount,2);
  assert.equal(roundtrip.map._interpreter._branch[0],1);
  api.step(resumed,{});api.step(resumed,{});
  assert.equal(api.snapshot(resumed).switches[2],undefined,'parent must wait for child');
  api.step(resumed,{});
  assert.equal(api.snapshot(resumed).variables[1],'SUNNY!');
  assert.equal(api.snapshot(resumed).switches[2],true);
} finally { api.dispose(resumed); }
const parallelFixture=structuredClone(fixture);
parallelFixture.maps[1].events=[null,{id:1,x:2,y:2,pages:[{conditions:{},trigger:4,priorityType:1,image:{pattern:0,direction:2},moveSpeed:4,moveRoute:{list:[{code:0}],repeat:true},list:[{code:122,indent:0,parameters:[3,3,1,0,1]},{code:230,indent:0,parameters:[2]},{code:0,indent:0,parameters:[]}]}]}];
const parallel=api.create(parallelFixture);
try {
  api.newGame(parallel);
  for(let tick=0;tick<30;tick++)api.step(parallel,{});
  const savedParallel=api.save(parallel);
  assert.equal(savedParallel.map._events[1]._pattern,0,'stationary event retains its authored pattern');
  assert.ok(savedParallel.variables._data[3]>1,'parallel event repeats after completing its wait');
  api.load(parallel,savedParallel);
  assert.deepEqual(api.save(parallel).map._events[1]._interpreter,savedParallel.map._events[1]._interpreter);
} finally {api.dispose(parallel);}
const interactiveFixture=structuredClone(fixture);
interactiveFixture.system.optFollowers=false;
interactiveFixture.maps[1].events=[null,{id:1,x:2,y:1,pages:[{conditions:{},trigger:0,priorityType:1,image:{pattern:1,direction:2},moveRoute:{list:[{code:0}],repeat:true},list:[{code:9000,indent:0,parameters:['message',{lines:['One. Two.'],pauses:[4]}]},{code:0,indent:0,parameters:[]}]}]}];
const sourceSession=api.create(interactiveFixture);api.newGame(sourceSession);const interactiveSave=api.save(sourceSession);api.dispose(sourceSession);
interactiveSave.player._direction=6;
const interactiveData=structuredClone(interactiveFixture);
interactiveData.sceneContract={kind:'map',mapId:1,width:96,height:96,interactiveInput:true,menuNotice:['Menu unfinished.']};
interactiveData.tiledMaps={1:{width:4,height:4,tilewidth:32,tileheight:32,passage:Array(16).fill(0)}};
interactiveData.tiledMaps[1].passage[2*4+1]=15;
interactiveData.tiledMaps[1].passage[1*4+1]=2;
const playable=api.create(interactiveData);
try {
  api.load(playable,interactiveSave);
  api.step(playable,{direction:4});assert.equal(api.snapshot(playable).player.x,1,'directional mask blocks leaving its tile');
  api.step(playable,{direction:2});assert.equal(api.snapshot(playable).player.y,1,'full collision blocks the destination');
  api.step(playable,{direction:6});assert.equal(api.snapshot(playable).player.x,1,'normal event blocks movement');
  api.step(playable,{ok:true});api.step(playable,{});
  assert.equal(api.snapshot(playable).message.busy,true);
  for(let i=0;i<40;i++)api.step(playable,{});
  assert.equal(api.snapshot(playable).message.age,12,'inline pause waits for confirmation');
  api.step(playable,{ok:true});api.step(playable,{});
  assert.equal(api.snapshot(playable).message.pauseIndex,1);
  for(let i=0;i<30;i++)api.step(playable,{});
  api.step(playable,{ok:true});api.step(playable,{});api.step(playable,{});
  assert.equal(api.snapshot(playable).message.busy,false);
  api.step(playable,{cancel:true});assert.equal(api.snapshot(playable).message.busy,true,'unfinished menu displays a dismissible notice');
  for(let i=0;i<40;i++)api.step(playable,{});
  api.step(playable,{cancel:true});api.step(playable,{});
  assert.equal(api.snapshot(playable).message.busy,false);
  api.step(playable,{direction:8});assert.equal(api.snapshot(playable).player.y,0,'movement resumes after dismissing messages');
  assert.throws(()=>api.save(playable),/cannot export/);
} finally {api.dispose(playable);}
