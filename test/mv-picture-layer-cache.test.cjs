'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');
const source = fs.readFileSync(require.resolve('../js/pmjs-mv/picture-layer-cache.js'), 'utf8');

function fixture() {
  function NativeImage(handle) { this._nativeImage={handle}; }
  function Sprite() {
    Object.assign(this, { children: [], alpha: 1, worldAlpha: 1, visible: true, renderable: true,
      blendMode: 0, pluginName: 'sprite', anchor: { x: 0, y: 0 },
      transform: { localTransform: { a:1,b:0,c:0,d:1,tx:0,ty:0 } } });
  }
  Object.defineProperty(Sprite.prototype, 'worldTransform', { get() { return this.transform.localTransform; } });
  Sprite.prototype.renderWebGL = function() {};
  Sprite.prototype._renderWebGL = function() {};
  Sprite.prototype._renderCachedWebGL = function() {};
  Sprite.prototype.updateTransform = function() {};
  Sprite.prototype.getLocalBounds = () => ({ width: 816, height: 624 });
  Object.defineProperty(Sprite.prototype, 'cacheAsBitmap', {
    set(value) {
      this._cacheAsBitmap = value;
      if (value) {
        this._cacheData = { originalUpdateTransform:this.updateTransform,originalRenderWebGL:this.renderWebGL };
        this.renderWebGL=this._renderCachedWebGL;
      } else {
        this.updateTransform=this._cacheData.originalUpdateTransform;
        this.renderWebGL=this._cacheData.originalRenderWebGL; this._cacheData.sprite=null;
      }
    }
  });
  let cache;
  Sprite.prototype._initCachedDisplayObject = function(renderer) {
    cache.prepare({}, renderer); // Nested snapshot rendering must not evict its owner.
    this._cacheData.sprite = {};
    this.updateTransform = function cachedTransform() {};
  };
  const layer = new Sprite();
  for(let handle=1;handle<=2;handle++) {
    const child = new Sprite();
    child.texture = { _updateID:0, _frame:{x:0,y:0,width:816,height:624},
      baseTexture:{source:new NativeImage(handle),scaleMode:0,resolution:1} };
    layer.children.push(child);
  }
  const realm = { Sprite, NativeImage, PIXI:{utils:{TextureCache:{}}}, PMJS:{}, nativeTextureSource: s=>s._nativeImage,
    pmjsPixiRenderPreflight:{producer:()=>({filterAccess:'backing',
      renderWebGL:Sprite.prototype.renderWebGL,_renderWebGL:Sprite.prototype._renderWebGL}),
      unsupportedMethod:node=>node._renderWebGL!==Sprite.prototype._renderWebGL} };
  vm.runInNewContext(source,realm); cache=realm.PMJS.mv.pictureLayerCache;
  const stage={_spriteset:{_pictureContainer:layer}};
  const renderer={renderingToScreen:true,resolution:1,roundPixels:false,
    screen:{width:816,height:624},bindTexture(){}};
  const frame=()=>cache.prepare(stage,renderer);
  const settle=()=>{for(let i=0;i<9;i++)frame();};
  return {cache,layer,stage,renderer,frame,settle,NativeImage};
}

test('late producer mutations invalidate a snapshot at its render turn',()=>{
  const f=fixture(); f.settle();
  f.layer.children[0].transform.localTransform.ty++;
  f.cache.validate(f.layer,f.renderer);
  assert.equal(f.cache.diagnostics().active,false);
});
test('a failed snapshot restores live drawing without retrying every frame',()=>{
  const f=fixture();
  f.layer._initCachedDisplayObject=()=>{throw new Error('allocation failed');};
  f.settle();
  assert.equal(f.layer._cacheAsBitmap,false);
  assert.equal(f.cache.diagnostics().failures,1);
  f.settle(); assert.equal(f.cache.diagnostics().failures,1);
});
test('late transform hooks and inherited method lookup survive cache release',()=>{
  const f=fixture(); f.settle();
  const prototype=Object.getPrototypeOf(f.layer);
  const transform=function lateTransform(){};
  prototype.updateTransform=transform;
  assert.equal(f.layer.updateTransform,transform);
  f.cache.release();
  assert.equal(f.layer.updateTransform,transform);
  assert.equal(Object.hasOwn(f.layer,'updateTransform'),false);
});
test('ancestor fades return overlapping pictures to ordinary alpha compositing',()=>{
  const f=fixture(); f.layer.parent={alpha:1,worldAlpha:1}; f.settle();
  assert.equal(f.cache.diagnostics().active,true);
  f.layer.parent.alpha=0.5; f.frame();
  assert.equal(f.cache.diagnostics().active,false);
});
test('layer images and openness changes invalidate snapshots',()=>{
  const f=fixture(); f.settle();
  f.layer._openness=0; f.frame();
  assert.equal(f.cache.diagnostics().active,false);
  f.layer._openness=255; f.settle();
  assert.equal(f.cache.diagnostics().active,true);
  f.layer.texture=f.layer.children[0].texture; f.frame();
  assert.equal(f.cache.diagnostics().active,false);
});

test('settled picture snapshots preserve transform callbacks and reuse until visual state changes',()=>{
  for(const mutate of [
    node=>{node.transform.localTransform.tx++;},
    node=>{node.alpha=0.5;},
    node=>{node.visible=false;},
    node=>{node.texture._frame.x++;},
    node=>{node.texture.baseTexture.source._nativeImage={handle:99};},
    node=>{node.texture.baseTexture.scaleMode=1;},
    node=>{node._filters=[{}];},
    node=>{node.children.push(new Object());},
    node=>{node._renderWebGL=function pluginRender(){};}
  ]) {
    const f=fixture(), transform=f.layer.updateTransform;
    f.settle(); assert.equal(f.cache.diagnostics().active,true);
    assert.equal(f.layer.updateTransform,transform);
    f.frame(); assert.equal(f.cache.diagnostics().captures,1);
    assert.equal(f.cache.diagnostics().hits,1);
    mutate(f.layer.children[0]); f.frame();
    assert.equal(f.cache.diagnostics().active,false);
    assert.equal(f.layer.updateTransform,transform);
  }
});
test('moving pictures stay live; replacement and removal invalidate before reuse',()=>{
  const f=fixture();
  for(let i=0;i<30;i++) {f.layer.children[0].transform.localTransform.tx++;f.frame();}
  assert.equal(f.cache.diagnostics().captures,0);
  f.settle(); assert.equal(f.cache.diagnostics().active,true);
  f.layer.children.reverse(); f.frame(); assert.equal(f.cache.diagnostics().active,false);
  f.settle(); assert.equal(f.cache.diagnostics().active,true);
  f.layer.children.pop(); f.frame(); assert.equal(f.cache.diagnostics().active,false);
});
test('guest caches and unsupported sources retain ordinary rendering; scene changes release only owned snapshots',()=>{
  const f=fixture();
  f.layer.cacheAsBitmap=true; f.settle(); assert.equal(f.cache.diagnostics().captures,0);
  assert.equal(f.layer._cacheAsBitmap,true);
  f.layer.cacheAsBitmap=false;
  f.layer.children[0].texture.baseTexture.source={_nativeCanvas:{handle:1}};
  f.settle(); assert.equal(f.cache.diagnostics().active,false);
  f.layer.children[0].texture.baseTexture.source={_nativeImage:{handle:1}};
  f.settle(); assert.equal(f.cache.diagnostics().active,false,'video-like native handles are not immutable images');
  f.layer.children[0].texture.baseTexture.source=new f.NativeImage(1);
  f.settle(); assert.equal(f.cache.diagnostics().active,true);
  f.renderer.renderingToScreen=false; f.cache.prepare({},f.renderer);
  assert.equal(f.cache.diagnostics().active,true);
  f.renderer.renderingToScreen=true; f.cache.prepare({},f.renderer);
  assert.equal(f.layer._cacheAsBitmap,false);
});

test('moving foreground pictures retain a stable background snapshot and live guest children',()=>{
  const f=fixture();
  const marker=new f.layer.constructor();
  marker.texture={...f.layer.children[0].texture,
    _frame:{x:0,y:0,width:32,height:48}};
  f.layer.children.push(marker);
  const children=f.layer.children;
  const captured=[];
  const initialize=f.layer._initCachedDisplayObject;
  f.layer._initCachedDisplayObject=function(renderer) {
    captured.push(this.children.slice());
    initialize.call(this,renderer);
  };
  for(let i=0;i<30;i++) {marker.transform.localTransform.tx++;f.frame();}
  assert.equal(f.cache.diagnostics().captures,1);
  assert.equal(f.cache.diagnostics().cachedChildren,2);
  assert.equal(f.layer.children,children);
  assert.deepEqual(captured[0],children.slice(0,2));
  assert.deepEqual(Array.from(f.cache.tail(f.layer)),[marker]);
  marker.transform.localTransform.tx++;
  f.cache.validate(f.layer,f.renderer);
  assert.equal(f.cache.diagnostics().active,true,'late foreground movement stays live');
  marker.texture = {...marker.texture, _frame:{x:0,y:0,width:48,height:48}};
  marker.alpha = 0.5;
  f.cache.validate(f.layer,f.renderer);
  assert.equal(f.cache.diagnostics().active,true,'foreground artwork and fades stay live');
  f.settle();
  assert.equal(f.cache.diagnostics().captures,1,'a settled marker does not expand the snapshot');
  children[0].texture._frame.width--;
  f.cache.validate(f.layer,f.renderer);
  assert.equal(f.cache.diagnostics().active,false,'background mutations invalidate immediately');
});

test('a whole-layer cache shrinks to its stable prefix when the foreground starts moving',()=>{
  const f=fixture();
  const marker=new f.layer.constructor();
  marker.texture={...f.layer.children[0].texture,_frame:{x:0,y:0,width:32,height:48}};
  f.layer.children.push(marker);
  f.settle();
  assert.equal(f.cache.diagnostics().cachedChildren,3);
  marker.transform.localTransform.tx++;
  f.frame();
  assert.equal(f.cache.diagnostics().cachedChildren,2);
  assert.equal(f.cache.diagnostics().captures,2);
  for(let i=0;i<20;i++) {marker.transform.localTransform.tx++;f.frame();}
  assert.equal(f.cache.diagnostics().captures,2);
  f.layer.children.unshift(new f.layer.constructor());
  f.cache.validate(f.layer,f.renderer);
  assert.equal(f.cache.diagnostics().active,false,'insertion ahead of the prefix changes painter order');
});

test('unsupported foreground producers remain live and failed prefix capture restores the child array',()=>{
  const f=fixture();
  const foreground=new f.layer.constructor();
  foreground._filters=[{}];
  f.layer.children.push(foreground);
  const children=f.layer.children;
  f.settle();
  assert.equal(f.cache.diagnostics().cachedChildren,2);
  assert.deepEqual(Array.from(f.cache.tail(f.layer)),[foreground]);
  f.cache.release();
  f.layer._initCachedDisplayObject=()=>{throw new Error('snapshot failed');};
  f.settle();
  assert.equal(f.layer.children,children);
  assert.equal(f.cache.diagnostics().active,false);
  assert.equal(f.cache.diagnostics().failures,1);
});
