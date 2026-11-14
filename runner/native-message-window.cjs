'use strict';
// RPG Maker MV behavior: Copyright (c) 2015 KADOKAWA CORPORATION./YOJI OJIMA.
// MIT license: third_party/rpg-maker-mv.LICENSE.

function installMessageWindow({ Window_Message, ImageManager, Input }, options) {
  Window_Message.prototype.updateLoading = function() {
      if (this._faceBitmap) {
          if (this._faceBitmap.isReady()) {
              this.drawMessageFace();
              this._faceBitmap = null;
              return false;
          } else {
              return true;
          }
      } else {
          return false;
      }
  };
  
  Window_Message.prototype.updateMessage = function() {
      if (this._textState) {
          while (!this.isEndOfText(this._textState)) {
              if (this.needsNewPage(this._textState)) {
                  this.newPage(this._textState);
              }
              this.updateShowFast();
              this.processCharacter(this._textState);
              if (!this._showFast && !this._lineShowFast) {
                  break;
              }
              if (this.pause || this._waitCount > 0) {
                  break;
              }
          }
          if (this.isEndOfText(this._textState)) {
              this.onEndOfText();
          }
          return true;
      } else {
          return false;
      }
  };

  Window_Message.prototype.startMessage = function() {
      this._textState = {};
      this._textState.index = 0;
      this._textState.text = this.convertEscapeCharacters(options.gameMessage().allText());
      this.newPage(this._textState);
      this.updatePlacement();
      this.updateBackground();
      this.open();
  };

  Window_Message.prototype.updateBackground = function() {
      this._background = options.gameMessage().background();
      this.setBackgroundType(this._background);
  };

  Window_Message.prototype.updateWait = function() {
      if (this._waitCount > 0) {
          this._waitCount--;
          return true;
      } else {
          return false;
      }
  };

  Window_Message.prototype.updateInput = function() {
      if (this.isAnySubWindowActive()) {
          return true;
      }
      if (this.pause) {
          if (this.isTriggered()) {
              Input.update();
              this.pause = false;
              if (!this._textState) {
                  this.terminateMessage();
              }
          }
          return true;
      }
      return false;
  };

  Window_Message.prototype.isAnySubWindowActive = function() {
      return (this._choiceWindow.active ||
              this._numberWindow.active ||
              this._itemWindow.active);
  };

  Window_Message.prototype.onEndOfText = function() {
      if (!this.startInput()) {
          if (!this._pauseSkip) {
              this.startPause();
          } else {
              this.terminateMessage();
          }
      }
      this._textState = null;
  };

  Window_Message.prototype.isTriggered = function() {
      return (Input.isRepeated('ok') || Input.isRepeated('cancel') ||
              options.touchInput().isRepeated());
  };

  Window_Message.prototype.doesContinue = function() {
      return (options.gameMessage().hasText() && !options.gameMessage().scrollMode() &&
              !this.areSettingsChanged());
  };

  Window_Message.prototype.areSettingsChanged = function() {
      return (this._background !== options.gameMessage().background() ||
              this._positionType !== options.gameMessage().positionType());
  };

  Window_Message.prototype.updateShowFast = function() {
      if (this.isTriggered()) {
          this._showFast = true;
      }
  };

  Window_Message.prototype.newPage = function(textState) {
      this.contents.clear();
      this.resetFontSettings();
      this.clearFlags();
      this.loadMessageFace();
      textState.x = this.newLineX();
      textState.y = 0;
      textState.left = this.newLineX();
      textState.height = this.calcTextHeight(textState, false);
  };

  Window_Message.prototype.loadMessageFace = function() {
      this._faceBitmap = ImageManager.reserveFace(options.gameMessage().faceName(), 0, this._imageReservationId);
  };

  Window_Message.prototype.drawMessageFace = function() {
      this.drawFace(options.gameMessage().faceName(), options.gameMessage().faceIndex(), 0, 0);
      ImageManager.releaseReservation(this._imageReservationId);
  };

  Window_Message.prototype.newLineX = function() {
      return options.gameMessage().faceName() === '' ? 0 : 168;
  };

  Window_Message.prototype.isEndOfText = function(textState) {
      return textState.index >= textState.text.length;
  };

  Window_Message.prototype.needsNewPage = function(textState) {
      return (!this.isEndOfText(textState) &&
              textState.y + textState.height > this.contents.height);
  };

  Window_Message.prototype.startWait = function(count) {
      this._waitCount = count;
  };

  Window_Message.prototype.startPause = function() {
      this.startWait(10);
      this.pause = true;
  };
}

module.exports = { installMessageWindow };
