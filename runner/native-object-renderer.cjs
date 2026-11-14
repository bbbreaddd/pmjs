'use strict';

function createObjectRenderer(bridge) {
  function renderSprite(object) {
    if(bridge.isTiling(object))return bridge.draw(object);
    if(!object.vertexData)object.calculateVertices();
    if(!object.vertexData||object.vertexData.length!==8)throw new TypeError('Sprite vertexData must contain eight coordinates');
    bridge.draw(object,object.vertexData);
  }
  function batch() {
    return {
      render:renderSprite,
      start() {},
      stop() {this.flush();},
      // Draws enter the native command queue immediately; there is no JavaScript batch.
      flush() {}
    };
  }
  const plugins={sprite:batch(),picture:batch(),tilingSprite:batch()};
  plugins.picture.drawModes=[];
  function setObjectRenderer(next) {
    if(!next||typeof next.render!=='function')throw new TypeError('Object renderer must provide render()');
    if(this.currentRenderer===next)return;
    this.currentRenderer?.stop?.();this.currentRenderer=next;next.start?.();
  }
  const renderer={
    type:1,plugins,currentRenderer:null,renderingToScreen:true,_lastObjectRendered:null,_activeRenderTarget:{root:true},
    gl: {
      MAX_VARYING_VECTORS: 0x8dfc,
      isContextLost() { return false; },
      flush() { renderer.flush(); },
      getParameter(parameter) {
        if (parameter === this.MAX_VARYING_VECTORS) return bridge.graphicsInfo().maxVaryingVectors;
        throw new TypeError('Unsupported native graphics parameter: ' + parameter);
      }
    },
    setObjectRenderer,
    flush() {this.currentRenderer?.flush?.();},
    clear() {bridge.clear();},
    render(stage) {bridge.update();this._lastObjectRendered=stage;bridge.submit(stage);}
  };
  for(const field of ['width','height'])Object.defineProperty(renderer,field,{enumerable:true,get() {return bridge.dimension(field);}});
  const originals=Object.entries(plugins), names=new Set(Object.keys(plugins));
  function changed() {
    if(renderer.plugins!==plugins||renderer.setObjectRenderer!==setObjectRenderer)return true;
    for(const mode of Object.values(plugins.picture.drawModes||{}))if(mode)return true;
    for(let i=0;i<originals.length;++i) {
      const original=originals[i];
      if(plugins[original[0]]!==original[1]||original[1].render!==renderSprite)return true;
    }
    for(const name of Object.keys(plugins))if(!names.has(name)&&typeof plugins[name]?.render==='function')return true;
    return false;
  }
  return {
    renderer,
    changed,
    requiresHook(object) {return changed()||object.pluginName!==(bridge.isTiling(object)?'picture':'sprite');},
    route(object, target = renderer) {
      if(object.bitmap&&!object.bitmap.isReady())return;
      if(!bridge.isTiling(object))object.calculateVertices();
      const name=object.pluginName==='sprite'&&object._isPicture?'picture':object.pluginName;
      const plugin=target.plugins[name];
      if(!plugin||typeof plugin.render!=='function')throw new Error('Unsupported sprite object renderer: '+name);
      target.setObjectRenderer(plugin);plugin.render(object);
    }
  };
}
module.exports={createObjectRenderer};
