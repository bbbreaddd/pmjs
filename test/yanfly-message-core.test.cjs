'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname,
  '../js/pmjs-plugins/yanfly/message-core.js'), 'utf8');

function install({ enabled = true, changedCharacter = false, changedBody = false, changedMeasure = false,
  pluginSource = null, fontWrapper = false } = {}) {
  const phases = [];
  const state = { raster: [], fonts: 0, dirty: 0, refused: null };
  const context = vm.createContext({ state, PMJS: {
    plugins: {
      registerOptimization(plugin, definition) { state.definition = definition; },
      onLoaded(plugin, id, callback) { state.loaded = callback; }
    },
    phases: { on(phase, id, callback) { phases.push(callback); } },
    optimizations: { isEnabled() { return enabled; },
      refuse(id, reason) { state.refused = reason; } }
  } });
  vm.runInContext(`
    function Bitmap() { this.height = 100; }
    Bitmap.prototype._drawTextOutline = function(text) { state.raster.push('outline:' + text); };
    Bitmap.prototype._drawTextBody = function(text) { state.raster.push('fill:' + text); };
    Bitmap.prototype.drawText = function(text) {
      this._drawTextOutline(text); this._drawTextBody(text); state.dirty++;
    };
    function Window_Base() { this.contents = new Bitmap(); }
    function Window_Message() { Window_Base.call(this); }
    Window_Message.prototype = Object.create(Window_Base.prototype);
    Window_Base.prototype.textWidth = function(text) { return text === '界' ? 2 : 1; };
    Window_Base.prototype.processNormalCharacter = function(textState) {
      var c = textState.text[textState.index++];
      var w = this.textWidth(c);
      this.contents.drawText(c, textState.x, textState.y, w * 2, textState.height);
      textState.x += w;
    };
    Window_Base.prototype.drawTextEx = function(text) {
      var textState = { text: text, index: 0, x: 0, y: 100, height: 20 };
      while (textState.index < text.length) this.processNormalCharacter(textState);
      return textState.x;
    };
    Window_Base.prototype.saveCurrentWindowSettings = function() {};
    Window_Base.prototype.restoreCurrentWindowSettings = function() {};
    Window_Base.prototype.clearCurrentWindowSettings = function() {};
  `, context);
  vm.runInContext(source, context);
  vm.runInContext(`
    var Yanfly = { Message: {} };
    Yanfly.Message.Window_Base_processNormalCharacter = Window_Base.prototype.processNormalCharacter;
    Window_Base.prototype.processNormalCharacter = function(textState) {
      return Yanfly.Message.Window_Base_processNormalCharacter.call(this, textState);
    };
    Window_Base.prototype.textWidthExCheck = function(text) {
      var setting = this._wordWrap;
      this._wordWrap = false;
      this.saveCurrentWindowSettings();
      this._checkWordWrapMode = true;
      var value = this.drawTextEx(text, 0, this.contents.height);
      this._checkWordWrapMode = false;
      this.restoreCurrentWindowSettings();
      this.clearCurrentWindowSettings();
      this._wordWrap = setting;
      return value;
    };
  `, context);
  if (pluginSource) vm.runInContext(pluginSource, context);
  if (fontWrapper) vm.runInContext(`
    var drawText = Bitmap.prototype.drawText;
    Bitmap.prototype.drawText = function() {
      state.fonts++; this.fontFace = 'language-font';
      return drawText.apply(this, arguments);
    };
    var processCharacter = Window_Message.prototype.processNormalCharacter;
    Window_Message.prototype.processNormalCharacter = function(textState) {
      if (!this._checkWordWrapMode && this.shaking) return;
      return processCharacter.call(this, textState);
    };
  `, context);
  if (changedCharacter) {
    const original = context.Yanfly.Message.Window_Base_processNormalCharacter;
    context.Yanfly.Message.Window_Base_processNormalCharacter = function() {
      state.characters = (state.characters || 0) + 1;
      return original.apply(this, arguments);
    };
  }
  if (changedMeasure) context.Window_Base.prototype.textWidthExCheck = function(text) {
    return this.drawTextEx(text);
  };
  if (changedBody) context.Bitmap.prototype._drawTextBody = function() {};
  state.loaded();
  phases.forEach(callback => callback());
  return { context, state, message: new context.Window_Message() };
}

test('plain YEP and font/message wrappers retain widths, side effects and visible draws', () => {
  for (const fontWrapper of [false, true]) {
    const { message, state } = install({ fontWrapper });
    const before = Object.getOwnPropertyDescriptors(message.contents);
    assert.equal(message.textWidthExCheck('a界b'), 4);
    assert.deepEqual(state.raster, []);
    assert.equal(state.fonts, fontWrapper ? 3 : 0);
    assert.equal(state.dirty, 3);
    assert.equal(Object.hasOwn(message.contents, '_drawTextOutline'), false);
    assert.equal(Object.hasOwn(message.contents, '_drawTextBody'), false);
    assert.equal(message.contents.height, before.height.value);
    message.drawTextEx('ok');
    assert.deepEqual(state.raster, ['outline:o', 'fill:o', 'outline:k', 'fill:k']);
  }
});

test('restores drawing descriptors after a font wrapper throws', () => {
  const { message } = install({ fontWrapper: true });
  Object.defineProperty(message.contents, '_drawTextBody', {
    value: message.contents._drawTextBody, writable: true, configurable: true, enumerable: false
  });
  const before = Object.getOwnPropertyDescriptors(message.contents);
  message.contents.drawText = function() { throw new Error('font failure'); };
  assert.throws(() => message.textWidthExCheck('x'), /font failure/);
  assert.deepEqual(Object.getOwnPropertyDescriptor(message.contents, '_drawTextBody'), before._drawTextBody);
  assert.equal(Object.hasOwn(message.contents, '_drawTextOutline'), false);
});

test('disabled, modified pipelines and instance drawing methods keep ordinary behavior', () => {
  for (const options of [{ enabled: false }, { changedBody: true }, { changedMeasure: true }]) {
    const { message, state } = install(options);
    assert.equal(message.textWidthExCheck('ab'), 2);
    assert.ok(state.raster.length > 0);
    assert.equal(Boolean(state.refused), Boolean(options.changedBody || options.changedMeasure));
  }
  const { message, state } = install();
  message.contents._drawTextBody = function(text) { state.raster.push('custom:' + text); };
  assert.equal(message.textWidthExCheck('x'), 1);
  assert.deepEqual(state.raster, ['outline:x', 'custom:x']);
});


test('legitimate character wrappers remain installed and execute during measurement', () => {
  const { message, state, context } = install({ changedCharacter: true });
  const character = context.Yanfly.Message.Window_Base_processNormalCharacter;
  assert.equal(state.refused, null);
  assert.equal(message.textWidthExCheck('a界b'), 4);
  assert.equal(state.characters, 3);
  assert.deepEqual(state.raster, []);
  assert.equal(context.Yanfly.Message.Window_Base_processNormalCharacter, character);
});

test('nested measurement restores raster leaves only after the outer operation', () => {
  const { message, state } = install();
  const originalDrawText = message.contents.drawText;
  let nested = false;
  message.contents.drawText = function(text) {
    if (!nested) {
      nested = true;
      assert.equal(message.textWidthExCheck('界'), 2);
    }
    return originalDrawText.call(this, text);
  };
  assert.equal(message.textWidthExCheck('ab'), 2);
  assert.deepEqual(state.raster, []);
  assert.equal(Object.hasOwn(message.contents, '_drawTextOutline'), false);
  message.drawTextEx('x');
  assert.deepEqual(state.raster, ['outline:x', 'fill:x']);
});

// Purchased sources are optional local evidence, never copied into the suite.
for (const [name, game] of [
  ['ISAT', '../../ports/isat/port/game'],
  ['OMORI', '../../ports/omori/OMORI-decrypted']
]) {
  const file = path.resolve(__dirname, game, 'js/plugins/YEP_MessageCore.js');
  test(name + ' installed YEP measurement preserves width and removes raster calls',
    { skip: !fs.existsSync(file) }, () => {
      const text = fs.readFileSync(file, 'utf8');
      const assignment = text.match(/Window_Base\.prototype\.textWidthExCheck = function\(text\) \{[\s\S]*?\n\};/);
      assert.ok(assignment);
      const character = text.match(/Window_Base\.prototype\.processNormalCharacter = function\(textState\) \{[\s\S]*?\n\};/);
      assert.ok(character);
      let pluginSource = assignment[0] + '\n' + character[0] +
        '\nWindow_Base.prototype.checkWordWrap = function() { return false; };';
      if (name === 'ISAT') {
        const plugins = path.dirname(file);
        const shaking = fs.readFileSync(path.join(plugins, 'SRD_ShakingText.js'), 'utf8');
        const message = shaking.match(/Window_Message\.prototype\.processNormalCharacter = function\(textState\) \{[\s\S]*?\n\s*\};/);
        const font = fs.readFileSync(path.join(plugins, 'master2015hp_InStarTimeSnippet.js'), 'utf8');
        const draw = font.match(/Bitmap\.prototype\.drawText = function\(text, x, y, maxWidth, lineHeight, align\) \{[\s\S]*?\n\};/);
        assert.ok(message);
        assert.ok(draw);
        pluginSource += `
          var _Window_Message_processNormalCharacter = Window_Message.prototype.processNormalCharacter;
          Window_Message.prototype.isShakingActive = function() { return false; };
          var master2015hp = { isatSnp: { b_42: Bitmap.prototype.drawText } };
          Bitmap.prototype.loadOptionsFont = function() { state.fonts++; this.fontFace = 'language-font'; };
        ` + message[0] + '\n' + draw[0];
      }
      const baseline = install({ enabled: false, pluginSource });
      const candidate = install({ pluginSource });
      assert.equal(candidate.state.refused, null);
      assert.equal(candidate.message.textWidthExCheck('a界 b'), baseline.message.textWidthExCheck('a界 b'));
      assert.deepEqual(candidate.state.raster, []);
      assert.ok(baseline.state.raster.length > 0);
      assert.equal(candidate.state.fonts, baseline.state.fonts);
      assert.equal(candidate.message._wordWrap, baseline.message._wordWrap);
      assert.equal(candidate.message._checkWordWrapMode, false);
    });
}
