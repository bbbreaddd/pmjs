'use strict';
// RPG Maker MV window parts: Copyright (c) 2015 KADOKAWA CORPORATION./YOJI OJIMA.
// MIT license: third_party/rpg-maker-mv.LICENSE.

function installWindowParts(runScript, types, bridge) {
  const factory = runScript(String.raw`(function(Window, Sprite, Bitmap, bridge) {
Window.prototype.updateTransform = function() {
    this._updateCursor();
    this._updateArrows();
    this._updatePauseSign();
    this._updateContents();

};
Window.prototype._createAllParts = function() {
    this._windowSpriteContainer.removeChildren();
    this._windowBackSprite = new Sprite();
    this._windowCursorSprite = new Sprite();
    this._windowFrameSprite = new Sprite();
    this._windowContentsSprite = new Sprite();
    this._downArrowSprite = new Sprite();
    this._upArrowSprite = new Sprite();
    this._windowPauseSignSprite = new Sprite();
    this._windowBackSprite.bitmap = new Bitmap(1, 1);
    this._windowBackSprite.alpha = 192 / 255;

    this._windowSpriteContainer.addChild(this._windowBackSprite);
    this._windowSpriteContainer.addChild(this._windowFrameSprite);
    this.addChild(this._windowCursorSprite);
    this.addChild(this._windowContentsSprite);
    this.addChild(this._downArrowSprite);
    this.addChild(this._upArrowSprite);
    this.addChild(this._windowPauseSignSprite);
};
Window.prototype._onWindowskinLoad = function() {
    this._refreshAllParts();
};
Window.prototype._refreshAllParts = function() {
    this._refreshBack();
    this._refreshFrame();
    this._refreshCursor();
    this._refreshContents();
    this._refreshArrows();
    this._refreshPauseSign();
};
Window.prototype._refreshBack = function() {
    var m = this._margin;
    var w = this._width - m * 2;
    var h = this._height - m * 2;
    var bitmap = new Bitmap(w, h);
    this._windowBackSprite.bitmap = bitmap;
    this._windowBackSprite.setFrame(0, 0, w, h);
    this._windowBackSprite.move(m, m);
    if (w > 0 && h > 0 && this._windowskin) {
        var p = 96;
        bitmap.blt(this._windowskin, 0, 0, p, p, 0, 0, w, h);
        for (var y = 0; y < h; y += p) {
            for (var x = 0; x < w; x += p) {
                bitmap.blt(this._windowskin, 0, p, p, p, x, y, p, p);
            }
        }
        var tone = this._colorTone;
        bitmap.adjustTone(tone[0], tone[1], tone[2]);
    }
};
Window.prototype._refreshFrame = function() {
    var w = this._width;
    var h = this._height;
    var m = 24;
    var bitmap = new Bitmap(w, h);
    this._windowFrameSprite.bitmap = bitmap;
    this._windowFrameSprite.setFrame(0, 0, w, h);
    if (w > 0 && h > 0 && this._windowskin) {
        var skin = this._windowskin;
        var p = 96;
        var q = 96;
        bitmap.blt(skin, p+m, 0+0, p-m*2, m, m, 0, w-m*2, m);
        bitmap.blt(skin, p+m, 0+q-m, p-m*2, m, m, h-m, w-m*2, m);
        bitmap.blt(skin, p+0, 0+m, m, p-m*2, 0, m, m, h-m*2);
        bitmap.blt(skin, p+q-m, 0+m, m, p-m*2, w-m, m, m, h-m*2);
        bitmap.blt(skin, p+0, 0+0, m, m, 0, 0, m, m);
        bitmap.blt(skin, p+q-m, 0+0, m, m, w-m, 0, m, m);
        bitmap.blt(skin, p+0, 0+q-m, m, m, 0, h-m, m, m);
        bitmap.blt(skin, p+q-m, 0+q-m, m, m, w-m, h-m, m, m);
    }
};
Window.prototype._refreshCursor = function() {
    var pad = this._padding;
    var x = this._cursorRect.x + pad - this.origin.x;
    var y = this._cursorRect.y + pad - this.origin.y;
    var w = this._cursorRect.width;
    var h = this._cursorRect.height;
    var m = 4;
    var x2 = Math.max(x, pad);
    var y2 = Math.max(y, pad);
    var ox = x - x2;
    var oy = y - y2;
    var w2 = Math.min(w, this._width - pad - x2);
    var h2 = Math.min(h, this._height - pad - y2);
    var bitmap = new Bitmap(w2, h2);
    this._windowCursorSprite.bitmap = bitmap;
    this._windowCursorSprite.setFrame(0, 0, w2, h2);
    this._windowCursorSprite.move(x2, y2);
    if (w > 0 && h > 0 && this._windowskin) {
        var skin = this._windowskin;
        var p = 96;
        var q = 48;
        bitmap.blt(skin, p+m, p+m, q-m*2, q-m*2, ox+m, oy+m, w-m*2, h-m*2);
        bitmap.blt(skin, p+m, p+0, q-m*2, m, ox+m, oy+0, w-m*2, m);
        bitmap.blt(skin, p+m, p+q-m, q-m*2, m, ox+m, oy+h-m, w-m*2, m);
        bitmap.blt(skin, p+0, p+m, m, q-m*2, ox+0, oy+m, m, h-m*2);
        bitmap.blt(skin, p+q-m, p+m, m, q-m*2, ox+w-m, oy+m, m, h-m*2);
        bitmap.blt(skin, p+0, p+0, m, m, ox+0, oy+0, m, m);
        bitmap.blt(skin, p+q-m, p+0, m, m, ox+w-m, oy+0, m, m);
        bitmap.blt(skin, p+0, p+q-m, m, m, ox+0, oy+h-m, m, m);
        bitmap.blt(skin, p+q-m, p+q-m, m, m, ox+w-m, oy+h-m, m, m);
    }
};
Window.prototype._refreshContents = function() {
    this._windowContentsSprite.move(this.padding, this.padding);
};
Window.prototype._refreshArrows = function() {
    var w = this._width;
    var h = this._height;
    var p = 24;
    var q = p/2;
    var sx = 96+p;
    var sy = 0+p;
    this._downArrowSprite.bitmap = this._windowskin;
    this._downArrowSprite.anchor.x = 0.5;
    this._downArrowSprite.anchor.y = 0.5;
    this._downArrowSprite.setFrame(sx+q, sy+q+p, p, q);
    this._downArrowSprite.move(w/2, h-q);
    this._upArrowSprite.bitmap = this._windowskin;
    this._upArrowSprite.anchor.x = 0.5;
    this._upArrowSprite.anchor.y = 0.5;
    this._upArrowSprite.setFrame(sx+q, sy, p, q);
    this._upArrowSprite.move(w/2, q);
};
Window.prototype._refreshPauseSign = function() {
    var sx = 144;
    var sy = 96;
    var p = 24;
    this._windowPauseSignSprite.bitmap = this._windowskin;
    this._windowPauseSignSprite.anchor.x = 0.5;
    this._windowPauseSignSprite.anchor.y = 1;
    this._windowPauseSignSprite.move(this._width / 2, this._height);
    this._windowPauseSignSprite.setFrame(sx, sy, p, p);
    this._windowPauseSignSprite.alpha = 0;
};
Window.prototype._updateCursor = function() {
    var blinkCount = this._animationCount % 40;
    var cursorOpacity = this.contentsOpacity;
    if (this.active) {
        if (blinkCount < 20) {
            cursorOpacity -= blinkCount * 8;
        } else {
            cursorOpacity -= (40 - blinkCount) * 8;
        }
    }
    this._windowCursorSprite.alpha = cursorOpacity / 255;
    this._windowCursorSprite.visible = this.isOpen();
};
Window.prototype._updateContents = function() {
    var w = this._width - this._padding * 2;
    var h = this._height - this._padding * 2;
    if (w > 0 && h > 0) {
        this._windowContentsSprite.setFrame(this.origin.x, this.origin.y, w, h);
        this._windowContentsSprite.visible = this.isOpen();
    } else {
        this._windowContentsSprite.visible = false;
    }
};
Window.prototype._updateArrows = function() {
    this._downArrowSprite.visible = this.isOpen() && this.downArrowVisible;
    this._upArrowSprite.visible = this.isOpen() && this.upArrowVisible;
};
Window.prototype._updatePauseSign = function() {
    var sprite = this._windowPauseSignSprite;
    var x = Math.floor(this._animationCount / 16) % 2;
    var y = Math.floor(this._animationCount / 16 / 2) % 2;
    var sx = 144;
    var sy = 96;
    var p = 24;
    if (!this.pause) {
        sprite.alpha = 0;
    } else if (sprite.alpha < 1) {
        sprite.alpha = Math.min(sprite.alpha + 0.1, 1);
    }
    sprite.setFrame(sx+x*p, sy+y*p, p, p);
    sprite.visible = this.isOpen();
};
  const refresh = ['_refreshBack','_refreshFrame','_refreshCursor','_refreshContents','_refreshArrows','_refreshPauseSign'];
  const hooks = [...refresh, '_createAllParts', '_onWindowskinLoad', 'updateTransform', '_updateCursor', '_updateContents', '_updateArrows', '_updatePauseSign'];
  const raw = new Map(hooks.map(name => [name, Window.prototype[name]])), defaults = new Map();
  const states = new WeakMap();
  function state(window) {
    if (!states.has(window)) states.set(window, { active: false, parts: {}, signature: null });
    return states.get(window);
  }
  function activate(window) {
    const value = state(window);
    if (value.active) return;
    value.active = true; bridge.activate(window);
    window._createAllParts();
    for (const name of refresh) window[name]();
  }
  for (const name of hooks) {
    const implementation = raw.get(name);
    const method = Window.prototype[name] = function(...args) {
      if (!state(this).active) {
        if (name === '_createAllParts' && hooks.every(hook => this[hook] === defaults.get(hook))) return bridge.refresh(this);
        activate(this); return;
      }
      return implementation.apply(this, args);
    };
    defaults.set(name, method);
  }
  const nativeRefresh = bridge.refresh;
  Window.prototype._refreshAllParts = function() {
    if (!state(this).active && hooks.every(name => this[name] === defaults.get(name))) return nativeRefresh(this);
    activate(this); for (const name of refresh) this[name]();
  };
  defaults.set('_refreshAllParts', Window.prototype._refreshAllParts);
  Window.prototype._onWindowskinLoad = function() { return this._refreshAllParts(); };
  defaults.set('_onWindowskinLoad', Window.prototype._onWindowskinLoad);
  for (const name of ['_windowBackSprite','_windowFrameSprite','_windowCursorSprite','_windowContentsSprite','_windowPauseSignSprite','_downArrowSprite','_upArrowSprite']) {
    Object.defineProperty(Window.prototype, name, { configurable: true,
      get() { activate(this); return state(this).parts[name]; },
      set(value) { state(this).parts[name] = value; }
    });
  }
  Object.defineProperty(Window.prototype, '_colorTone', { configurable: true,
    get() {
      const value = state(this), thisWindow = this;
      if (!value.tone) value.tone = new Proxy([0,0,0], {
        get(target, key) { if (key === '0' || key === '1' || key === '2') return bridge.tone(thisWindow)[Number(key)]; return Reflect.get(target, key); },
        set(target, key, channel) { const tone = bridge.tone(thisWindow); tone[key] = channel; bridge.setTone(thisWindow, tone); return true; }
      });
      return value.tone;
    }, set(value) { bridge.setTone(this, value); }
  });
  Object.defineProperty(Window.prototype, '_cursorRect', { configurable: true,
    get() {
      const value = state(this), window = this;
      if (!value.cursor) {
        value.cursor = new Rectangle();
        ['x','y','width','height'].forEach((name, index) => Object.defineProperty(value.cursor, name, { configurable: true,
          get() { return bridge.cursor(window)[index]; },
          set(channel) { const rectangle = bridge.cursor(window); rectangle[index] = channel; window.setCursorRect(...rectangle); }
        }));
      }
      return value.cursor;
    }
  });
  Object.defineProperty(Window.prototype, '_windowskin', { configurable: true, get() { return this.windowskin; }, set(value) { this.windowskin = value; } });
  Window.prototype.setTone = function(r,g,b) { bridge.setTone(this, [r,g,b]); this._refreshBack(); };
  Window.prototype.addChildToBack = function(child) { return this.addChildAt(child, this.children.indexOf(this._windowSpriteContainer) + 1); };
  function prepare(window) {
    const value = state(window);
    if (!value.active && [...defaults].every(([name, method]) => window[name] === method)) return;
    activate(window);
    const rect = bridge.cursor(window), tone = bridge.tone(window);
    const signature = [window.width,window.height,window.padding,window.margin,window.windowskin,window.windowskin?.isReady(),window.origin.x,window.origin.y,...rect,...tone];
    if (!value.signature || signature.some((item, index) => item !== value.signature[index])) {
      value.signature = signature; window._refreshAllParts();
    }
    window._windowSpriteContainer.alpha = window.opacity / 255;
    window._windowBackSprite.alpha = window.backOpacity / 255;
    window._windowContentsSprite.bitmap = window.contents;
    window._windowContentsSprite.alpha = window.contentsOpacity / 255;
    window.updateTransform();
  }
  return { prepare };
})`);
  return factory(types.Window, types.Sprite, types.Bitmap, bridge);
}
module.exports = { installWindowParts };
