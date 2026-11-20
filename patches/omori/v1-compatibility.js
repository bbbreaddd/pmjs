;(function() {
  PMJS.omori = PMJS.omori || {};
  PMJS.omori.backports = Object.freeze(Object.assign({}, NativeHost.runtime.omoriBackports));
  var readScript = NativeHost.runtime.readGameScript;
  if (readScript) NativeHost.runtime.readGameScript = function(name) {
    var source = readScript(name);
    if (name === 'js/main.js' && source && /\bkey\s*=\s*['"][a-f0-9]{32}['"]/i.test(source) &&
        source.includes('PluginManager=class extends PluginManager')) return '{\n' + source + '\n}';
    return source;
  };
  function applied(name) {
    NativeHost.runtime.omoriBackports = Object.assign({}, NativeHost.runtime.omoriBackports);
    NativeHost.runtime.omoriBackports[name] = true;
    PMJS.omori.backports = Object.freeze(Object.assign({}, NativeHost.runtime.omoriBackports));
  }
  var textHandler, configHandler, beforeText;
  function textSkipReady() { if (textHandler && configHandler) applied('textSkip'); }
  PMJS.plugins.onLoading('TDDP_NoFastForward', 'port.omori.v1.text-skip', function() {
    beforeText = Window_Message.prototype.updateShowFast;
  });
  PMJS.plugins.onLoaded('TDDP_NoFastForward', 'port.omori.v1.text-skip', function() {
    if (!PMJS.omori.backports.generalOptionsSchema || !beforeText ||
        !String(Window_Message.prototype.updateShowFast).includes('isTextFfDisabled')) return;
    Window_Message.prototype.updateShowFast = function() {
      if (ConfigManager.textSkip) return beforeText.apply(this, arguments);
      return false;
    };
    textHandler = true;
    textSkipReady();
  });
  PMJS.plugins.onLoaded('Omori BASE', 'port.omori.v1.config', function() {
    if (!PMJS.omori.backports.generalOptionsSchema) return;
    var make = ConfigManager.makeData, apply = ConfigManager.applyData, restore = ConfigManager.restoreDefaultConfig;
    if (ConfigManager.textSkip === undefined) ConfigManager.textSkip = false;
    ConfigManager.makeData = function() {
      return Object.assign({}, make.apply(this, arguments), { textSkip: !!this.textSkip });
    };
    ConfigManager.applyData = function(config) {
      var result = apply.apply(this, arguments);
      this.textSkip = !!config.textSkip;
      return result;
    };
    ConfigManager.restoreDefaultConfig = function() {
      this.textSkip = false;
      return restore.apply(this, arguments);
    };
    configHandler = true;
    textSkipReady();
  });
  PMJS.plugins.onLoaded('Omori Main Menu - Scene Options', 'port.omori.v1.options', function() {
    if (!PMJS.omori.backports.generalOptionsSchema) return;
    var original = Window_OmoMenuOptionsGeneral.prototype.processOptionCommand;
    Window_OmoMenuOptionsGeneral.prototype.processOptionCommand = function() {
      var index = this.index(), choice = this._optionsList[index].index;
      if (index < 3) {
        var result = original.apply(this, arguments);
        if (index === 2 && PMJS.omori.backports.titleCommandHints && SceneManager._scene instanceof Scene_OmoriTitleScreen) {
          SceneManager._scene.refreshCommandHints();
        }
        return result;
      }
      if (index === 3) ConfigManager.textSkip = choice === 0;
      if (index === 4) ConfigManager.battleLogSpeed = choice;
      if (index === 5) ConfigManager.alwaysDash = choice === 0;
    };
  });
  PMJS.plugins.onLoaded('Omori Title Screen', 'port.omori.v1.title-hints', function() {
    var prototype = Scene_OmoriTitleScreen.prototype;
    if (prototype.refreshCommandHints || prototype.createCommandHints) return;
    prototype.refreshCommandHints = function() {
      var bitmap = this._commandHints.bitmap;
      var labels = LanguageManager.languageData().text.System.plugins.optionsMenu.buttonHints || {};
      bitmap.clear();
      bitmap.fontSize = 28;
      var x = 0;
      [['ok', labels.confirm || 'CONFIRM'], ['escape', labels.cancel || 'CANCEL']].forEach(function(hint) {
        bitmap.drawInputIcon(hint[0], x, 4);
        bitmap.drawText(hint[1], x + 29, 4, bitmap.width - x - 29, 16, 'left');
        x += 39 + bitmap.measureTextWidth(hint[1]);
      });
    };
    prototype.createCommandHints = function() {
      if (!this._commandHints) {
        this._commandHints = new Sprite(new Bitmap(Math.ceil(Graphics.boxWidth / 2.8), Math.ceil(Graphics.boxHeight / 8)));
        this.addChild(this._commandHints);
        this._commandHints.position.set(Graphics.boxWidth - this._commandHints.width, 0);
      }
      this.refreshCommandHints();
    };
    var create = prototype.create;
    prototype.create = function() {
      var result = create.apply(this, arguments);
      this.createCommandHints();
      return result;
    };
    applied('titleCommandHints');
  });
  PMJS.plugins.onLoaded('Omori Battle System', 'port.omori.v1.battle-input', function() {
    var previous = BattleManager.selectPreviousCommand;
    var source = String(previous);
    if (!source.includes('getActorInputOrder') || source.includes('clearInputtingAction')) return;
    BattleManager.selectPreviousCommand = function() {
      var result = previous.apply(this, arguments);
      if (this._actorCommandIndex > 0) this.clearInputtingAction();
      return result;
    };
    applied('battleInputCleanup');
  });
})();
