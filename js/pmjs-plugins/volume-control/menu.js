'use strict';

(function() {
  function installVolumeMenu() {
    function Window_VolumeOptions() { this.initialize.apply(this, arguments); }
    Window_VolumeOptions.prototype = Object.create(Window_Options.prototype);
    Window_VolumeOptions.prototype.constructor = Window_VolumeOptions;
    Window_VolumeOptions.prototype.makeCommandList = function() { this.addVolumeOptions(); };
    function Scene_VolumeOptions() { this.initialize.apply(this, arguments); }
    Scene_VolumeOptions.prototype = Object.create(Scene_Options.prototype);
    Scene_VolumeOptions.prototype.constructor = Scene_VolumeOptions;
    Scene_VolumeOptions.prototype.createOptionsWindow = function() {
      this._optionsWindow = new Window_VolumeOptions();
      this._optionsWindow.setHandler('cancel', this.popScene.bind(this));
      this.addWindow(this._optionsWindow);
    };
    var titleList = typeof Window_TitleCommand.prototype.makeCustomCommandList === 'function'
      ? 'makeCustomCommandList' : 'makeCommandList';
    [[Window_TitleCommand, titleList], [Window_MenuCommand, 'addOriginalCommands']].forEach(function(entry) {
      var original = entry[0].prototype[entry[1]];
      entry[0].prototype[entry[1]] = function() {
        original.apply(this, arguments);
        this.addCommand('Volume Control', 'pmjsVolumeControl', true);
      };
    });
    [Scene_Title, Scene_Menu].forEach(function(Scene) {
      var original = Scene.prototype.createCommandWindow;
      Scene.prototype.createCommandWindow = function() {
        original.apply(this, arguments);
        this._commandWindow.setHandler('pmjsVolumeControl', function() {
          SceneManager.push(Scene_VolumeOptions);
        });
      };
    });
  }
  PMJS.phases.on('beforePlugins', 'pmjs.volume-control.menu', function() {
    PMJS.plugins.interceptLoad('volume setting', 'volume-control/menu', function(next, context) {
      var source = NativeHost.fs.readText(context.path);
      if (!source || !globalThis.__pmjsBuiltinRequire ||
          !PMJS.methods.matchesText(source, '6da9feccde0a45cd1b8bade5f068b5d120b83166fbd43398b63f8314d6e88b94')) return next();
      // This package contains an RGSS volume menu in a JavaScript slot. Its
      // four channels map to the engine's existing persisted volume settings.
      PMJS.phases.on('afterGuestPlugins', 'pmjs.volume-control.menu.install', installVolumeMenu);
    });
  });
})();
