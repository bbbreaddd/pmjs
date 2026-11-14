'use strict';
// RPG Maker MV sprite tinting: Copyright (c) 2015 KADOKAWA CORPORATION./YOJI OJIMA.
// MIT license: third_party/rpg-maker-mv.LICENSE.
function installSpriteTextures(runtime, display) {
  if (!runtime.scope.PIXI?.Texture) return;
  const install=runtime.runScript(String.raw`(function(display) {
    const states=new WeakMap(), nativeRefresh=Sprite.prototype._refresh;
Sprite.prototype._createTinter = function(w, h) {
    if (!this._canvas) {
        this._canvas = document.createElement('canvas');
        this._context = this._canvas.getContext('2d');
    }

    this._canvas.width = w;
    this._canvas.height = h;

    if (!this._tintTexture) {
        this._tintTexture = new PIXI.BaseTexture(this._canvas);
    }

    this._tintTexture.width = w;
    this._tintTexture.height = h;
    this._tintTexture.scaleMode = this._bitmap.baseTexture.scaleMode;
};
Sprite.prototype._executeTint = function(x, y, w, h) {
    var context = this._context;
    var tone = this._colorTone;
    var color = this._blendColor;

    context.globalCompositeOperation = 'copy';
    context.drawImage(this._bitmap.canvas, x, y, w, h, 0, 0, w, h);

    if (Graphics.canUseSaturationBlend()) {
        var gray = Math.max(0, tone[3]);
        context.globalCompositeOperation = 'saturation';
        context.fillStyle = 'rgba(255,255,255,' + gray / 255 + ')';
        context.fillRect(0, 0, w, h);
    }

    var r1 = Math.max(0, tone[0]);
    var g1 = Math.max(0, tone[1]);
    var b1 = Math.max(0, tone[2]);
    context.globalCompositeOperation = 'lighter';
    context.fillStyle = Utils.rgbToCssColor(r1, g1, b1);
    context.fillRect(0, 0, w, h);

    if (Graphics.canUseDifferenceBlend()) {
        context.globalCompositeOperation = 'difference';
        context.fillStyle = 'white';
        context.fillRect(0, 0, w, h);

        var r2 = Math.max(0, -tone[0]);
        var g2 = Math.max(0, -tone[1]);
        var b2 = Math.max(0, -tone[2]);
        context.globalCompositeOperation = 'lighter';
        context.fillStyle = Utils.rgbToCssColor(r2, g2, b2);
        context.fillRect(0, 0, w, h);

        context.globalCompositeOperation = 'difference';
        context.fillStyle = 'white';
        context.fillRect(0, 0, w, h);
    }

    var r3 = Math.max(0, color[0]);
    var g3 = Math.max(0, color[1]);
    var b3 = Math.max(0, color[2]);
    var a3 = Math.max(0, color[3]);
    context.globalCompositeOperation = 'source-atop';
    context.fillStyle = Utils.rgbToCssColor(r3, g3, b3);
    context.globalAlpha = a3 / 255;
    context.fillRect(0, 0, w, h);

    context.globalCompositeOperation = 'destination-in';
    context.globalAlpha = 1;
    context.drawImage(this._bitmap.canvas, x, y, w, h, 0, 0, w, h);
};
var refreshTexture = function() {
    var frameX = Math.floor(this._frame.x);
    var frameY = Math.floor(this._frame.y);
    var frameW = Math.floor(this._frame.width);
    var frameH = Math.floor(this._frame.height);
    var bitmapW = this._bitmap ? this._bitmap.width : 0;
    var bitmapH = this._bitmap ? this._bitmap.height : 0;
    var realX = frameX.clamp(0, bitmapW);
    var realY = frameY.clamp(0, bitmapH);
    var realW = (frameW - realX + frameX).clamp(0, bitmapW - realX);
    var realH = (frameH - realY + frameY).clamp(0, bitmapH - realY);

    this._realFrame.x = realX;
    this._realFrame.y = realY;
    this._realFrame.width = realW;
    this._realFrame.height = realH;
    this.pivot.x = frameX - realX;
    this.pivot.y = frameY - realY;

    if (realW > 0 && realH > 0) {
        if (this._needsTint()) {
            this._createTinter(realW, realH);
            this._executeTint(realX, realY, realW, realH);
            this._tintTexture.update();
            this.texture.baseTexture = this._tintTexture;
            this.texture.frame = new Rectangle(0, 0, realW, realH);
        } else {
            if (this._bitmap) {
                this.texture.baseTexture = this._bitmap.baseTexture;
            }
            this.texture.frame = this._realFrame;
        }
    } else if (this._bitmap) {
        this.texture.frame = Rectangle.emptyRectangle;
    } else {
        this.texture.baseTexture.width = Math.max(this.texture.baseTexture.width, this._frame.x + this._frame.width);
        this.texture.baseTexture.height = Math.max(this.texture.baseTexture.height, this._frame.y + this._frame.height);
        this.texture.frame = this._frame;
    }
    this.texture._updateID++;
};
    const defaultTinter=Sprite.prototype._createTinter, defaultTint=Sprite.prototype._executeTint, defaultNeedsTint=Sprite.prototype._needsTint;
    function activate(sprite) {
      let state=states.get(sprite);
      if(!state) {
        state={texture:new PIXI.Texture(new PIXI.BaseTexture()),realFrame:new Rectangle(),copy:null,bitmap:sprite.bitmap};
        states.set(sprite,state);
        display.prepareDisplay(sprite,()=>synchronize(sprite));
      }
      return state;
    }
    function synchronize(sprite) {
      const state=states.get(sprite);if(!state)return;
      const bitmap=sprite.bitmap;
      const requested=sprite._frame,frameKey=[requested.x,requested.y,requested.width,requested.height].join(',');
      if(bitmap!==state.bitmap) {
        state.bitmap=bitmap;
        if(bitmap)bitmap.addLoadListener(value=>sprite._onBitmapLoad(value));
        else sprite._pmjsBitmapCleared();
        return;
      }
      if(state.frameKey!==undefined&&state.frameKey!==frameKey) {sprite._refresh();return;}
      const texture=state.texture,base=texture&&texture.baseTexture,frame=texture&&texture.frame;
      if(!base||!frame) {display.setSpriteTexture(sprite,null);return;}
      let renderedBitmap;
      if(sprite.bitmap&&base===sprite.bitmap.baseTexture)renderedBitmap=sprite.bitmap;
      else if(display.bitmapFromSource(base.source))renderedBitmap=display.bitmapFromSource(base.source);
      else {
        const source=base.source,width=source&&source.width||0,height=source&&source.height||0;
        const revision=source&&source.__pmjsContentRevision;
        if(!state.copy)state.copy=new Bitmap(width,height);
        renderedBitmap=state.copy;
        if(source!==state.source||revision===undefined||revision!==state.revision||width!==renderedBitmap.width||height!==renderedBitmap.height||base._updateID!==state.updateID) {
          renderedBitmap.resize(width,height);
          if(width&&height&&source)renderedBitmap._context.drawImage(source,0,0);
          state.source=source;state.revision=revision;state.updateID=base._updateID;
        }
      }
      renderedBitmap.smooth=base.scaleMode!==PIXI.SCALE_MODES.NEAREST;
      const resolution=Number(base.resolution)||1,rotation=((Number(texture.rotate)||0)%16+16)%16;
      let sourceFrame=new Rectangle(frame.x*resolution,frame.y*resolution,frame.width*resolution,frame.height*resolution);
      if((rotation||texture.trim)&&frame.width>0&&frame.height>0) {
        if(rotation%2)throw new Error('Texture rotation must use even groupD8 orientations');
        const original=texture.orig||frame,trim=texture.trim||{x:0,y:0,width:original.width,height:original.height};
        const signature=[renderedBitmap._canvas.__pmjsContentRevision,frame.x,frame.y,frame.width,frame.height,original.width,original.height,
          trim.x,trim.y,trim.width,trim.height,resolution,rotation,texture._updateID].join(',');
        if(state.rasterSource!==renderedBitmap||state.rasterKey!==signature) {
          if(!state.crop)state.crop=new Bitmap();if(!state.raster)state.raster=new Bitmap();
          state.crop.resize(Math.ceil(sourceFrame.width),Math.ceil(sourceFrame.height));
          state.crop.blt(renderedBitmap,sourceFrame.x,sourceFrame.y,sourceFrame.width,sourceFrame.height,0,0);
          state.raster.resize(Math.ceil(original.width*resolution),Math.ceil(original.height*resolution));
          display.transformTexture(state.crop,state.raster,Math.floor(trim.x*resolution),Math.floor(trim.y*resolution),Math.ceil(trim.width*resolution),Math.ceil(trim.height*resolution),rotation/2);
          state.rasterSource=renderedBitmap;state.rasterKey=signature;
        }
        renderedBitmap=state.raster;renderedBitmap.smooth=base.scaleMode!==PIXI.SCALE_MODES.NEAREST;
        sourceFrame=new Rectangle(0,0,renderedBitmap.width,renderedBitmap.height);
      }
      display.setSpriteTexture(sprite,renderedBitmap,sourceFrame,resolution);
    }
    Object.defineProperty(Sprite.prototype,'texture',{configurable:true,get() {
      const existing=states.has(this),state=activate(this);if(!existing)this._refresh();return state.texture;
    },set(value) {activate(this).texture=value;synchronize(this);} });
    Object.defineProperty(Sprite.prototype,'_texture',{configurable:true,get() {return this.texture;},set(value) {this.texture=value;}});
    Object.defineProperty(Sprite.prototype,'_realFrame',{configurable:true,get() {
      const existing=states.has(this),state=activate(this);if(!existing)this._refresh();return state.realFrame;
    },set(value) {activate(this).realFrame=value;} });
    Sprite.prototype._refresh=function() {
      if(!states.has(this)&&this._createTinter===defaultTinter&&this._executeTint===defaultTint&&this._needsTint===defaultNeedsTint)return nativeRefresh.call(this);
      const state=activate(this);state.bitmap=this.bitmap;
      const frame=this._frame;state.frameKey=[frame.x,frame.y,frame.width,frame.height].join(',');
      refreshTexture.call(this);synchronize(this);
    };
    TilingSprite.prototype._refresh=function() {
      if(!states.has(this))return nativeRefresh.call(this);
      const state=activate(this),requested=this._frame;
      state.bitmap=this.bitmap;state.frameKey=[requested.x,requested.y,requested.width,requested.height].join(',');
      const frame=this._frame.clone();
      if(frame.width===0&&frame.height===0&&this.bitmap) {frame.width=this.bitmap.width;frame.height=this.bitmap.height;}
      if(this.bitmap)state.texture.baseTexture=this.bitmap.baseTexture;
      state.texture.frame=frame;state.texture._updateID++;this.tilingTexture=null;synchronize(this);
    };
    Sprite.prototype._pmjsBitmapCleared=function() {
      const state=states.get(this);if(state) {state.texture.frame=Rectangle.emptyRectangle;synchronize(this);}
    };
    const nativeBounds=Sprite.prototype.getBounds;
    Sprite.prototype.getBounds=function() {
      const state=states.get(this);if(!state)return nativeBounds.call(this);
      const frame=state.texture&&(state.texture.orig||state.texture.frame);
      if(!frame)return new Rectangle();
      const matrix=this.worldTransform,x=-this.anchor.x*frame.width,y=-this.anchor.y*frame.height;
      let left=Infinity,top=Infinity,right=-Infinity,bottom=-Infinity;
      const add=(px,py)=>{left=Math.min(left,px);top=Math.min(top,py);right=Math.max(right,px);bottom=Math.max(bottom,py);};
      for(const [px,py] of [[x,y],[x+frame.width,y],[x,y+frame.height],[x+frame.width,y+frame.height]])add(matrix.a*px+matrix.c*py+matrix.tx,matrix.b*px+matrix.d*py+matrix.ty);
      for(const child of this.children)if(child.visible&&child.renderable) {const bounds=child.getBounds();if(bounds.width&&bounds.height){add(bounds.x,bounds.y);add(bounds.x+bounds.width,bounds.y+bounds.height);}}
      return new Rectangle(left,top,right-left,bottom-top);
    };
    for(const method of ['setFrame','setColorTone','setBlendColor']) {
      const original=Sprite.prototype[method];
      Sprite.prototype[method]=function(...args) {const result=original.apply(this,args);this._refresh();return result;};
    }
    for(const field of ['width','height']) {
      const descriptor=Object.getOwnPropertyDescriptor(Sprite.prototype,field);
      Object.defineProperty(Sprite.prototype,field,{...descriptor,set(value) {descriptor.set.call(this,value);this._refresh();}});
    }
  })`);
  install(display);
}
module.exports = { installSpriteTextures };
