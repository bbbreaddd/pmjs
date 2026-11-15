'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const native = require(path.resolve(process.argv[2]));
const { createScriptRuntime } = require('../runner/mv-script-runtime.cjs');
const { fixture } = require('./helpers/mv-session-fixture.cjs');
const { temporaryDirectory } = require('./helpers/temp.cjs');
const { png } = require('./helpers/png.cjs');

test('native character presentation preserves plugin composition and visual state', async t => {
  const root = temporaryDirectory('character-presentation');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'img/system'), { recursive: true });
  fs.copyFileSync(path.join(process.argv[3], 'testfont.ttf'), path.join(root, 'font.ttf'));
  fs.writeFileSync(path.join(root, 'img/system/Window.png'), png(192,192,new Uint8Array(192*192*4)));
  native.initialize({ gameRoot: root, width: 64, height: 64, windowTitle: 'Character presentation contract' });
  t.after(() => native.runtime.quit());
  const engine = native.mvEngine;

  function setup(t) {
    const database = fixture([]), session = engine.create(database);
    engine.databaseInvoke(session, 'publish', database);
    engine.attach(session, { width: 64, height: 64, fontFile: 'font.ttf' });
    t.after(() => engine.dispose(session));
    const runtime = createScriptRuntime(engine, session, { native });runtime.installScenes();engine.newGame(session);engine.playerTransfer(session,'perform');
    const s = runtime.scope, prototype = s.Sprite_Character.prototype;
    const defaults = Object.entries(Object.getOwnPropertyDescriptors(prototype))
      .filter(([name,d]) => name !== 'constructor' && typeof d.value === 'function')
      .map(([method,d]) => ({ method, function:d.value, bindingType:'Sprite_Character' }));
    const definitions = [];
    function operation(owner, method, name, base) {
      const original = function() { throw new Error('Translated JavaScript executed: ' + name); };
      owner[method] = original;
      const definition = { method, operation:name, function:original, base };
      definition.native = function(...args) { return engine.characterPresentationInvoke(session,this,original,method,name==='frames.width'||name.startsWith('map.')?args:[]); };
      definitions.push(definition);owner[method]=definition.native;
      return definition.native;
    }
    const parent = new s.Sprite(), environment = { scene:{ _spriteset:parent, _encounterEffectDuration:0 },
      player:s.$gamePlayer, system:s.$gameSystem, constructors:s,
      labelParameters:{ EMWBufferX:0, EMWBufferY:0, EMWBatTran:false },
      iconParameters:{ EventconWidth:24, EventconHeight:24, EventconSpeed:2, EventconWaitTime:3 } };
    const initializeCharacter = character => Object.assign(character, { _customFrameX:null, _customFrameY:null,
      _customFrameWidth:null, _customFrameHeight:null, _singleFrame:false, _isEmfCharacter:false,
      _eventIndex:0, _eventImg:null, _eventconPlaying:false });
    initializeCharacter(s.$gamePlayer);
    operation(s.Game_CharacterBase.prototype,'isSingleFrame','character.singleFrame');
    operation(s.Game_CharacterBase.prototype,'isEmfCharacter','character.emf');
    operation(s.Game_CharacterBase.prototype,'emfCharacterState','character.emfState');
    for (const [method,name] of Object.entries({ eventconId:'eventId',eventconImg:'eventImage',startEventcon:'eventStart',
      endEventcon:'eventEnd',isEventconPlaying:'eventPlaying' })) operation(s.Game_CharacterBase.prototype,method,'character.'+name);
    function characterSprite(character=s.$gamePlayer) {
      const sprite = new s.Sprite_Character(character);
      sprite._tilesetId=1;sprite.bitmap=new s.Bitmap(144,96);parent.addChild(sprite);return sprite;
    }
    function install() { engine.registerCharacterPresentation(session,environment,runtime.displaySymbol(),defaults,definitions); }
    return { database,session,runtime,s,prototype,defaults,definitions,operation,environment,parent,install,characterSprite,initializeCharacter };
  }

  await t.test('native wrappers preserve alias order and recheck late instance and parent overrides', t => {
    const f=setup(t), calls=[];
    const base=f.prototype.update;
    f.prototype.updateMiniLabel=()=>calls.push('label');f.prototype.updateMiniLabelZoom=()=>calls.push('zoom');
    f.prototype.updateEventcon=()=>calls.push('icon');f.prototype.updateBobble=()=>calls.push('bobble');
    f.prototype.updateInputIcon=()=>calls.push('input');f.prototype.updateShadow=()=>calls.push('shadow');
    const label=f.operation(f.prototype,'update','label.chain',{function:base});
    const aliases={ update:label };
    const icons=f.operation(f.prototype,'update','icons.chain',{owner:aliases,property:'update'});
    f.operation(f.prototype,'update','omori.chain',{function:icons});
    f.install();const sprite=f.characterSprite();sprite.update(sprite);
    assert.deepEqual(calls,['label','zoom','icon','bobble','input','shadow']);
    assert.equal(engine.characterPresentationStats(f.session).nativeFrames,1);
    calls.length=0;aliases.update=function(){calls.push('replacement');};
    sprite.update();assert.deepEqual(calls,['replacement','icon','bobble','input','shadow']);
    calls.length=0;sprite.updateBobble=()=>calls.push('instance');
    sprite.update();assert.deepEqual(calls,['replacement','icon','instance','input','shadow']);
    calls.length=0;const saved=sprite.update;
    sprite.update=function(){saved.call(this);calls.push('outer');};
    sprite.update();assert.deepEqual(calls,['replacement','icon','instance','input','shadow','outer']);
    const failure=new Error('authored override failure');sprite.updateShadow=()=>{throw failure;};
    assert.throws(()=>sprite.update(),error=>error===failure);
    sprite.updateShadow=()=>calls.push('recovered');sprite.update();assert.equal(calls.at(-2),'recovered');
    sprite.updateShadow=new Proxy(()=>calls.push('proxy'),{get(){throw new Error('Do not inspect an authored callable');}});
    sprite.update();assert.equal(calls.at(-2),'proxy');
  });

  await t.test('frame geometry follows custom rectangles, extended sheets and single-frame changes', t => {
    const f=setup(t);
    const width=f.operation(f.prototype,'patternWidth','frames.width',{function:f.prototype.patternWidth});
    for(const [method,name] of Object.entries({characterBlockX:'blockX',characterBlockY:'blockY',characterPatternX:'patternX',
      characterPatternY:'patternY',patternWidth:'width',patternHeight:'height'}))
      f.operation(f.prototype,method,'frame.'+name,{function:method==='patternWidth'?width:f.prototype[method]});
    f.operation(f.prototype,'updateCharacterFrame','omori.frame',{function:f.prototype.updateCharacterFrame});
    f.install();const sprite=f.characterSprite(), player=f.s.$gamePlayer;
    sprite.updateCharacterFrame();assert.deepEqual({...sprite._frame},{x:12,y:0,width:12,height:12});
    Object.assign(player,{_customFrameX:2,_customFrameY:1,_customFrameWidth:20,_customFrameHeight:16});
    sprite.updateCharacterFrame();assert.deepEqual({...sprite._frame},{x:40,y:16,width:20,height:16});
    player._singleFrame=true;sprite.updateCharacterFrame();assert.deepEqual({...sprite._frame},{x:0,y:0,width:144,height:96});
    player._singleFrame=false;player._customFrameWidth=null;player._isEmfCharacter=true;player._emfCharacterState={frameNum:6};
    assert.equal(sprite.patternWidth(),6);
    sprite.patternWidth=()=>9;sprite.updateCharacterFrame();assert.equal(sprite._frame.width,9);
  });

  await t.test('bobble and shadows update native geometry and leave removed sprites usable', async t => {
    const f=setup(t);
    f.operation(f.prototype,'updateBobble','omori.bobble');f.operation(f.prototype,'updateShadow','omori.shadow');
    f.install();const sprite=f.characterSprite(), player=f.s.$gamePlayer;
    f.s.Graphics.frameCount=20;player._bobble={base:0.5,speed:0.05,amplitude:1.25};
    sprite.updateBobble();assert.equal(sprite.anchor.y,0.5+Math.sin(1)*1.25);
    player._bobble.base=3;sprite.updateBobble();assert.equal(sprite.anchor.y,3+Math.sin(1)*1.25);
    const oldBobble=new WeakRef(player._bobble);
    player._bobble={base:4,speed:0,amplitude:0};
    await new Promise(resolve=>setImmediate(resolve));global.gc();
    assert.equal(oldBobble.deref(),undefined);
    sprite.updateBobble();assert.equal(sprite.anchor.y,4);
    let reads=0;
    Object.defineProperty(player._bobble,'base',{get(){return ++reads;}});
    sprite.updateBobble();sprite.updateBobble();assert.equal(sprite.anchor.y,2);
    const event=f.s.$gameMap.event(1);f.initializeCharacter(event);event._bobble={base:2,speed:0,amplitude:0};
    sprite._character=event;sprite.updateBobble();assert.equal(sprite.anchor.y,2);sprite._character=player;
    player._bobble=null;sprite.updateBobble();assert.equal(sprite.anchor.y,1);
    sprite.setFrame(4,8,12,16);player._shadow={opacity:160,angle:180,x:2,y:3,scaleY:0.5};
    sprite.updateShadow();const shadow=sprite._shadowSprite;
    assert.deepEqual({...shadow._frame},{x:4,y:8,width:12,height:16});
    assert.equal(shadow.parent,sprite);assert.equal(shadow.scale.x,-1);assert.equal(shadow.rotation,Math.PI);
    assert.equal(shadow.opacity,160);assert.equal(shadow.scale.y,0.5);
    player._shadow.x=9;sprite.updateShadow();assert.equal(shadow.x,9);
    player._shadow=null;sprite.updateShadow();assert.equal(shadow.parent,null);assert.equal(Object.hasOwn(sprite,'_shadowSprite'),false);
    f.parent.addChild(shadow);shadow.setFrame(0,0,8,8);assert.equal(shadow._frame.width,8);
  });

  await t.test('mini-label delay, attachment and zoom preserve authored update order', t => {
    const f=setup(t);let created=0;
    f.s.Window_EventMiniLabel=function(){++created;f.s.Window_Base.prototype.initialize.call(this,0,0,40,36);this._text='';this._bufferX=3;this._bufferY=-2;};
    f.s.Window_EventMiniLabel.prototype=Object.create(f.s.Window_Base.prototype);
    f.s.Window_EventMiniLabel.prototype.setCharacter=function(character){this._character=character;this._text=character._labelText||'';};
    for(const [method,name] of Object.entries({bufferX:'bufferX',bufferY:'bufferY'}))f.operation(f.s.Window_EventMiniLabel.prototype,method,'label.'+name);
    const setupLabel=f.operation(f.prototype,'setupMiniLabel','label.setup');f.operation(f.prototype,'setupMiniLabel','label.delay',{function:setupLabel});
    for(const [method,name] of Object.entries({positionMiniLabel:'position',updateMiniLabelZoom:'zoom'}))f.operation(f.prototype,method,'label.'+name);
    f.install();f.parent.addChild(new f.s.Sprite());f.parent.addChild(new f.s.Sprite());
    const sprite=f.characterSprite();f.s.$gamePlayer._labelText='Hello';
    sprite.setupMiniLabel();sprite.setupMiniLabel();assert.equal(created,0);
    sprite.setupMiniLabel();assert.equal(created,1);const label=sprite._miniLabel;assert.equal(label.parent,f.parent);
    sprite.x=30;sprite.y=50;f.parent.scale.set(2,4);sprite.positionMiniLabel();
    assert.equal(label.x,13);assert.equal(label.y,50-sprite.height-36-2);
    sprite.updateMiniLabelZoom();assert.equal(label.scale.x,0.5);assert.equal(label.scale.y,0.25);
    label._text='';sprite.setupMiniLabel();assert.equal(label.parent,null);
    label._text='Again';sprite.setupMiniLabel();assert.equal(sprite._miniLabel,label);assert.equal(label.parent,f.parent);
  });

  await t.test('event icons replace images and retain detached instances without losing animation timing', t => {
    const f=setup(t);let created=0;
    f.s.Sprite_EventCon=function(){++created;f.s.Sprite_Base.prototype.initialize.call(this);this.anchor.set(0.5,1);};
    f.s.Sprite_EventCon.prototype=Object.create(f.s.Sprite_Base.prototype);
    f.s.Sprite_EventCon.prototype.setup=function(image,id){this._eventconImg=image;this._eventconId=id;this._duration=11;this.bitmap=new f.s.Bitmap(96,48);};
    for(const [method,name] of Object.entries({setupEventcon:'setup',startEventcon:'start',updateEventcon:'update',endEventcon:'end',isEventconPlaying:'playing'}))
      f.operation(f.prototype,method,'icons.'+name);
    for(const [method,name] of Object.entries({updateFrame:'frame',speed:'speed',waitTime:'wait',frameIndex:'index'}))
      f.operation(f.s.Sprite_EventCon.prototype,method,'eventcon.'+name);
    f.operation(f.s.Sprite_EventCon.prototype,'update','eventcon.update',{owner:f.s.Sprite_Base.prototype,property:'update'});
    f.install();const sprite=f.characterSprite(),player=f.s.$gamePlayer;
    player._eventIndex=2;player._eventImg='first';sprite.updateEventcon();const first=sprite._eventconSprite;
    assert.equal(first.parent,f.parent);assert.equal(created,1);assert.equal(player._eventconPlaying,true);
    first.update();assert.equal(first._duration,10);assert.deepEqual({...first._frame},{x:0,y:24,width:24,height:24});
    sprite.updateEventcon();assert.equal(created,1);
    player._eventImg='second';sprite.updateEventcon();assert.equal(created,2);assert.equal(first.parent,null);
    assert.equal(sprite._eventconSprite._eventconImg,'second');
    player._eventIndex=-1;player._eventconPlaying=false;const second=sprite._eventconSprite;
    sprite.updateEventcon();assert.equal(sprite._eventconSprite,null);assert.equal(second.parent,null);
    f.parent.addChild(first);first.update();assert.equal(first._duration,9);
  });

  await t.test('invisible reflection copies still run visual updates and observe later parent overrides', t => {
    const f=setup(t),calls=[];
    const base=f.prototype.update;
    f.operation(f.prototype,'updateBobble','omori.bobble');f.operation(f.prototype,'updateShadow','omori.shadow');
    f.prototype.updateInputIcon=()=>calls.push('input');
    f.operation(f.prototype,'update','omori.chain',{function:base});
    function Reflection(character){f.s.Sprite_Character.call(this,character);this.initializeReflection();}
    Reflection.prototype=Object.create(f.prototype);
    f.operation(Reflection.prototype,'update','reflection.chain',{owner:f.prototype,property:'update'});
    f.install();const sprite=new Reflection(f.s.$gamePlayer);sprite._tilesetId=1;sprite.bitmap=new f.s.Bitmap(144,96);f.parent.addChild(sprite);
    f.s.Graphics.frameCount=20;f.s.$gamePlayer._bobble={base:0.5,speed:0.05,amplitude:1};
    sprite.update();assert.equal(sprite.visible,false);assert.equal(sprite.anchor.y,0.5+Math.sin(1));assert.deepEqual(calls,['input']);
    f.runtime.tiledCharacter(f.s.$gamePlayer,'reflections',[{reflectionCast:1,reflectionOpacity:150,reflectionOffset:4}]);
    sprite.update();assert.equal(sprite.visible,true);assert.equal(sprite.scale.y,-1);assert.equal(sprite.opacity,150);
    const saved=f.prototype.update;f.prototype.update=function(){saved.call(this);calls.push('late');};
    sprite.update();assert.equal(calls.at(-1),'late');
  });

  await t.test('native screen positions preserve rounding, offsets and late geometry overrides', t => {
    const f=setup(t),player=f.s.$gamePlayer,prototype=f.s.Game_CharacterBase.prototype;
    f.environment.map=f.s.$gameMap;
    for(const method of ['tileWidth','tileHeight','adjustX','adjustY'])f.operation(f.s.Game_Map.prototype,method,'map.'+method);
    for(const [method,name] of Object.entries({isObjectCharacter:'object',jumpHeight:'jump',shiftY:'shift',scrolledX:'scrolledX',scrolledY:'scrolledY',
      spriteOffsetX:'offsetX',spriteOffsetY:'offsetY',initSpriteOffsets:'offsetInit'}))f.operation(prototype,method,'character.'+name);
    const x=f.operation(prototype,'screenX','position.fukuX'),y=f.operation(prototype,'screenY','position.fukuY');
    f.operation(prototype,'screenX','position.offsetX',{function:x});f.operation(prototype,'screenY','position.offsetY',{function:y});
    f.install();const sprite=f.characterSprite();player._realX=0.25;player._realY=0.5;player._spriteOffsetX=3;player._spriteOffsetY=-4;
    sprite.updatePosition();
    assert.equal(sprite.x,Math.ceil(f.s.$gameMap.adjustX(player._realX)*48+24)+3);
    assert.equal(sprite.y,Math.ceil(f.s.$gameMap.adjustY(player._realY)*48+48-6)-4);
    player.shiftY=()=>10;sprite.updatePosition();
    assert.equal(sprite.y,Math.ceil(f.s.$gameMap.adjustY(player._realY)*48+48-10)-4);
    player.screenX=()=>123;sprite.updatePosition();assert.equal(sprite.x,123);
  });

  await t.test('native map coordinates preserve wrapping, repeated queries and helper overrides', t => {
    const f=setup(t),map=f.s.$gameMap;
    f.s.$dataMap=f.database.maps[1];
    f.environment.map=map;f.environment.mapData=f.s.$dataMap;
    Object.defineProperties(f.environment,{screenWidth:{get(){return f.s.Graphics.width;}},screenHeight:{get(){return f.s.Graphics.height;}}});
    for(const method of ['tileWidth','tileHeight','width','height','displayX','displayY','isLoopHorizontal','isLoopVertical','screenTileX','screenTileY'])
      f.operation(f.s.Game_Map.prototype,method,'map.'+method);
    for(const axis of ['X','Y']) {
      f.operation(f.s.Game_Map.prototype,'adjust'+axis,'map.yepAdjust'+axis);
      f.operation(f.s.Game_Map.prototype,'display'+axis,'map.scaledDisplay'+axis);
    }
    f.install();
    Object.defineProperties(map,{_displayX:{configurable:true,get(){return 12;}},_displayY:{configurable:true,get(){return 8;}}});
    assert.equal(map.displayX(),12);assert.equal(map.displayY(),8);
    assert.equal(map.screenTileX(),64/48);assert.equal(map.screenTileY(),64/48);
    f.s.$dataMap.width=40;f.s.$dataMap.height=30;f.s.$dataMap.scrollType=3;
    assert.equal(map.isLoopHorizontal(),true);assert.equal(map.isLoopVertical(),true);
    assert.equal(map.width(),40);assert.equal(map.height(),30);
    assert.equal(map.adjustX(-20),8);assert.equal(map.adjustY(-20),2);
    assert.equal(map.adjustX(20),8);assert.equal(map.adjustY(20),12);
    const calls=[];
    map.isLoopHorizontal=()=>{calls.push('loop');return false;};
    map.displayX=()=>{calls.push('display');return 5;};
    map.width=()=>{throw Error('Non-looping coordinates must not query width');};
    assert.equal(map.adjustX(-20),-25);assert.deepEqual(calls,['loop','display']);
    calls.length=0;let displayReads=0;
    map.isLoopHorizontal=()=>{calls.push('loop');return true;};
    map.displayX=()=>{calls.push('display');return ++displayReads===1?5:7;};
    map.width=()=>{calls.push('width');return 37;};
    map.screenTileX=()=>{calls.push('screen');return 8;};
    assert.equal(map.adjustX(-20),13);
    assert.deepEqual(calls,['loop','display','width','screen','display']);
    delete map.displayX;calls.length=0;
    Object.defineProperty(map,'_displayX',{get(){calls.push('raw');return 12;}});
    map.tileWidth=()=>{calls.push('first');map.tileWidth=()=>{calls.push('second');return 48;};return 24;};
    assert.equal(map.displayX(),6);assert.deepEqual(calls,['raw','first','second']);
  });

  await t.test('input indicators preserve scale animation, frame timing and parent callbacks', t => {
    const f=setup(t);let attached=0,removed=0;
    const add=f.parent.addChild,remove=f.parent.removeChild;
    f.parent.addChild=function(child){++attached;return add.call(this,child);};
    f.parent.removeChild=function(child){++removed;return remove.call(this,child);};
    f.s.Sprite_InputButton=function(){f.s.Sprite.prototype.initialize.call(this,new f.s.Bitmap(48,24));this._active=false;this._iconFrameDelayMax=2;this._iconFrameDelay=2;this._iconFrame=0;this._iconRects={up:{x:0,y:0,width:24,height:24},down:{x:24,y:0,width:24,height:24}};};
    f.s.Sprite_InputButton.prototype=Object.create(f.s.Sprite.prototype);
    f.s.Sprite_InputButton.prototype.setupInput=function(name){this._inputName=name;};
    f.operation(f.prototype,'updateInputIcon','omori.input');
    f.operation(f.s.Sprite_InputButton.prototype,'update','input.update',{owner:f.s.Sprite.prototype,property:'update'});
    for(const [method,name] of Object.entries({activate:'activate',updateAnimation:'animation',refreshFrame:'frame'}))
      f.operation(f.s.Sprite_InputButton.prototype,method,'input.'+name);
    f.install();const sprite=f.characterSprite(),player=f.s.$gamePlayer;attached=0;
    player._inputIcon={input:'ok',scale:0.8};sprite.updateInputIcon();const icon=sprite._inputIconSprite;
    assert.equal(attached,1);assert.equal(icon.parent,f.parent);assert.equal(icon.scale.x,0.8);assert.equal(icon._inputName,'ok');
    sprite.updateInputIcon();assert.equal(player._inputIcon.scale,0.9);
    icon.update();icon.update();icon.update();assert.equal(icon._iconFrame,1);assert.equal(icon._frame.x,24);
    player._inputIcon=null;for(let i=0;i<12&&sprite._inputIconSprite;++i)sprite.updateInputIcon();
    assert.equal(sprite._inputIconSprite,null);assert.equal(icon.parent,null);assert.equal(removed,1);
    f.parent.addChild(icon);icon.update();assert.equal(icon.parent,f.parent);
  });
});
