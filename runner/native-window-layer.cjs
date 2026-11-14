'use strict';
// RPG Maker MV window masks: Copyright (c) 2015 KADOKAWA CORPORATION./YOJI OJIMA.
// MIT license: third_party/rpg-maker-mv.LICENSE.

function installWindowLayer(runScript, WindowLayer, bridge) {
  return runScript(`(function(WindowLayer, bridge) {
    const states = new WeakMap();
    function state(layer) {
      if (!states.has(layer)) states.set(layer, { active:false, mask:null, rectangle:null, callback:null });
      return states.get(layer);
    }
    function activate(layer) {
      const value=state(layer); value.active=true;
      if (!value.mask) {
        value.mask=bridge.mask();value.rectangle=value.mask.graphicsData[0].shape;
        const rectangle=bridge.rectangle(layer);
        [value.rectangle.x,value.rectangle.y,value.rectangle.width,value.rectangle.height]=rectangle;
      }
      return value;
    }
    WindowLayer.prototype._maskWindow=function(window,shift) {
      this._windowMask._currentBounds=null;
      this._windowMask.boundsDirty=true;
      const rectangle=this._windowRect;
      rectangle.x=this.x+shift.x+window.x;
      rectangle.y=this.x+shift.y+window.y+window.height/2*(1-window._openness/255);
      rectangle.width=window.width;
      rectangle.height=window.height*window._openness/255;
    };
    const defaultMask=WindowLayer.prototype._maskWindow;
    WindowLayer.prototype._canvasClearWindowRect=function(renderSession,window) {
      const x=this.x+window.x,y=this.y+window.y+window.height/2*(1-window._openness/255);
      renderSession.context.clearRect(x,y,window.width,window.height*window._openness/255);
    };
    Object.defineProperty(WindowLayer.prototype,'_windowMask',{configurable:true,
      get() {return activate(this).mask;},set(value) {activate(this).mask=value;}
    });
    Object.defineProperty(WindowLayer.prototype,'_windowRect',{configurable:true,
      get() {return activate(this).rectangle;},set(value) {activate(this).rectangle=value;}
    });
    return {
      prepare(layer) {
        const value=state(layer),enabled=value.active||layer._maskWindow!==defaultMask;
        if (enabled&&!value.callback) {
          activate(layer);
          value.callback=window=>{
            layer._maskWindow(window,{x:0,y:0});
            const mask=layer._windowMask;mask.renderable=true;
            const rectangle=mask.getBounds();mask.renderable=false;
            return [rectangle.x,rectangle.y,rectangle.width,rectangle.height];
          };
          bridge.hook(layer,value.callback);
        } else if (!enabled&&value.callback) {
          value.callback=null;bridge.hook(layer,null);
        }
      }
    };
  })`)(WindowLayer,bridge);
}
module.exports={installWindowLayer};
