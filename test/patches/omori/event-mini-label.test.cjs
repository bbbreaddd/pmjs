'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
const { pinSourceFingerprint } = require('../../helpers/reviewed-function-fixture.cjs');
const root = path.resolve(__dirname, '../../..');
function delayedSetup() {
  globalThis.calls.original++;
  if (this.parent && this._labelDelay === undefined) this._labelDelay = this.parent.getChildIndex(this);
  if (this._labelDelay > 0) {
    var previous = this._labelDelay; this._labelDelay -= 1; return previous;
  }
  if (!this._miniLabel) { globalThis.calls.constructed++; this._miniLabel = { _text:'created' }; }
  return 'guest-result';
}
function fixture({ qualified = true, enabled = true, predecessorChanged = false, labelChanged = false } = {}) {
  let loading;
  const installs = new Map(), refused = [], calls = { original:0,constructed:0,indexReads:0,listReads:0 };
  function Sprite_Character() { this.initMembers(); }
  Sprite_Character.prototype.initMembers = function initialMembers() { this._character = null; };
  function Window_EventMiniLabel() {}
  for (const name of ['setCharacter','gatherDisplayData','extractNotedata','setText','forceRefresh'])
    Window_EventMiniLabel.prototype[name] = function labelMethod() {};
  const context = vm.createContext({ __pmjsBuiltinRequire:require,Sprite_Character,Window_EventMiniLabel,calls,
    PMJS:{ plugins:{ onLoading(name, id, callback) { loading=callback; },installOptimization(name, definition) { installs.set(name, definition.install); } },
      optimizations:{ isEnabled:()=>enabled,refuse(id, reason) { refused.push({id,reason}); },reportFallback() {} } } });
  vm.runInContext(fs.readFileSync(path.join(root,'js/pmjs-core/methods.js'),'utf8'),context);
  vm.runInContext('Sprite_Character.prototype.setupMiniLabel = ('+delayedSetup.toString()+');',context);
  const original=Sprite_Character.prototype.setupMiniLabel;
  vm.runInContext(fs.readFileSync(path.join(root,'js/pmjs-plugins/yanfly/event-mini-label.js'),'utf8'),context);
  let adapter=fs.readFileSync(path.join(root,'patches/omori/event-mini-label.js'),'utf8');
  const predecessor=function bareSetup() {};
  if (qualified) {
    adapter=pinSourceFingerprint(adapter,'KNOWN_SETUP',original);
    adapter=pinSourceFingerprint(adapter,'KNOWN_INNER',predecessor);
    const fingerprints=Object.fromEntries(Object.entries(Window_EventMiniLabel.prototype).map(([name,method])=>
      [name,createHash('sha256').update(method.toString()).digest('hex')]));
    adapter=adapter.replace(/var KNOWN_LABEL = \{[\s\S]*?\n  \};/, 'var KNOWN_LABEL = '+JSON.stringify(fingerprints)+';');
  }
  vm.runInContext(adapter,context);
  Sprite_Character.prototype.setupMiniLabel=predecessorChanged ? function changed() {} : predecessor;
  loading();Sprite_Character.prototype.setupMiniLabel=original;
  if (labelChanged) Window_EventMiniLabel.prototype.setText=function changedText() {};
  installs.get('GTP_OmoriFixes')();
  const pages=[{list:[]}];
  const model={_eventId:1,_pageIndex:0,event:()=>({pages}),page(){return pages[this._pageIndex];},
    list(){calls.listReads++;return this.page().list;}};
  const sprite=new Sprite_Character();sprite._character=model;
  sprite.parent={getChildIndex(){calls.indexReads++;return 3;}};
  return {sprite,model,pages,calls,refused,original,context};
}
test('events without labels on any page bypass delayed setup entirely',()=>{
  const f=fixture();
  for(let i=0;i<100;i++)f.sprite.setupMiniLabel();
  assert.equal(f.sprite._labelDelay,undefined);assert.equal(f.sprite._miniLabel,undefined);
  assert.equal(f.calls.original,0);assert.equal(f.calls.indexReads,0);assert.equal(f.calls.listReads,0);
});
test('text labels construct on the same tick and through the original method',()=>{
  const f=fixture();f.pages[0].list=[{code:108,parameters:['<Mini Label: Shop>']}];
  for(let i=0;i<3;i++)f.sprite.setupMiniLabel();assert.equal(f.calls.constructed,0);
  assert.equal(f.sprite.setupMiniLabel(),'guest-result');assert.equal(f.calls.constructed,1);
  assert.equal(f.sprite.setupMiniLabel(),'guest-result');assert.equal(f.calls.constructed,1);
});
test('initially empty detached labels do not begin displaying on a later page',()=>{
  const f=fixture();f.pages.push({list:[{code:108,parameters:['<Mini Label: Shop>']}]});
  for(let i=0;i<4;i++)f.sprite.setupMiniLabel();
  assert.equal(f.calls.constructed,0);
  f.model._pageIndex=1;f.sprite.setupMiniLabel();
  assert.equal(f.calls.constructed,0);assert.equal(f.calls.listReads,1);
  f.sprite._character={...f.model};
  f.sprite.setupMiniLabel();
  assert.equal(f.calls.constructed,0);
});
test('setup without a parent and unsupported or disabled compositions preserve guest calls',()=>{
  const f=fixture();f.sprite.parent=null;f.pages[0].list=[{code:108,parameters:['<Mini Label: Shop>']}];
  assert.equal(f.sprite.setupMiniLabel(),'guest-result');assert.equal(f.calls.constructed,1);
  for(const options of [{qualified:false},{enabled:false},{predecessorChanged:true},{labelChanged:true}]) {
    const other=fixture(options);assert.equal(other.sprite.setupMiniLabel,other.original);
  }
});

test('non-event characters skip their permanently empty windows',()=>{
  const f=fixture();f.sprite._character={};
  for(let i=0;i<10;i++)f.sprite.setupMiniLabel();
  assert.equal(f.calls.constructed,0);
  assert.equal(f.calls.indexReads,0);
});

test('a potentially labeled later page keeps the original delay and can become active before it expires',()=>{
 const f=fixture();f.pages.push({list:[{code:108,parameters:['<Mini Label: Shop>']}]});
 assert.equal(f.sprite.setupMiniLabel(),3);f.model._pageIndex=1;
 assert.equal(f.sprite.setupMiniLabel(),2);assert.equal(f.sprite.setupMiniLabel(),1);
 assert.equal(f.calls.constructed,0);assert.equal(f.sprite.setupMiniLabel(),'guest-result');
 assert.equal(f.calls.constructed,1);
});

test('reusing an unlabeled sprite before construction reclassifies the new character',()=>{
 const f=fixture();f.sprite.setupMiniLabel();
 const list=[{code:108,parameters:['<Mini Label: Shop>']}];
 const pages=[{list}];
 f.sprite._character={_eventId:2,_pageIndex:0,event:()=>({pages}),page:()=>pages[0],list:()=>list};
 for(let i=0;i<4;i++)f.sprite.setupMiniLabel();
 assert.equal(f.calls.constructed,1);
});
