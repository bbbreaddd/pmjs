'use strict';
// RPG Maker MV behavior: Copyright (c) 2015 KADOKAWA CORPORATION./YOJI OJIMA.
// MIT license: third_party/rpg-maker-mv.LICENSE.

function installWindowTouch(Window_Selectable, options, usesNativeInput) {
  Window_Selectable.prototype.processTouch = function() {
      if (usesNativeInput(this)) return;
      if (this.isOpenAndActive()) {
          if (options.touchInput().isTriggered() && this.isTouchedInsideFrame()) {
              this._touching = true;
              this.onTouch(true);
          } else if (options.touchInput().isCancelled()) {
              if (this.isCancelEnabled()) {
                  this.processCancel();
              }
          }
          if (this._touching) {
              if (options.touchInput().isPressed()) {
                  this.onTouch(false);
              } else {
                  this._touching = false;
              }
          }
      } else {
          this._touching = false;
      }
  };

  Window_Selectable.prototype.isTouchedInsideFrame = function() {
      var x = this.canvasToLocalX(options.touchInput().x);
      var y = this.canvasToLocalY(options.touchInput().y);
      return x >= 0 && y >= 0 && x < this.width && y < this.height;
  };

  Window_Selectable.prototype.onTouch = function(triggered) {
      var lastIndex = this.index();
      var x = this.canvasToLocalX(options.touchInput().x);
      var y = this.canvasToLocalY(options.touchInput().y);
      var hitIndex = this.hitTest(x, y);
      if (hitIndex >= 0) {
          if (hitIndex === this.index()) {
              if (triggered && this.isTouchOkEnabled()) {
                  this.processOk();
              }
          } else if (this.isCursorMovable()) {
              this.select(hitIndex);
          }
      } else if (this._stayCount >= 10) {
          if (y < this.padding) {
              this.cursorUp();
          } else if (y >= this.height - this.padding) {
              this.cursorDown();
          }
      }
      if (this.index() !== lastIndex) {
          options.soundManager().playCursor();
      }
  };

  Window_Selectable.prototype.hitTest = function(x, y) {
      if (this.isContentsArea(x, y)) {
          var cx = x - this.padding;
          var cy = y - this.padding;
          var topIndex = this.topIndex();
          for (var i = 0; i < this.maxPageItems(); i++) {
              var index = topIndex + i;
              if (index < this.maxItems()) {
                  var rect = this.itemRect(index);
                  var right = rect.x + rect.width;
                  var bottom = rect.y + rect.height;
                  if (cx >= rect.x && cy >= rect.y && cx < right && cy < bottom) {
                      return index;
                  }
              }
          }
      }
      return -1;
  };

  Window_Selectable.prototype.isContentsArea = function(x, y) {
      var left = this.padding;
      var top = this.padding;
      var right = this.width - this.padding;
      var bottom = this.height - this.padding;
      return (x >= left && y >= top && x < right && y < bottom);
  };

  Window_Selectable.prototype.isTouchOkEnabled = function() {
      return this.isOkEnabled();
  };
}

module.exports = { installWindowTouch };
