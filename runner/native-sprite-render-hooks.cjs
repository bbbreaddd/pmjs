'use strict';
// RPG Maker MV render hooks: Copyright (c) 2015 KADOKAWA CORPORATION./YOJI OJIMA.
// MIT license: third_party/rpg-maker-mv.LICENSE.

function installSpriteRenderHooks(Sprite, display) {
  const methods=['_renderWebGL','_renderCanvas','_renderWebGL_PIXI','_renderCanvas_PIXI','_speedUpCustomBlendModes'];
  const contracts=[],objects=new Set(),states=new WeakMap();
  Sprite.prototype._speedUpCustomBlendModes=function(renderer) {
    const picture=renderer.plugins.picture;
    if(renderer.renderingToScreen&&renderer._activeRenderTarget.root&&picture.drawModes[this.blendMode]) {
      const stage=renderer._lastObjectRendered,filters=stage._filters;
      if(!filters||!filters[0])display.defer(()=>{
        const current=stage._filters;
        if(!current||!current[0]) {stage.filters=[Sprite.voidFilter];stage.filterArea=display.filterArea();}
      });
    }
  };
  function install(Type, tiling) {
    for(const name of ['_renderWebGL_PIXI','_renderCanvas_PIXI']) Type.prototype[name]=function(renderer) {display.renderDefault(this,renderer);};
    Type.prototype._renderCanvas=function(renderer) {
      if(this.bitmap)this.bitmap.touch();
      if(this.bitmap&&!this.bitmap.isReady())return;
      this._renderCanvas_PIXI(renderer);
    };
    Type.prototype._renderWebGL=function(renderer) {
      if(this.bitmap) {this.bitmap.touch();this.bitmap.checkDirty();}
      if(this.bitmap&&!this.bitmap.isReady())return;
      if(tiling) {this._speedUpCustomBlendModes(renderer);this._renderWebGL_PIXI(renderer);}
      else {
        if(this.pluginName==='sprite'&&this._isPicture)this._speedUpCustomBlendModes(renderer);
        display.renderDefault(this,renderer);
      }
    };
    contracts.unshift({Type,defaults:new Map(methods.map(name=>[name,Type.prototype[name]]))});
  }
  install(Sprite,false);
  const calculateVertices=Sprite.prototype.calculateVertices;
  const contract=object=>contracts.find(value=>object instanceof value.Type);
  const changed=object=>{const value=contract(object);return methods.some(name=>object[name]!==value.defaults.get(name));};
  function synchronize(object) {
    const state=states.get(object);if(!state)return;
    const routed=display.requiresHook(object)||object.calculateVertices!==calculateVertices;
    const enabled=routed||changed(object);
    if(enabled===state.enabled)return;
    state.enabled=enabled;
    state.callback=enabled?()=>{
      const name=display.isWebGL()?'_renderWebGL':'_renderCanvas',method=object[name];
      if(typeof method!=='function')throw new TypeError('Sprite.'+name+' is not callable');
      if(!changed(object)&&!display.requiresHook(object)&&object.calculateVertices===calculateVertices)return false;
      method.call(object,display.renderer());return true;
    }:null;
    display.setHook(object,state.callback);
  }
  return {
    installTiling(Type) {install(Type,true);},
    overridden() {return display.rendererChanged()||Sprite.prototype.calculateVertices!==calculateVertices||contracts.some(({Type,defaults})=>methods.some(name=>Type.prototype[name]!==defaults.get(name)));},
    register(object) {
      if(states.has(object))return;
      const reference=new WeakRef(object);objects.add(reference);states.set(object,{enabled:false,callback:null});synchronize(object);
    },
    update() {
      for(const reference of objects) {const object=reference.deref();if(object)synchronize(object);else objects.delete(reference);}
    }
  };
}
module.exports={installSpriteRenderHooks};
