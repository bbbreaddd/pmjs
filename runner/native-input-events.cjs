'use strict';
// RPG Maker MV event setup: Copyright (c) 2015 KADOKAWA CORPORATION./YOJI OJIMA.
// MIT license: third_party/rpg-maker-mv.LICENSE.
function installInputEvents(runtime) {
  runtime.runScript(String.raw`(function() {
    Input.initialize = function() {
      this.clear();this._wrapNwjsAlert();this._setupEventHandlers();
    };
    Input._wrapNwjsAlert = function() {
      if(typeof window!=='undefined'&&Utils.isNwjs()) {
        var original=window.alert;
        window.alert=function() {
          var gui=require('nw.gui'),win=gui.Window.get();
          original.apply(this,arguments);win.focus();Input.clear();
        };
      }
    };
    Input._setupEventHandlers = function() {
      if(typeof document!=='undefined') {
        document.addEventListener('keydown',this._onKeyDown.bind(this));
        document.addEventListener('keyup',this._onKeyUp.bind(this));
      }
      if(typeof window!=='undefined'&&typeof window.addEventListener==='function')window.addEventListener('blur',this._onLostFocus.bind(this));
    };
    TouchInput.initialize = function() {this.clear();this._setupEventHandlers();};
    TouchInput._setupEventHandlers = function() {
      if(typeof document==='undefined')return;
      var passive=Utils.isSupportPassiveEvent();
      for(var pair of [['mousedown','_onMouseDown'],['mousemove','_onMouseMove'],['mouseup','_onMouseUp'],
        ['wheel','_onWheel'],['touchstart','_onTouchStart'],['touchmove','_onTouchMove'],
        ['touchend','_onTouchEnd'],['touchcancel','_onTouchCancel'],['pointerdown','_onPointerDown']]) {
        document.addEventListener(pair[0],this[pair[1]].bind(this),
          passive&&(pair[0]==='touchstart'||pair[0]==='touchmove')?{passive:false}:false);
      }
    };
TouchInput.clear = function() {
    this._mousePressed = false;
    this._screenPressed = false;
    this._pressedTime = 0;
    this._events = {};
    this._events.triggered = false;
    this._events.cancelled = false;
    this._events.moved = false;
    this._events.released = false;
    this._events.wheelX = 0;
    this._events.wheelY = 0;
    this._triggered = false;
    this._cancelled = false;
    this._moved = false;
    this._released = false;
    this._wheelX = 0;
    this._wheelY = 0;
    this._x = 0;
    this._y = 0;
    this._date = 0;
};

/**
 * Updates the touch data.
 *
 * @static
 * @method update
 */
TouchInput.update = function() {
    this._triggered = this._events.triggered;
    this._cancelled = this._events.cancelled;
    this._moved = this._events.moved;
    this._released = this._events.released;
    this._wheelX = this._events.wheelX;
    this._wheelY = this._events.wheelY;
    this._events.triggered = false;
    this._events.cancelled = false;
    this._events.moved = false;
    this._events.released = false;
    this._events.wheelX = 0;
    this._events.wheelY = 0;
    if (this.isPressed()) {
        this._pressedTime++;
    }
};

TouchInput._onMouseDown = function(event) {
    if (event.button === 0) {
        this._onLeftButtonDown(event);
    } else if (event.button === 1) {
        this._onMiddleButtonDown(event);
    } else if (event.button === 2) {
        this._onRightButtonDown(event);
    }
};

/**
 * @static
 * @method _onLeftButtonDown
 * @param {MouseEvent} event
 * @private
 */
TouchInput._onLeftButtonDown = function(event) {
    var x = Graphics.pageToCanvasX(event.pageX);
    var y = Graphics.pageToCanvasY(event.pageY);
    if (Graphics.isInsideCanvas(x, y)) {
        this._mousePressed = true;
        this._pressedTime = 0;
        this._onTrigger(x, y);
    }
};

/**
 * @static
 * @method _onMiddleButtonDown
 * @param {MouseEvent} event
 * @private
 */
TouchInput._onMiddleButtonDown = function(event) {
};

/**
 * @static
 * @method _onRightButtonDown
 * @param {MouseEvent} event
 * @private
 */
TouchInput._onRightButtonDown = function(event) {
    var x = Graphics.pageToCanvasX(event.pageX);
    var y = Graphics.pageToCanvasY(event.pageY);
    if (Graphics.isInsideCanvas(x, y)) {
        this._onCancel(x, y);
    }
};

/**
 * @static
 * @method _onMouseMove
 * @param {MouseEvent} event
 * @private
 */
TouchInput._onMouseMove = function(event) {
    if (this._mousePressed) {
        var x = Graphics.pageToCanvasX(event.pageX);
        var y = Graphics.pageToCanvasY(event.pageY);
        this._onMove(x, y);
    }
};

/**
 * @static
 * @method _onMouseUp
 * @param {MouseEvent} event
 * @private
 */
TouchInput._onMouseUp = function(event) {
    if (event.button === 0) {
        var x = Graphics.pageToCanvasX(event.pageX);
        var y = Graphics.pageToCanvasY(event.pageY);
        this._mousePressed = false;
        this._onRelease(x, y);
    }
};

/**
 * @static
 * @method _onWheel
 * @param {WheelEvent} event
 * @private
 */
TouchInput._onWheel = function(event) {
    this._events.wheelX += event.deltaX;
    this._events.wheelY += event.deltaY;
    event.preventDefault();
};

/**
 * @static
 * @method _onTouchStart
 * @param {TouchEvent} event
 * @private
 */
TouchInput._onTouchStart = function(event) {
    for (var i = 0; i < event.changedTouches.length; i++) {
        var touch = event.changedTouches[i];
        var x = Graphics.pageToCanvasX(touch.pageX);
        var y = Graphics.pageToCanvasY(touch.pageY);
        if (Graphics.isInsideCanvas(x, y)) {
            this._screenPressed = true;
            this._pressedTime = 0;
            if (event.touches.length >= 2) {
                this._onCancel(x, y);
            } else {
                this._onTrigger(x, y);
            }
            event.preventDefault();
        }
    }
    if (typeof window !== 'undefined' && (window.cordova || window.navigator.standalone)) {
        event.preventDefault();
    }
};

/**
 * @static
 * @method _onTouchMove
 * @param {TouchEvent} event
 * @private
 */
TouchInput._onTouchMove = function(event) {
    for (var i = 0; i < event.changedTouches.length; i++) {
        var touch = event.changedTouches[i];
        var x = Graphics.pageToCanvasX(touch.pageX);
        var y = Graphics.pageToCanvasY(touch.pageY);
        this._onMove(x, y);
    }
};

/**
 * @static
 * @method _onTouchEnd
 * @param {TouchEvent} event
 * @private
 */
TouchInput._onTouchEnd = function(event) {
    for (var i = 0; i < event.changedTouches.length; i++) {
        var touch = event.changedTouches[i];
        var x = Graphics.pageToCanvasX(touch.pageX);
        var y = Graphics.pageToCanvasY(touch.pageY);
        this._screenPressed = false;
        this._onRelease(x, y);
    }
};

/**
 * @static
 * @method _onTouchCancel
 * @param {TouchEvent} event
 * @private
 */
TouchInput._onTouchCancel = function(event) {
    this._screenPressed = false;
};

/**
 * @static
 * @method _onPointerDown
 * @param {PointerEvent} event
 * @private
 */
TouchInput._onPointerDown = function(event) {
    if (event.pointerType === 'touch' && !event.isPrimary) {
        var x = Graphics.pageToCanvasX(event.pageX);
        var y = Graphics.pageToCanvasY(event.pageY);
        if (Graphics.isInsideCanvas(x, y)) {
            // For Microsoft Edge
            this._onCancel(x, y);
            event.preventDefault();
        }
    }
};

/**
 * @static
 * @method _onTrigger
 * @param {Number} x
 * @param {Number} y
 * @private
 */
TouchInput._onTrigger = function(x, y) {
    this._events.triggered = true;
    this._x = x;
    this._y = y;
    this._date = Date.now();
};

/**
 * @static
 * @method _onCancel
 * @param {Number} x
 * @param {Number} y
 * @private
 */
TouchInput._onCancel = function(x, y) {
    this._events.cancelled = true;
    this._x = x;
    this._y = y;
};

/**
 * @static
 * @method _onMove
 * @param {Number} x
 * @param {Number} y
 * @private
 */
TouchInput._onMove = function(x, y) {
    this._events.moved = true;
    this._x = x;
    this._y = y;
};

/**
 * @static
 * @method _onRelease
 * @param {Number} x
 * @param {Number} y
 * @private
 */
TouchInput._onRelease = function(x, y) {
    this._events.released = true;
    this._x = x;
    this._y = y;
};
  })()`);
}
module.exports={installInputEvents};
