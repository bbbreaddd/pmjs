'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const vm = require('node:vm');
const test = require('node:test');
const { runModule } = require('./helpers/runtime-context.cjs');

function loadAdapter(file, pluginSource, context) {
  context.__pmjsBuiltinRequire = require;
  context.NativeHost = { fs: { readText: () => pluginSource }, runtime: { runScript: text => vm.runInContext(text, c) } };
  context.PMJS = { phases: { on(phase, owner, callback) { callback(); } } };
  context.PluginManager = { _path: 'js/plugins/', loadScript() { throw new Error('unreviewed script delegated'); },
    parameters: () => ({ PhysicalAttacks: 'false', SkillTypes: '4 7' }) };
  const c = vm.createContext(context);
  runModule(c, 'js/pmjs-core/methods.js');
  runModule(c, 'js/pmjs-rpgmaker/plugins.js');
  c.PluginManager.loadScript = name => c.PMJS.plugins.loadScript(name, 'js/plugins/' + name, () => { throw new Error('unreviewed script delegated'); });
  const source = fs.readFileSync(require.resolve('../js/pmjs-plugins/' + file), 'utf8')
    .replace(/'[a-f0-9]{64}'/, "'" + crypto.createHash('sha256').update(pluginSource).digest('hex') + "'");
  vm.runInContext(source, c);
  return c;
}

test('reviewed physical-attack repair preserves action behavior and parameter types', () => {
  const plugin = `var parameters = PluginManager.parameters('CC_physicalattacks');
    var enabled = eval(String(parameters));
    var types = String(parameters).split(' ');
    globalThis.select = function(type) { return enabled || types.indexOf(type) >= 0; };`;
  const c = loadAdapter('coelocanth/physical-attacks.js', plugin, {});
  c.PluginManager.loadScript('physical_attack_animation.js');
  assert.equal(c.select(4), true); assert.equal(c.select(7), true); assert.equal(c.select(1), false);
  c.PluginManager.parameters = () => ({ PhysicalAttacks: 'false', SkillTypes: '' });
  c.PluginManager.loadScript('physical_attack_animation.js'); assert.equal(c.select(0), false);
  c.PluginManager.parameters = () => ({});
  c.PluginManager.loadScript('physical_attack_animation.js'); assert.equal(c.select(1), true);
});

test('volume replacement uses the existing volume options, scene stack and menu composition', () => {
  function Window_Options() { this.initialize.apply(this, arguments); }
  Window_Options.prototype.makeCommandList = function() {};
  Window_Options.prototype.initialize = function() { this.handlers = {}; this.makeCommandList(); };
  Window_Options.prototype.setHandler = function(name, fn) { this.handlers[name] = fn; };
  Window_Options.prototype.addVolumeOptions = function() { this.channels = ['bgm', 'bgs', 'me', 'se']; };
  function Window_TitleCommand() { this.commands = []; }
  Window_TitleCommand.prototype.makeCommandList = function() { this.addCommand('Original', 'original'); };
  Window_TitleCommand.prototype.addCommand = function(name, symbol) { this.commands.push([name, symbol]); };
  function Window_MenuCommand() { Window_TitleCommand.call(this); }
  Window_MenuCommand.prototype = Object.create(Window_TitleCommand.prototype);
  Window_MenuCommand.prototype.addOriginalCommands = function() { this.addCommand('Custom', 'custom'); };
  function Scene_Options() {}
  Scene_Options.prototype.initialize = function() {};
  Scene_Options.prototype.addWindow = function(window) { this.child = window; };
  Scene_Options.prototype.popScene = function() {};
  function Scene_Title() {}
  Scene_Title.prototype.createCommandWindow = function() { this._commandWindow = new Window_Options(); };
  function Scene_Menu() {}
  Scene_Menu.prototype.createCommandWindow = Scene_Title.prototype.createCommandWindow;
  const pushed = [];
  const c = loadAdapter('volume-control/menu.js', '# incompatible language', {
    Window_Options, Window_TitleCommand, Window_MenuCommand, Scene_Options, Scene_Title, Scene_Menu,
    SceneManager: { push(Scene) { pushed.push(Scene); } } });
  c.PMJS.plugins.execute('volume setting', () => c.PluginManager.loadScript('volume setting.js'));
  assert.equal(c.PMJS.plugins.dump().guest[0].state, 'loaded');
  const title = new Window_TitleCommand(); title.makeCommandList();
  assert.deepEqual(title.commands.map(item => item[0]), ['Original', 'Volume Control']);
  const menu = new Window_MenuCommand(); menu.addOriginalCommands();
  assert.deepEqual(menu.commands.map(item => item[0]), ['Custom', 'Volume Control']);
  const scene = new Scene_Title(); scene.createCommandWindow();
  scene._commandWindow.handlers.pmjsVolumeControl();
  const options = new pushed[0](); options.createOptionsWindow();
  assert.deepEqual(options.child.channels, ['bgm', 'bgs', 'me', 'se']);
  assert.ok(options instanceof Scene_Options);
});

for (const [file, name] of [['coelocanth/physical-attacks.js', 'physical_attack_animation.js'],
  ['volume-control/menu.js', 'volume setting.js']]) {
  test('unrecognized packaged script remains delegated: ' + name, () => {
    const context = vm.createContext({ __pmjsBuiltinRequire: require,
      NativeHost: { fs: { readText: () => 'changed script' } },
      PluginManager: { _path: 'js/plugins/', loadScript() { throw new Error('guest behavior'); } },
      PMJS: { phases: { on(phase, owner, callback) { callback(); } } } });
    runModule(context, 'js/pmjs-core/methods.js');
    runModule(context, 'js/pmjs-rpgmaker/plugins.js');
    context.PluginManager.loadScript = name => context.PMJS.plugins.loadScript(name, 'js/plugins/' + name, () => { throw new Error('guest behavior'); });
    vm.runInContext(fs.readFileSync(require.resolve('../js/pmjs-plugins/' + file), 'utf8'), context);
    assert.throws(() => context.PluginManager.loadScript(name), /guest behavior/);
  });
}
