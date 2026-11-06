'use strict';

const { runOptimizationAdapter } = require('../../helpers/runtime-context.cjs');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const methodHash = require('./test-fixtures/method-hash.cjs')();
const source = fs.readFileSync(path.join(__dirname, '../../../patches/isat/plain-word-measure.js'), 'utf8');

function setup({ enabled = true, translated, failure, qualified = true, unknown = false } = {}) {
  const phases = [];
  const calls = [];
  function WindowBase() {
    this._wordWrap = true;
    this.contents = {
      fontFace: 'initial', _allowTextTranslation: true,
      setTextTranslation(value) {
        calls.push(['translation', value]);
        this._allowTextTranslation = value;
      },
      loadOptionsFont() { calls.push(['font']); this.fontFace = 'selected'; }
    };
  }
  const fallback = function() { calls.push(['fallback', ...arguments]); return 901; };
  WindowBase.prototype = {
    textWidthExCheck: fallback,
    textWidth() { throw new Error('must use saved width alias'); },
    saveCurrentWindowSettings() { this.savedFont = this.contents.fontFace; calls.push(['save']); },
    resetFontSettings() { this.contents.fontFace = 'reset'; calls.push(['reset']); },
    restoreCurrentWindowSettings() { this.contents.fontFace = this.savedFont; calls.push(['restore']); },
    clearCurrentWindowSettings() { delete this.savedFont; calls.push(['clear']); }
  };
  const context = vm.createContext({
    Window_Base: WindowBase,
    VictorEngine: { ControlText: { textWidth(character) {
      calls.push(['width', character, this.contents.fontFace,
        this._wordWrap, this._checkWordWrapMode, this.contents._allowTextTranslation]);
      if (failure) throw failure;
      return this.contents.fontFace === 'reset' ? 3 : 7;
    } } },
    SRD: { TranslationEngine: { translate(text) {
      calls.push(['translate', text]);
      return translated === undefined ? text : translated;
    } } },
    PMJS: {
      isatSourceQualification: qualified === null ? undefined : { verified: qualified },
      isatMethodHash: methodHash,
      optimizations: { register() {}, isEnabled() { return enabled; }, refuse() {} },
      phases: { on(phase, _id, callback) { phases.push({ phase, callback }); } },

    }
  });
  let adapted = source;
  for (const [expected, method] of [
    ['804a24c50bf504ffbd22f3ace97615df230de185b62142f81724943769ced5e5', fallback],
    ['635335e3101550eb65e6637734042672491e6f2d528af031ea11a82f1cf438b5', context.VictorEngine.ControlText.textWidth],
    ['c646ad77520444a09cd56800d5c701be21662de32604ccbc39979725b5046f91', context.SRD.TranslationEngine.translate]
  ]) adapted = adapted.replace(expected, methodHash(method));
  if (unknown) WindowBase.prototype.textWidthExCheck = function() { calls.push(['authored']); return 17; };
  runOptimizationAdapter(adapted, context);
  assert.equal(phases[0].phase, 'afterPlugins');
  phases[0].callback();
  return { window: new WindowBase(), calls, fallback, context };
}

test('plain probes measure translated UTF-16 units before each font side effect', () => {
  const { window, calls } = setup({ translated: 'A😀' });
  assert.equal(window.textWidthExCheck('original'), 17);
  assert.deepEqual(calls, [
    ['translate', 'original'], ['save'], ['translation', false], ['reset'],
    ['width', 'A', 'reset', false, true, false], ['font'],
    ['width', '\ud83d', 'selected', false, true, false], ['font'],
    ['width', '\ude00', 'selected', false, true, false], ['font'],
    ['translation', true], ['restore'], ['clear']
  ]);
  assert.equal(window._wordWrap, true);
  assert.equal(window._checkWordWrapMode, false);
  assert.equal(window.contents.fontFace, 'initial');
  assert.equal(window.contents._allowTextTranslation, true);
  assert.equal('savedFont' in window, false);
});

test('control strings and translated formatting delegate unchanged arguments', () => {
  for (const text of ['', null, '\\C[2]word', '\x1bC[2]word', 'a\nb', 'a\rb', 'a\fb', '<WordWrap>', '>']) {
    const { window, calls } = setup();
    assert.equal(window.textWidthExCheck(text, 'extra'), 901);
    assert.deepEqual(calls, [['fallback', text, 'extra']]);
  }
  const { window, calls } = setup({ translated: '\\C[2]word' });
  assert.equal(window.textWidthExCheck('plain', 'extra'), 901);
  assert.deepEqual(calls, [['translate', 'plain'], ['fallback', 'plain', 'extra']]);
});

test('measurement failure restores window and translation state', () => {
  const failure = new Error('measurement failed');
  const { window, calls } = setup({ failure });
  window._wordWrap = false;
  window.contents._allowTextTranslation = false;
  assert.throws(() => window.textWidthExCheck('word'), error => error === failure);
  assert.equal(window._wordWrap, false);
  assert.equal(window._checkWordWrapMode, false);
  assert.equal(window.contents._allowTextTranslation, false);
  assert.equal(window.contents.fontFace, 'initial');
  assert.deepEqual(calls.slice(-3), [['translation', false], ['restore'], ['clear']]);
});

test('disabled optimization retains the original method', () => {
  const { window, fallback } = setup({ enabled: false });
  assert.equal(window.textWidthExCheck, fallback);
});

test('missing qualification and modified methods preserve authored measurement', () => {
  for (const qualified of [false, null]) {
    const h = setup({ qualified });
    assert.equal(h.window.textWidthExCheck, h.fallback);
  }
  const h = setup({ unknown: true });
  assert.equal(h.window.textWidthExCheck('word'), 17);
  assert.deepEqual(h.calls, [['authored']]);
});

test('qualification revocation and alias replacement restore the ordinary path', () => {
  for (const change of [h => { h.context.PMJS.isatSourceQualification = { verified: true }; },
    h => { h.context.VictorEngine.ControlText.textWidth = () => 0; },
    h => { h.context.SRD.TranslationEngine.translate = () => 'changed'; }]) {
    const h = setup(); change(h);
    assert.equal(h.window.textWidthExCheck('word'), 901);
    assert.deepEqual(h.calls, [['fallback', 'word']]);
  }
});
