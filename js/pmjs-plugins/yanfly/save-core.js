'use strict';

PMJS.plugins.onLoaded('YEP_SaveCore', 'pmjs.adapter.save-core', function() {
  var pending = new WeakMap();
  function cancelPreviews(window) {
    var requests = window && pending.get(window);
    if (!requests) return;
    requests.forEach(function(request) { clearTimeout(request.timer); });
    requests.clear();
    pending.delete(window);
  }
  function previewBitmap(name, args) {
    if (name === 'drawCharacter') return ImageManager.loadCharacter(args[0]);
    if (name === 'drawFace') return ImageManager.loadFace(args[0]);
    return ImageManager.loadSvActor(args[0].battlerName());
  }

  ['updateIndex', 'refresh'].forEach(function(name) {
    var original = Window_SaveInfo.prototype[name];
    if (typeof original !== 'function') return;
    Window_SaveInfo.prototype[name] = function() {
      cancelPreviews(this);
      if (name !== 'refresh') return original.apply(this, arguments);
      try {
        return original.apply(this, arguments);
      } catch (error) {
        cancelPreviews(this);
        this._saveContents = null;
        console.warn('[pmjs] save preview failed for slot ' + this.savefileId() + ': ' + error.message);
        this.contents.clear();
        this.resetFontSettings();
        return this.drawInvalidText(this.drawGameTitle(0));
      }
    };
  });

  ['drawCharacter', 'drawFace', 'drawSvActor'].forEach(function(name) {
    var original = Window_SaveInfo.prototype[name];
    if (typeof original !== 'function') return;
    Window_SaveInfo.prototype[name] = function() {
      var window = this, args = arguments;
      var bitmap = previewBitmap(name, args);
      if (bitmap.width > 0) return original.apply(window, args);
      var scene = SceneManager._scene, parent = window.parent, contents = window.contents;
      if (!scene || !parent || !contents || bitmap.isError && bitmap.isError()) return;
      var slot = window.savefileId(), requests = pending.get(window);
      if (!requests) { requests = new Set(); pending.set(window, requests); }
      var request = { timer: null, attempts: 0 };
      requests.add(request);
      function retry() {
        if (!requests.has(request)) return;
        requests.delete(request);
        if (SceneManager._scene !== scene || SceneManager.isSceneChanging() ||
            window.parent !== parent || window.contents !== contents ||
            window.savefileId() !== slot) return;
        // Completion can evict the old image before this callback runs.
        bitmap = previewBitmap(name, args);
        if (bitmap.isError && bitmap.isError()) return;
        if (bitmap.width > 0) return original.apply(window, args);
        // Each party image owns its budget; another image cannot reset it.
        if (++request.attempts >= 60) {
          console.warn('[pmjs] save preview image retry limit reached');
          return;
        }
        requests.add(request);
        request.timer = setTimeout(retry, 50);
      }
      request.timer = setTimeout(retry, 50);
    };
  });

  if (PMJS.methods.matchesSource(Window_SaveInfo.prototype.drawContents,
      '4a5dc3341613ba4b9132bb00b060859521cf26b4de5a194b1926db0da5f78e23')) {
    Window_SaveInfo.prototype.drawContents = function(y) {
      // StorageManager.load is synchronous: absent contents cannot complete later.
      if (!this._saveContents) return this.drawInvalidText(y);
      if (typeof this._saveContents === 'string') {
        this._saveContents = JsonEx.parse(this._saveContents);
      }
      y = this.drawPartyGraphics(y);
      y = this.drawPartyNames(y);
      y = this.drawPartyLevels(y);
      return this.drawColumnData(y);
    };
  } else {
    PMJS.compat.hit('plugins.yanfly.save-core.draw-contents', 'unrecognized Window_SaveInfo.drawContents');
  }

  var proto = Scene_File.prototype;
  if (PMJS.methods.matchesSource(proto.onConfirmOk,
      'ca2ff7296b178a4f9ec2d63d6a98eb432f1973321049d0d18be5258b40b1153d')) {
    proto.onConfirmOk = function() {
      this._confirmWindow.deactivate();
      this._confirmWindow.close();
      clearTimeout(this._pmjsSaveActionTimer);
      var symbol = this._actionWindow.currentSymbol();
      var method = { load: 'performActionLoad', save: 'performActionSave',
        delete: 'performActionDelete' }[symbol];
      if (!method) return this.onConfirmCancel();
      var scene = this, id = this.savefileId(), action = this[method];
      var request = this._pmjsSaveActionRequest = {};
      this._pmjsSaveActionTimer = setTimeout(function() {
        if (scene._pmjsSaveActionRequest !== request || SceneManager._scene !== scene ||
            SceneManager.isSceneChanging()) return;
        scene._pmjsSaveActionTimer = null;
        scene._pmjsSaveActionRequest = null;
        // A changed selection cancels confirmation instead of acting on another slot.
        if (scene.savefileId() !== id || scene._actionWindow.currentSymbol() !== symbol) {
          return scene.onActionCancel();
        }
        return action.call(scene);
      }, 200);
    };
  } else {
    PMJS.compat.hit('plugins.yanfly.save-core.confirm', 'unrecognized Scene_File.onConfirmOk');
  }
  ['onConfirmCancel', 'onActionCancel', 'terminate'].forEach(function(name) {
    var original = proto[name];
    proto[name] = function() {
      if (name === 'terminate') cancelPreviews(this._infoWindow);
      clearTimeout(this._pmjsSaveActionTimer);
      this._pmjsSaveActionTimer = null;
      this._pmjsSaveActionRequest = null;
      return original.apply(this, arguments);
    };
  });
});
