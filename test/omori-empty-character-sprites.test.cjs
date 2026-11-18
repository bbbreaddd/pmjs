'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
function fixture(){
 const c=vm.createContext({WeakRef,PMJS:{optimizations:{register(){},isEnabled(){return true;}},phases:{on(_p,_n,fn){fn();}}}});
 vm.runInContext(`
 class Container{constructor(){this.children=[];this.y=0;}addChild(s){if(s.parent)s.parent.children.splice(s.parent.children.indexOf(s),1);this.children.push(s);s.parent=this;return s;}addChildAt(s){return this.addChild(s);}}
 class Tilemap extends Container{update(){var n=this.children.length;for(var i=0;i<n;i++){var child=this.children[i];if(child&&child.update)child.update();}}}
 var PIXI={Container},empty={},ImageManager={loadEmptyBitmap(){return empty;}};
 class Game_CharacterBase{constructor(){this.name='';this.tile=0;this.animation=0;this.balloon=0;}characterName(){return this.name;}tileId(){return this.tile;}animationId(){return this.animation;}balloonId(){return this.balloon;}setImage(n){this.name=n;}setTileImage(t){this.tile=t;}requestAnimation(id){this.animation=id;}requestBalloon(id){this.balloon=id;}setupInputIcon(){this._inputIcon={};}setupShadow(){this._shadow={};}setupEventcon(){this._eventIndex=1;}createHorrorEffect(){this._horrorFilters={noiseFilter:{}};}}
 class Sprite_Character extends Container{constructor(character){super();this._character=character;this.bitmap=empty;this._animationSprites=[];this._miniLabel={_text:''};this._horrorFiltersSource=character;this.calls=0;}update(){this.calls++;}setCharacter(c){this._character=c;}refreshMiniLabel(){this._miniLabel._text='label';}destroy(){this._destroyed=true;if(this.parent)this.parent.children.splice(this.parent.children.indexOf(this),1);this.parent=null;}}
 var character=new Game_CharacterBase(),map=new Tilemap(),sprite=new Sprite_Character(character);map.addChild(sprite);
 `,c);
 vm.runInContext(fs.readFileSync(require.resolve('../patches/omori/empty-character-sprites.js'),'utf8'),c);
 return {c,run(s){return vm.runInContext(s,c);}};
}
test('empty presentation parks after an ordinary update and image writes restore it',()=>{
 const f=fixture();f.run('sprite.update()');assert.equal(f.run('sprite.calls'),1);assert.equal(f.run('sprite.parent===map'),false);
 assert.equal(f.run('sprite.parent.visible'),false);assert.equal(f.run('typeof sprite.parent.update'),'undefined');
 f.run("character.setImage('hero')");assert.equal(f.run('sprite.parent===map'),true);f.run('sprite.update()');assert.equal(f.run('sprite.parent===map'),true);
 f.run("character.setImage('');sprite.update()");assert.equal(f.run('sprite.parent===map'),false);
});
test('effects, children, labels, external sources and nonempty graphics remain ordinary',()=>{
 for(const setup of ["character.name='hero'",'character.tile=1','character.animation=1','character.balloon=1',
  'sprite.addChild(new Container())',"sprite._miniLabel._text='label'",'sprite._miniLabel.parent=map',
  'sprite._labelDelay=2','character._inputIcon={}','character._shadow={}','character._eventIndex=1',
  'sprite._horrorFiltersSource={}','character._horrorFilters={noiseFilter:{}}','sprite.filters=[{}]',
  'sprite._animationSprites=[{}]','sprite._balloonSprite={}','sprite.bitmap={}',
  'sprite.update=function(){Sprite_Character.prototype.update.call(this);}']){
  const f=fixture();f.run(setup+';sprite.update()');assert.equal(f.run('sprite.parent===map'),true,setup);
 }
});
test('normal effect writers and direct child attachment wake parked presentations',()=>{
 for(const action of ['character.setTileImage(1)','character.requestAnimation(1)','character.requestBalloon(1)',
 'character.setupInputIcon()','character.setupShadow()','character.setupEventcon()','character.createHorrorEffect()',
 'sprite.addChild(new Container())','sprite.refreshMiniLabel()',"sprite.setCharacter(new Game_CharacterBase())"]){
  const f=fixture();f.run('sprite.update();'+action);assert.equal(f.run('sprite.parent===map'),true,action);
 }
});
test('multiple presentations wake together while destruction and transfers preserve ownership',()=>{
 const f=fixture();f.run('var other=new Sprite_Character(character);map.addChild(other);sprite.update();other.update();character.requestBalloon(1)');
 assert.equal(f.run('sprite.parent===map&&other.parent===map'),true);
 f.run('character.balloon=0;sprite.update();sprite.destroy();character.setImage("hero")');assert.equal(f.run('sprite.parent'),null);
 const g=fixture();g.run('sprite.update();var next=new Tilemap();next.addChild(sprite);character.setImage("hero")');
 assert.equal(g.run('sprite.parent===next'),true);
});

test('unlabeled sprites can sleep without constructing a mini-label window',()=>{
 const f=fixture();f.run('delete sprite._miniLabel;sprite.update()');assert.equal(f.run('sprite.parent===map'),false);
});

test('parking preserves sibling updates and rechecks writes later in the same traversal',()=>{
 const f=fixture();
 f.run("var visible=new Sprite_Character(new Game_CharacterBase());visible._character.name='hero';map.addChild(visible);map.update()");
 assert.equal(f.run('sprite.calls'),1);
 assert.equal(f.run('visible.calls'),1);
 assert.equal(f.run('sprite.parent===map'),false);
 f.run('map.update()');assert.equal(f.run('visible.calls'),2);
 const g=fixture();
 g.run("var writer=new Container();writer.update=function(){character.requestAnimation(1);};map.addChild(writer);map.update()");
 assert.equal(g.run('sprite.parent===map'),true);
});
test('parking does not reclaim sprites transferred or destroyed later in traversal',()=>{
 for(const action of ['next.addChild(sprite)','sprite.destroy()']){
  const f=fixture();f.run('var next=new Tilemap(),writer=new Container();writer.update=function(){'+action+';};map.addChild(writer);map.update()');
  assert.equal(f.run('sprite.parent===map'),false);
  assert.equal(f.run('PMJS.omoriEmptyCharacterSprites.diagnostics().parked'),0);
 }
});

test('parking holders preserve MV depth, position and sprite ID ordering after insertion and wake',()=>{
 for(const [front,back] of [
  [{z:3,y:20,spriteId:1},{z:1,y:10,spriteId:2}],
  [{z:0,y:20,spriteId:1},{z:0,y:10,spriteId:2}],
  [{z:0,y:0,spriteId:3},{z:0,y:0,spriteId:1}]
 ]){
  const f=fixture();f.c.frontKeys=front;f.c.backKeys=back;
  f.run(`var front=new Sprite_Character(new Game_CharacterBase());
   front._character.name='front';Object.assign(front,frontKeys);map.addChild(front);map.update();
   var back=new Sprite_Character(new Game_CharacterBase());
   back._character.name='back';Object.assign(back,backKeys);map.addChild(back);
   function compare(a,b){if(a.z!==b.z)return a.z-b.z;if(a.y!==b.y)return a.y-b.y;return a.spriteId-b.spriteId;}
   map.children.sort(compare);`);
  assert.equal(f.run("map.children.filter(s=>s._character).map(s=>s._character.name).join(',')"),'back,front');
  f.run("Object.assign(sprite,{z:-1,y:0,spriteId:0});character.setImage('woken');map.children.sort(compare)");
  assert.equal(f.run("map.children.filter(s=>s._character).map(s=>s._character.name).join(',')"),'woken,back,front');
 }
});

test('prototype update overrides prevent parking and restore already parked sprites',()=>{
 for(const initiallyParked of [false,true]){
  const f=fixture();
  if(initiallyParked)f.run('map.update()');
  f.run('var extraCalls=0,previous=Sprite_Character.prototype.update;Sprite_Character.prototype.update=function(){previous.call(this);extraCalls++;};map.update();map.update();');
  assert.equal(f.run('extraCalls'),2);
  assert.equal(f.run('sprite.parent===map'),true);
 }
});
