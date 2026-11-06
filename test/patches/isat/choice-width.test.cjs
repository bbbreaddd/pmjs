'use strict';

const { runOptimizationAdapter } = require('../../helpers/runtime-context.cjs');

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../../../patches/isat/choice-width.js'), 'utf8');
const fingerprints = ['42c171dd2639b68d99e87494939375b500fc6a5978e2c36579225cafc5f54b93',
  '7adfd13d31747908de84772ca85ab95c7d5d29d7c10f15363343b9ad4037ff62',
  'f30227773727b0cde96c202ceb614e0bd40548f01562c3bad8bc95fb4a57a404'];

function fixture({ enabled = true, unknown = false, translations = {} } = {}) {
  const calls = { widths: 0, raster: 0, fonts: 0, conversions: 0, bounds: 0 };
  let install, refusal;
  class Bitmap {
    constructor() {
      this.height = 72; this.fontSize = 28; this.outlineWidth = 4;
      this._context = { globalCompositeOperation: 'source-over', _transform: [1, 0, 0, 1, 0, 0],
        save() {}, restore() {}, measureText() {
          calls.bounds++; return { actualBoundingBoxAscent: 20, fontBoundingBoxAscent: 24 };
        } };
    }
    measureTextWidth(text) { calls.widths++; return text.length * 10; }
    _makeFontNameText() { return '28px selected'; }
    _drawTextOutline() { calls.raster++; }
    _drawTextBody() { calls.raster++; }
    drawText(text, y) {
      calls.fonts++; this.fontFace = 'selected';
      this._drawTextOutline(text, y); this._drawTextBody(text, y);
    }
  }
  class Choice {
    constructor() {
      this.contents = new Bitmap(); this.choices = ['First', 'Second'];
      this._messageWindow = { width: 400 }; this.x = 20;
    }
    maxChoiceWidth() {
      let result = this._messageWindow.width - this.x - 60 || 800;
      const cap = result;
      for (const choice of this.choices) result = Math.max(result, this.textWidthEx(choice));
      return Math.min(cap, result);
    }
    textWidthEx(raw) {
      const text = translations[raw] ?? raw;
      this._wordWrap = !!this.wrapNext; this.wrapNext = false;
      calls.conversions++;
      this.contents.fontFace = 'reset';
      const state = { text, index: 0, x: 0, y: this.contents.height, height: 36 };
      while (state.index < text.length) this.processNormalCharacter(state);
      if (this.fail) throw new Error('text failure');
      return state.x;
    }
    processNormalCharacter(state) {
      const text = state.text[state.index++];
      this.contents.textColor = this.selected ? 'selected' : 'normal';
      state.x += this.contents.measureTextWidth(text);
      this.contents.drawText(text, state.y);
    }
  }
  const originals = [Choice.prototype.maxChoiceWidth, Choice.prototype.textWidthEx,
    Choice.prototype.processNormalCharacter];
  let adapted = source;
  for (let i = 0; i < fingerprints.length; i++) {
    adapted = adapted.replace(fingerprints[i], crypto.createHash('sha256')
      .update(originals[i].toString()).digest('hex'));
  }
  if (unknown) Choice.prototype.maxChoiceWidth = function() { return 42; };
  const context = vm.createContext({ Bitmap, Window_ChoiceList: Choice, __pmjsBuiltinRequire: require,
    PMJS: { isatSourceQualification: { verified: true }, optimizations: { register() {}, isEnabled() { return enabled; },
      refuse(_id, reason) { refusal = reason; } },
    web: { canvas: { supportsNativeText(context) {
      return context.globalCompositeOperation === 'source-over' &&
        context._transform.join(',') === '1,0,0,1,0,0';
    } } },
    phases: { on(_phase, _owner, callback) { install = callback; } } } });
  context.PMJS.isatMethodHash = require('./test-fixtures/method-hash.cjs')(context.__pmjsBuiltinRequire);
  runOptimizationAdapter(adapted, context); install();
  return { window: new Choice(), calls, originals, refusal };
}

test('plain choice layout preserves state and bounds-checks before omitting remaining glyph work', () => {
  for (const translated of [false, true]) {
    const options = { translations: translated ? { First: 'Premier', Second: 'Deuxième' } : {} };
    const baseline = fixture({ ...options, enabled: false }), candidate = fixture(options);
    baseline.window.selected = candidate.window.selected = true;
    assert.equal(candidate.window.maxChoiceWidth(), baseline.window.maxChoiceWidth());
    assert.ok(baseline.calls.widths > 0);
    assert.equal(candidate.calls.widths, 2);
    assert.ok(candidate.calls.bounds > 0);
    assert.equal(candidate.calls.raster, 4);
    assert.equal(candidate.calls.fonts, baseline.calls.fonts);
    assert.equal(candidate.calls.conversions, baseline.calls.conversions);
    assert.equal(candidate.window.contents.fontFace, baseline.window.contents.fontFace);
    assert.equal(candidate.window.contents.textColor, baseline.window.contents.textColor);
    assert.equal(candidate.window._wordWrap, baseline.window._wordWrap);
  }
});

test('formatted and translated control strings keep ordinary glyph processing', () => {
  for (const text of ['\\PX[0]ink', '\x1bC[2]text', '<WordWrap>text', 'line\nline', 'a\rb', 'a\fb']) {
    for (const translated of [false, true]) {
      const h = fixture({ translations: translated ? { plain: text } : {} });
      h.window.choices = [translated ? 'plain' : text];
      assert.equal(h.window.maxChoiceWidth(), 320);
      assert.ok(h.calls.widths > 0);
      assert.ok(h.calls.raster > 0);
    }
  }
});

test('pending wrapping and unusual drawing state retain original work', () => {
  for (const change of ['wrap', 'outline', 'transform', 'custom-width', 'visible-ink']) {
    const h = fixture(); h.window.choices = ['text'];
    if (change === 'wrap') h.window.wrapNext = true;
    if (change === 'outline') h.window.contents.outlineWidth = 100;
    if (change === 'transform') h.window.contents._context._transform[5] = -100;
    if (change === 'visible-ink') h.window.contents._context.measureText = function() {
      return { actualBoundingBoxAscent: 80, fontBoundingBoxAscent: 24 };
    };
    if (change === 'custom-width') {
      const original = h.window.contents.measureTextWidth;
      h.window.contents.measureTextWidth = function(text) { return original.call(this, text); };
    }
    assert.equal(h.window.maxChoiceWidth(), 320);
    assert.ok(h.calls.widths > 0);
    if (change === 'wrap') assert.equal(h.window.wrapNext, false);
  }
});

test('restores exact property descriptors after success or an exception', () => {
  for (const fail of [false, true]) {
    const h = fixture(); h.window.fail = fail;
    for (const name of ['measureTextWidth', '_drawTextOutline', '_drawTextBody']) {
      Object.defineProperty(h.window.contents, name, { value: h.window.contents[name],
        writable: true, configurable: true, enumerable: false });
    }
    const before = Object.getOwnPropertyDescriptors(h.window.contents);
    if (fail) assert.throws(() => h.window.maxChoiceWidth(), /text failure/);
    else h.window.maxChoiceWidth();
    assert.equal(Object.hasOwn(h.window, 'textWidthEx'), false);
    assert.equal(Object.hasOwn(h.window, 'processNormalCharacter'), false);
    for (const name of ['measureTextWidth', '_drawTextOutline', '_drawTextBody']) {
      assert.deepEqual(Object.getOwnPropertyDescriptor(h.window.contents, name), before[name]);
    }
    const old = h.calls.widths;
    h.window.fail = false; h.window.textWidthEx('ordinary');
    assert.ok(h.calls.widths > old);
  }
});

test('unknown method compositions and disabled policy preserve the original implementation', () => {
  const unknown = fixture({ unknown: true });
  assert.match(unknown.refusal, /unrecognized/);
  assert.equal(unknown.window.maxChoiceWidth(), 42);
  const disabled = fixture({ enabled: false });
  assert.equal(disabled.window.maxChoiceWidth, disabled.originals[0]);
  disabled.window.maxChoiceWidth();
  assert.ok(disabled.calls.raster > 0);
});
