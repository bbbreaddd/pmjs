'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../js/pmjs-plugins/orange/hud-contents.js'), 'utf8');

function fixture({ unknown = false } = {}) {
  const calls = { refreshes: 0, replacements: 0 };
  function Bitmap(width, height) {
    this.width = width; this.height = height;
    this.fontSize = 18; this.outlineWidth = 4; this.paintOpacity = 128;
    this.pixels = new Map(); calls.replacements++;
  }
  Bitmap.prototype.clear = function() { this.pixels.clear(); };
  Bitmap.prototype.paint = function(x, y, width, height, value) {
    for (let py = Math.max(0, y); py < Math.min(this.height, y + height); py++) {
      for (let px = Math.max(0, x); px < Math.min(this.width, x + width); px++) {
        this.pixels.set(`${px},${py}`, value);
      }
    }
  };
  function Hud() {
    this.width = 816; this.height = 624; this.x = 413; this.y = 565;
    this.contents = new Bitmap(780, 588); this.text = 'Home';
  }
  Hud.prototype.refresh = function() {
    calls.refreshes++;
    if (this.contents) { this.contents.clear(); this.drawHud(); }
  };
  Hud.prototype.drawHud = function() {
    if (this.fail) throw Error('draw failed');
    this.drawTextEx(this.text, 40, 0); this.drawIcon(3, 0, 0);
  };
  Hud.prototype.drawTextEx = function(text, x, y) {
    this.contents.paint(x, y, text.length * 8, 24, 'text'); return text.length * 8;
  };
  Hud.prototype.drawIcon = function(_index, x, y) { this.contents.paint(x, y, 32, 32, 'icon'); };
  Hud.prototype.lineHeight = () => 36;
  Hud.prototype.contentsWidth = function() { return this.width - 36; };
  Hud.prototype.contentsHeight = function() { return this.height - 36; };
  const line = { drawLine() {} }, icon = { drawLine() {} };
  const methods = [Hud.prototype.refresh, Hud.prototype.drawHud, Hud.prototype.drawTextEx, line.drawLine, icon.drawLine];
  // Qualified fixture functions stand in for the independently reviewed plugin bodies.
  const hashes = ['e7466e3e6c5677d8cca3dc0ef6c99caca7bc18c9950b15d52ddf3ddbb7a2b24e',
    'cc912db5761746c12877c758cc327d0be30d6938bed4512af509cb1cb42cf5df',
    'bb13fc2904c33710ef381e51b451fbd694a8b517d4f846fcb6007087c60dcf18',
    '64568cb082e3f33f7a50c9dbe5c26e400292157a6142ce485683505ab0ebf2f1',
    '848307224df9db45d99389ca78c5adc4fdabaaf6776b74788ae0c0cda264e495'];
  // Give the two manager fixtures distinct function source strings.
  icon.drawLine = function drawIconLine() {};
  methods[4] = icon.drawLine;
  const bodyHashes = new Map(methods.map((fn, i) => [fn.toString(), hashes[i]]));
  const addons = { OrangeHudLine: { manager: line, params: [] }, OrangeHudVariableIcon: { manager: icon, params: [] } };
  const realm = { Window_OrangeHud: Hud, Bitmap, Window_Base: { _iconWidth: 32, _iconHeight: 32 },
    OrangeHudDefaultLine: line, OrangeHudVariableIcon: icon, OrangeHud: { _addons: addons },
    __pmjsBuiltinRequire() { return { createHash() { let body; return {
      update(value) { body = value; return this; }, digest() { return unknown ? 'unknown' : bodyHashes.get(body); }
    }; } }; },
    PMJS: { plugins: { registerOptimization() {}, onLoaded(_name, _id, callback) { callback(); } },
      phases: { on(_phase, _id, callback) { callback(); } },
      optimizations: { isEnabled: () => true, refuse() { calls.refused = true; } } }
  };
  vm.runInNewContext(source, realm);
  return { window: new Hud(), realm, calls, addons, Bitmap };
}

test('HUD contents compact without changing geometry or destroying retained bitmaps', () => {
  const { window, calls } = fixture();
  const old = window.contents;
  window.refresh();
  assert.deepEqual([window.width, window.height, window.x, window.y], [816, 624, 413, 565]);
  assert.ok(window.contents.width < 150 && window.contents.height < 80);
  assert.deepEqual(window.contents.pixels, old.pixels);
  assert.equal(window.contents.paintOpacity, 128);
  assert.equal(calls.refreshes, 2);
  const bitmap = window.contents;
  window.refresh();
  assert.equal(window.contents, bitmap);
  assert.equal(calls.refreshes, 3);
});

test('longer text grows before presentation and shorter text does not churn allocations', () => {
  const { window } = fixture(); window.refresh();
  const retained = window.contents, retainedPixels = new Map(retained.pixels);
  window.text = 'Much longer destination'; window.refresh();
  assert.ok(window.contents.width > retained.width);
  assert.equal(window.contents.pixels.get('220,0'), 'text');
  assert.ok(retained.pixels.size >= retainedPixels.size);
  const grown = window.contents;
  window.text = 'X'; window.refresh();
  assert.equal(window.contents, grown);
  assert.equal(window.contents.pixels.has('220,0'), false);
});

test('escape text and unknown addons restore original dimensions', () => {
  for (const mutate of [
    f => { f.window.text = '\\I[4]'; },
    f => { f.addons.Custom = { manager: {}, params: [] }; },
    f => { f.addons.OrangeHudLine.params.push({ ScriptPattern: 'Math.random()' }); }
  ]) {
    const f = fixture(); f.window.refresh(); mutate(f); f.window.refresh();
    assert.deepEqual([f.window.contents.width, f.window.contents.height], [780, 588]);
  }
});

test('replacement contents establish a new size limit and layout changes restore full contents', () => {
  const f = fixture(); f.window.refresh();
  f.window.contents = new f.Bitmap(120, 80); f.window.refresh();
  f.window.text = 'x'.repeat(100); f.window.refresh();
  assert.equal(f.window.contents.width, 120);
  f.window.width = 400; f.window.refresh();
  assert.deepEqual([f.window.contents.width, f.window.contents.height], [364, 588]);
});

test('failed drawing restores measurement state and replaced producers use the ordinary path', () => {
  const f = fixture(); f.window.fail = true;
  assert.throws(() => f.window.refresh(), /draw failed/);
  f.window.fail = false; f.window.refresh();
  assert.ok(f.window.contents.width < 150);
  f.window.drawHud = function() { assert.equal(this.contents.width, 780); };
  f.window.refresh();
  assert.equal(f.window.contents.width, 780);
});

test('unknown plugin sources are refused without replacing refresh', () => {
  const f = fixture({ unknown: true }); f.window.refresh();
  assert.equal(f.calls.refused, true);
  assert.equal(f.window.contents.width, 780);
  assert.equal(f.calls.refreshes, 1);
});
