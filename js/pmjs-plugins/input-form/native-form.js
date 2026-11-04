'use strict';

(function() {
  PMJS.plugins.onLoaded('111_InputForm', 'pmjs.input-form.native', function() {
    if (typeof Window_NameInput !== 'function' || typeof Window_Base !== 'function' ||
        !globalThis.Utils || Utils.RPGMAKER_NAME !== 'MV') return;
    var original = Game_Interpreter.prototype._inputForm;
    if (typeof original !== 'function') return;
    var source = NativeHost.fs.readText('js/plugins/111_InputForm.js');
    if (!globalThis.__pmjsBuiltinRequire || !source ||
        !PMJS.methods.matchesText(source, 'e634bc2553aeb8bb2af7ba2877f09ec3822b1f218b5645849d402a2d0948c43a')) {
      PMJS.compat.hit('plugins.input-form.native', 'unrecognized input form implementation');
      return;
    }
    var active = null;

    function Scene_InputForm() { this.initialize.apply(this, arguments); }
    Scene_InputForm.prototype = Object.create(Scene_Base.prototype);
    Scene_InputForm.prototype.constructor = Scene_InputForm;
    Scene_InputForm.prototype.create = function() {
      Scene_Base.prototype.create.call(this);
      this._form = active;
      this._background = new Sprite(SceneManager.backgroundBitmap());
      this.addChild(this._background);
      this.createWindowLayer();
      var form = this._form, input = form.input;
      var width = Math.min(Graphics.boxWidth, Math.max(360, form.fontSize * 15 + 36));
      function EditWindow() { this.initialize.apply(this, arguments); }
      EditWindow.prototype = Object.create(Window_Base.prototype);
      EditWindow.prototype.constructor = EditWindow;
      EditWindow.prototype.standardFontSize = function() { return form.fontSize; };
      EditWindow.prototype.standardPadding = function() { return 12; };
      EditWindow.prototype.lineHeight = function() { return form.fontSize + 4; };
      var edit = new EditWindow(form.x, form.y, width, form.fontSize + 28);
      edit.name = function() { return input.value; };
      edit.restoreDefault = function() { return false; };
      edit.add = function(text) {
        var before = input.value; input._insertText(text); return input.value !== before;
      };
      edit.back = function() {
        var before = input.value; input._editKey({ keyCode: 8 }); return input.value !== before;
      };
      edit.refresh = function() {
        this.contents.clear(); this.resetFontSettings();
        this.drawText(input.value, 0, 0, this.contentsWidth());
        var cursorX = this.textWidth(input.value.slice(0, input.selectionStart));
        this.setCursorRect(Math.min(cursorX, this.contentsWidth() - 2), 0, 2, this.lineHeight());
      };
      this._edit = edit;
      function FormKeyboard() { this.initialize.apply(this, arguments); }
      var roomBelow = Graphics.boxHeight - form.y - Math.max(edit.height, form.buttonY + form.fontSize + 28) - 8;
      var keyboardRoom = roomBelow >= 168 ? roomBelow : Math.max(roomBelow, form.y - 8);
      var keyboardFontSize = Math.max(12, Math.min(24, form.fontSize, Math.floor((keyboardRoom - 24) / 9) - 4));
      FormKeyboard.prototype = Object.create(Window_NameInput.prototype);
      FormKeyboard.prototype.constructor = FormKeyboard;
      FormKeyboard.prototype.standardFontSize = function() { return keyboardFontSize; };
      FormKeyboard.prototype.standardPadding = function() { return 12; };
      FormKeyboard.prototype.lineHeight = function() { return this.standardFontSize() + 4; };
      FormKeyboard.prototype.itemRect = function(index) {
        var column = index % 10;
        var cellWidth = (this.contentsWidth() - 12) / 10;
        return { x: column * cellWidth + (column >= 5 ? 12 : 0),
          y: Math.floor(index / 10) * this.lineHeight(), width: cellWidth, height: this.lineHeight() };
      };
      // The form has no authored character grid. Offer the portable Latin tables;
      // committed keyboard text can still contain any Unicode characters.
      FormKeyboard.prototype.table = function() { return [Window_NameInput.LATIN1, Window_NameInput.LATIN2]; };
      var keyboard = new FormKeyboard(edit);
      keyboard.onNameOk = function() { form.submit(); };
      this._keyboard = keyboard;
      this.addWindow(edit); this.addWindow(keyboard);
      function SubmitWindow() { this.initialize.apply(this, arguments); }
      SubmitWindow.prototype = Object.create(Window_Command.prototype);
      SubmitWindow.prototype.constructor = SubmitWindow;
      SubmitWindow.prototype.windowWidth = function() { return Math.max(96, form.fontSize * 5); };
      SubmitWindow.prototype.standardFontSize = function() { return form.fontSize; };
      SubmitWindow.prototype.standardPadding = function() { return 12; };
      SubmitWindow.prototype.lineHeight = function() { return form.fontSize + 4; };
      SubmitWindow.prototype.makeCommandList = function() { this.addCommand('Enter', 'submit'); };
      this._submit = new SubmitWindow(form.x + form.buttonX, form.y + form.buttonY);
      this._submit.deactivate();
      this.addWindow(this._submit);
      edit.refresh();
    };
    Scene_InputForm.prototype.update = function() {
      var form = this._form;
      if (!form || !form.input.isConnected) {
        if (!this._leaving) { this._leaving = true; SceneManager.pop(); }
        return;
      }
      // Keyboard text belongs to the focused field; controller input belongs to
      // the character grid. The suspended scene cannot consume either.
      Scene_Base.prototype.update.call(this);
      var edit = this._edit, keyboard = this._keyboard;
      edit.x = Math.max(0, Math.min(form.x, Graphics.boxWidth - edit.width));
      edit.y = Math.max(0, Math.min(form.y, Graphics.boxHeight - edit.height));
      keyboard.x = edit.x;
      var button = this._submit;
      button.x = Math.max(0, Math.min(form.x + form.buttonX, Graphics.boxWidth - button.width));
      button.y = Math.max(0, Math.min(form.y + form.buttonY, Graphics.boxHeight - button.height));
      var below = Math.max(edit.y + edit.height, button.y + button.height) + 8;
      keyboard.y = below + keyboard.height <= Graphics.boxHeight ? below : Math.max(0, Math.min(edit.y, button.y) - keyboard.height - 8);
      if (TouchInput.isTriggered() && TouchInput.x >= button.x && TouchInput.x < button.x + button.width &&
          TouchInput.y >= button.y && TouchInput.y < button.y + button.height) form.submit();
      var editKey = form.input.value + ':' + form.input.selectionStart;
      if (editKey !== this._editKey) { this._editKey = editKey; edit.refresh(); }
    };
    Scene_InputForm.prototype.terminate = function() {
      try { if (this._form) this._form.submit(); }
      finally { Scene_Base.prototype.terminate.call(this); }
    };

    Game_Interpreter.prototype._inputForm = function(x, y, variable, maximum, forcedSwitch,
        buttonX, buttonY, fontSize, placeholder) {
      if (active) active.submit();
      original.apply(this, arguments);
      var input = document.getElementById('_111_input');
      var button = document.getElementById('_111_submit');
      if (!input || !button) throw new Error('Input form did not create its controls');
      var interpreter = this;
      var removeStopListener;
      var form = { input: input, x: Number(x) || 0, y: Number(y) || 0,
        buttonX: Number(buttonX) || 0, buttonY: Number(buttonY) || 0,
        fontSize: Math.max(1, Number(fontSize) || 24),
        submit: function() {
          if (input.isConnected) button.dispatchEvent({ type: 'click', target: button });
          if (removeStopListener) { removeStopListener(); removeStopListener = null; }
          if (interpreter._waitMode === 'input_form') interpreter.setWaitMode('');
          Input.form_mode = false;
          Input.clear();
          if (active === form) active = null;
        } };
      active = form;
      // Ordinary text keys must not also select grid characters via the engine's
      // letter-to-action mapper. The original Enter handler still submits.
      function keepEditingKeys(event) {
        if (event.keyCode < 112 || event.keyCode > 123) event.stopPropagation();
      }
      input.addEventListener('keydown', keepEditingKeys);
      input.addEventListener('keyup', keepEditingKeys);
      if (PMJS.tasks && PMJS.tasks.onStop) removeStopListener = PMJS.tasks.onStop(form.submit);
      try {
        SceneManager.snapForBackground();
        SceneManager.push(Scene_InputForm);
      } catch (error) { form.submit(); throw error; }
    };
  });
})();
