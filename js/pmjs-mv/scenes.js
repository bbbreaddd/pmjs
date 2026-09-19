Utils.isNwjs = function() { return false; };
Utils.canReadGameFiles = function() { return true; };
if (typeof SceneManager !== 'undefined' && !SceneManager._pmjsFullPatched) {
  SceneManager.isFocus = function() { return true; };
  if (globalThis.PMJS_DEVELOPMENT_MODE ||
      (typeof pmjsGameConfig !== 'undefined' && pmjsGameConfig.developmentMode)) {
    SceneManager.catchException = function(error) { throw error; };
  }
  if (!SceneManager.ticker && typeof PIXI !== 'undefined' && PIXI.ticker &&
      typeof PIXI.ticker.Ticker === 'function') {
    SceneManager.ticker = new PIXI.ticker.Ticker();
    SceneManager.ticker.autoStart = false;
    SceneManager.ticker.stop();
    SceneManager.ticker._pmjsHostDriven = true;
  }
  function pmjsSceneName(scene) {
    if (!scene) return '';
    if (typeof scene === 'function') return scene.name || '';
    return scene.constructor && scene.constructor.name || '';
  }
  function isTitleScene(scene) {
    var name = pmjsSceneName(scene);
    if (name === 'Scene_Title') return true;
    return (pmjsGameConfig.titleSceneNames || []).indexOf(name) !== -1;
  }
  function isMajorSceneTransition(sceneClass) {
    var name = pmjsSceneName(sceneClass);
    return name === 'Scene_Map' || name === 'Scene_Battle' ||
           name === 'Scene_Gameover' || name === 'Scene_Boot' ||
           isTitleScene(sceneClass);
  }
  SceneManager.isMajorScene = isMajorSceneTransition;
  // Retention must not change MV's constructor-based scene stack.
  try {
    function pmjsDisposeRetainedTitle(manager) {
      try {
        if (manager && manager._pmjsRetainedTitle) {
          var title = manager._pmjsRetainedTitle;
          manager._pmjsRetainedTitle = null;
          title._pmjsSuspended = false;
          title._pmjsWaking = false;
          if (typeof title.terminate === 'function') title.terminate();
          if (typeof title.detachReservation === 'function') title.detachReservation();
        }
      } catch (_) {}
    }

    function pmjsStackContainsRetainedScene(manager, retained) {
      return !!(retained && manager && manager._stack &&
        manager._stack.indexOf(retained.constructor) !== -1);
    }

    function pmjsValidateRetainedSceneResume(manager, retained) {
      if (!retained || typeof retained !== 'object') return false;
      if (typeof Scene_Map !== 'undefined' && retained instanceof Scene_Map) {
        if (retained._transfer && typeof $gamePlayer !== 'undefined' &&
            $gamePlayer && typeof $gamePlayer.isTransferring === 'function' &&
            !$gamePlayer.isTransferring()) {
          try {
            if (typeof nativeCompatibilityHit === 'function') {
              nativeCompatibilityHit('scene.resume.stale_transfer',
                'map=' + (typeof $gameMap !== 'undefined' && $gameMap && typeof $gameMap.mapId === 'function' ? $gameMap.mapId() : 0));
            }
          } catch (_) {}
          return false;
        }
      }
      return true;
    }

    var _origGoto = SceneManager.goto;
    SceneManager.goto = function(sceneClass) {
      // A submenu push delegates through goto after placing the retained map's
      // constructor on the stack. Preserve that instance until the matching
      // pop; only a transition with no retained stack entry invalidates it.
      try {
        var retained = this._pmjsRetainedScene || this._pmjsRetainedMap;
        if (!pmjsStackContainsRetainedScene(this, retained) &&
            sceneClass !== (retained && retained.constructor)) {
          this._pmjsRetainedScene = null;
          this._pmjsRetainedMap = null;
        }
        pmjsDisposeRetainedTitle(this);
      } catch (_) {}
      var ret = _origGoto.apply(this, arguments);
      // Collect only after major transitions that do not retain a scene.
      try {
        if (!this._nextSceneSame && this._stack.length === 0 && !this._isReturningFromMenu &&
            !SceneManager._pmjsCompatibilityGc && isMajorSceneTransition(sceneClass) &&
            typeof NativeHost !== 'undefined' && NativeHost.runtime && NativeHost.runtime.collectGarbage) {
          NativeHost.runtime.collectGarbage();
          if (typeof Graphics !== 'undefined' && Graphics.endLoading) Graphics.endLoading();
        }
      } catch (_) {}
      return ret;
    };

    if (typeof SceneManager.clearStack === 'function') {
      var _origClearStack = SceneManager.clearStack;
      SceneManager.clearStack = function() {
        this._pmjsRetainedScene = null;
        this._pmjsRetainedMap = null;
        pmjsDisposeRetainedTitle(this);
        return _origClearStack.apply(this, arguments);
      };
    }

    // Menu pushes may retain a started map or configured title scene. Other
    // transitions keep MV's constructor-based stack behavior.
    function pmjsRetainableMenuPush(manager, sceneClass) {
      try {
        if (typeof sceneClass !== 'function') return null;
        if (!manager._sceneStarted) return null;
        var cur = manager._scene;
        if (!cur) return null;

        if (typeof Scene_Map !== 'undefined' && cur instanceof Scene_Map) {
          if (typeof Scene_Battle !== 'undefined' &&
              (sceneClass === Scene_Battle || sceneClass.prototype instanceof Scene_Battle)) return null;
          if (sceneClass === Scene_Map || sceneClass.prototype instanceof Scene_Map) return null;
          return 'map';
        }

        if (isTitleScene(cur)) {
          if (typeof Scene_Map !== 'undefined' && (sceneClass === Scene_Map || sceneClass.prototype instanceof Scene_Map)) return null;
          if (typeof Scene_Battle !== 'undefined' && (sceneClass === Scene_Battle || sceneClass.prototype instanceof Scene_Battle)) return null;
          if (isTitleScene(sceneClass)) return null;
          return 'title';
        }

        return null;
      } catch (_) { return null; }
    }
    var _origPush = SceneManager.push;
    SceneManager.push = function(sceneClass) {
      // Decide before push delegates through goto, then record the retained scene.
      var outgoing = null;
      var retainMode = null;
      try {
        outgoing = this._scene;
        retainMode = pmjsRetainableMenuPush(this, sceneClass);
      } catch (_) { retainMode = null; }
      var ret;
      try {
        ret = _origPush.apply(this, arguments);
      } catch (pushError) {
        try {
          this._pmjsRetainedScene = null;
          this._pmjsRetainedMap = null;
          this._pmjsRetainedTitle = null;
        } catch (_) {}
        throw pushError;
      }
      try {
        if (retainMode === 'title' && outgoing) {
          outgoing._pmjsSuspended = true;
          this._pmjsRetainedTitle = outgoing;
          this._pmjsRetainedScene = null;
          this._pmjsRetainedMap = null;
        } else if (retainMode === 'map' && outgoing) {
          outgoing.reused = true;
          this._pmjsRetainedScene = outgoing;
          this._pmjsRetainedMap = outgoing;
          this._pmjsRetainedTitle = null;
        } else {
          var retained = this._pmjsRetainedScene || this._pmjsRetainedMap;
          if (!pmjsStackContainsRetainedScene(this, retained)) {
            this._pmjsRetainedScene = null;
            this._pmjsRetainedMap = null;
          }
          this._pmjsRetainedTitle = null;
        }
      } catch (_) {}
      return ret;
    };
    var _origPop = SceneManager.pop;
    SceneManager.pop = function() {
      this._isReturningFromMenu = true;
      try {
        if (this._pmjsRetainedTitle && this._stack.length > 0 &&
            this._stack[this._stack.length - 1] === this._pmjsRetainedTitle.constructor) {
          var title = this._pmjsRetainedTitle;
          this._pmjsRetainedTitle = null;
          this._stack.pop();
          title._pmjsWaking = true;
          title._pmjsSuspended = false;
          if (this._scene) { try { this._scene.stop(); } catch (_) {} }
          this._nextScene = title;
          this._nextSceneSame = true;
          return;
        }

        var retained = this._pmjsRetainedScene || this._pmjsRetainedMap;
        if (this._stack.length > 0 && retained &&
            this._stack[this._stack.length - 1] === retained.constructor) {
          if (!pmjsValidateRetainedSceneResume(this, retained)) {
            this._pmjsRetainedScene = null;
            this._pmjsRetainedMap = null;
            return _origPop.apply(this, arguments);
          }
          this._pmjsRetainedScene = null;
          this._pmjsRetainedMap = null;
          this._stack.pop();
          retained.reused = true;
          if (typeof Scene_Map !== 'undefined' && retained instanceof Scene_Map) {
            retained._transfer = false;
          }
          if (this._scene) { try { this._scene.stop(); } catch (_) {} }
          this._nextScene = retained;
          this._nextSceneSame = true;
          return;
        }
      } catch (_) {}
      var r = _origPop.apply(this, arguments);
      // Preserve the empty-pop diagnostic without changing MV's result.
      try {
        if (this._stack.length === 0 && this._scene === null && typeof NativeHost !== 'undefined' && NativeHost.runtime && NativeHost.runtime.quit) {
          nativeCompatibilityHit('scene.exit', 'pop empty');
        }
      } catch (_) {}
      return r;
    };
    // Scene replacement must account for retained map and title instances.
    SceneManager.changeScene = function() {
      if (this.isSceneChanging() && !this.isCurrentSceneBusy()) {
        if (this._scene) {
          if (this._scene._pmjsSuspended) {
            // A suspended title remains live and must not be terminated or detached.
          } else if (this._scene.reused) {
            // A retained map stays attached to its resources for the return path.
            try { SceneManager.snapForBackground(); } catch (_) {}
          } else {
            this._scene.terminate();
            if (this._scene.detachReservation) this._scene.detachReservation();
          }
          this._previousClass = this._scene.constructor;
        }
        this._scene = this._nextScene;
        if (this._scene) {
          if (this._scene._pmjsWaking) {
            // A suspended title has already completed creation and readiness.
            this._scene._pmjsWaking = false;
            this._scene._pmjsSuspended = false;
            if (this._scene.attachReservation) this._scene.attachReservation();
            this._nextScene = null;
            this._sceneStarted = true;
            if (typeof this._scene.onPmjsResume === 'function') {
              this._scene.onPmjsResume();
            } else if (typeof this._scene.start === 'function') {
              this._scene.start();
            }
            this.onSceneStart();
            return;
          }
          if (!this._scene.reused) {
            if (this._scene.attachReservation) this._scene.attachReservation();
            this._scene.create();
          } else {
            // Reattachment is one-shot; a later exit terminates normally.
            if (this._scene.attachReservation) this._scene.attachReservation();
            this._scene.reused = false;
            if (typeof Scene_Map !== 'undefined' && this._scene instanceof Scene_Map) {
              this._scene._transfer = false;
            }
          }
          this._nextScene = null;
          this._sceneStarted = false;
          this.onSceneCreate();
        }
        if (this._exiting) this.terminate();
      }
    };
    var _origOnSceneStart = SceneManager.onSceneStart;
    SceneManager.onSceneStart = function() {
      var r = _origOnSceneStart.apply(this, arguments);
      try {
        if (!this._isReturningFromMenu && this._stack.length === 0 &&
            !SceneManager._pmjsCompatibilityGc && isMajorSceneTransition(this._scene) &&
            typeof NativeHost !== 'undefined' && NativeHost.runtime && NativeHost.runtime.collectGarbage) {
          NativeHost.runtime.collectGarbage();
        }
      } catch (_) {}
      this._isReturningFromMenu = false;
      return r;
    };
    SceneManager._pmjsFullPatched = true;
    nativeCompatibilityHit('scene.fullPatched', 'SceneManager map recycling + GC + isFocus');
  } catch (e) {
    nativeCompatibilityHit('scene.fullPatchError', e && e.message || '');
  }
}
