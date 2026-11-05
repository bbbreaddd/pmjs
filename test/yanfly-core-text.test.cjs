/* global Bitmap, Yanfly */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { makeBitmapTextHarness } = require('./helpers/bitmap-text-harness.cjs');
const { pinSourceFingerprint } = require('./helpers/reviewed-function-fixture.cjs');
const adapter = fs.readFileSync(require.resolve('../js/pmjs-plugins/yanfly/core-engine.js'), 'utf8');
const optimization = 'plugins.yanfly.core-native-text';

function mockNative(disabled = false) {
  let handle = 0;
  const calls = { text: [], outlined: [] };
  return { calls, runtime: { env: name => disabled && name === 'PMJS_DISABLE_OPT' ? optimization : '' }, canvas: {
    create(width, height) { return { handle: ++handle, width, height }; },
    release() {}, clear() {},
    glyphStats: () => ({ backend: 'skia65' }),
    measureText: (_paths, text, size) => text.length * size / 2,
    drawText(...args) { calls.text.push(args); },
    drawOutlinedText(...args) { calls.outlined.push(args); }
  } };
}

// Independent plugin-contract fixtures preserve wrapper ordering and side effects.
function installPluginFixture() {
  var stock = Bitmap.prototype.drawText;
  globalThis.Yanfly = { Core: { Bitmap_drawText: stock }, Message: {
    Bitmap_makeFontNameText: Bitmap.prototype._makeFontNameText
  } };
  Bitmap.prototype._makeFontNameText = function() {
    return (this.fontBold ? 'Bold ' : '') + Yanfly.Message.Bitmap_makeFontNameText.call(this);
  };
  Bitmap.prototype.drawText = function(text, x, y, width, height, align) {
    this.roundingCalls = (this.roundingCalls || 0) + 1;
    Yanfly.Core.Bitmap_drawText.call(this, text, Math.floor(x), Math.floor(y),
      Math.floor(width < 0 ? 0 : width), Math.floor(height), align);
  };
  var rounded = Bitmap.prototype.drawText;
  Bitmap.prototype.drawText = function(text, x, y, width, height, align) {
    this.fontOptionCalls = (this.fontOptionCalls || 0) + 1;
    this.fontFace = this.selectedFont || 'GameFont';
    this.fontSize = this.selectedSize || 24;
    this.translationCalls = (this.translationCalls || 0) + 1;
    if (text === 'original' && this.translatedText !== undefined) text = this.translatedText;
    return rounded.call(this, text, x, y, width, height, align);
  };
}

function harness({ native = mockNative(), disabled = false, beforeInstall, stockFont = false } = {}) {
  const testNative = { ...native, runtime: { ...native.runtime,
    env: name => disabled && name === 'PMJS_DISABLE_OPT' ? optimization : native.runtime.env(name) } };
  const context = makeBitmapTextHarness(testNative, true, true);
  vm.runInContext(fs.readFileSync(require.resolve('../js/pmjs-web/fonts.js'), 'utf8'), context);
  context.PMJS.fonts.registerFace('GameFont', 'testfont.ttf');
  context.__pmjsBuiltinRequire = require;
  const original = context.Bitmap.prototype.drawText;
  const originalFont = context.Bitmap.prototype._makeFontNameText;
  vm.runInContext('(' + installPluginFixture.toString() + ')()', context);
  const boldFont = context.Bitmap.prototype._makeFontNameText;
  if (stockFont) context.Bitmap.prototype._makeFontNameText = originalFont;
  const finalMethod = context.Bitmap.prototype.drawText;
  const loaded = [];
  context.PMJS.plugins = {
    registerOptimization(_plugin, definition) { context.PMJS.optimizations.register(definition); },
    onLoaded(name, _owner, callback) { loaded.push(callback); }
  };
  if (beforeInstall) beforeInstall(context);
  let source = pinSourceFingerprint(adapter, 'stockFontHash', originalFont);
  source = pinSourceFingerprint(source, 'boldFontHash', boldFont);
  vm.runInContext(source, context);
  return { context, native, original, originalFont, finalMethod,
    install() { loaded.forEach(callback => callback()); context.PMJS.phases.emit('afterGuestPlugins'); },
    bitmap() { return new context.Bitmap(240, 72); } };
}

function draw(bitmap, text = 'Lantern', align = 'left') {
  return bitmap.drawText(text, 4.75, 5.25, 180.75, 43.25, align);
}

test('adapts only the captured leaf after plugins while preserving translation, fonts and rounding', () => {
  const h = harness();
  assert.equal(h.context.Yanfly.Core.Bitmap_drawText, h.original);
  h.install();
  assert.equal(h.context.Bitmap.prototype.drawText, h.finalMethod);
  assert.notEqual(h.context.Yanfly.Core.Bitmap_drawText, h.original);
  assert.match(h.context.PMJS.optimizations.reason('bitmap.native-draw-text'), /modified Bitmap text/);
  const b = h.bitmap(); b.translatedText = 'ランプ'; b.selectedSize = 28; b.fontBold = true;
  const c = b._context;
  c.font = '12px old'; c.fillStyle = '#112233'; c.lineJoin = 'bevel'; c.globalAlpha = 0.4;
  const revision = b._canvas.__pmjsContentRevision;
  draw(b, 'original', 'center');
  assert.equal(b.fontOptionCalls, 1); assert.equal(b.translationCalls, 1); assert.equal(b.roundingCalls, 1);
  assert.equal(b.dirtyCount, 1); assert.ok(b._canvas.__pmjsContentRevision > revision);
  assert.equal(h.native.calls.text.length, 0); assert.equal(h.native.calls.outlined.length, 1);
  const args = h.native.calls.outlined[0];
  assert.equal(args[2], 'ランプ'); assert.equal(args[3], 94); assert.equal(args[5], 28);
  assert.equal(args[9], 180); assert.equal(args[10], 'center'); assert.equal(args[11].bold, true);
  assert.equal(c.font, '12px old'); assert.equal(c.fillStyle, '#112233');
  assert.equal(c.lineJoin, 'bevel'); assert.equal(c.globalAlpha, 0.4);
});

test('word-wrap no-op drawing leaves suppress raster without bypassing public wrappers', () => {
  const h = harness(); h.install(); const b = h.bitmap();
  const outline = b._drawTextOutline, body = b._drawTextBody;
  b._drawTextOutline = b._drawTextBody = function() {};
  draw(b);
  assert.equal(h.native.calls.outlined.length, 0); assert.equal(h.native.calls.text.length, 0);
  assert.equal(b.dirtyCount, 1); assert.equal(b.fontOptionCalls, 1); assert.equal(b.roundingCalls, 1);
  delete b._drawTextOutline; delete b._drawTextBody;
  assert.equal(b._drawTextOutline, outline); assert.equal(b._drawTextBody, body);
  draw(b); assert.equal(h.native.calls.outlined.length, 1);
});

test('late instance and prototype outline/body overrides retain authored calls', () => {
  for (const method of ['_drawTextOutline', '_drawTextBody']) for (const instance of [true, false]) {
    const h = harness(); h.install(); const b = h.bitmap(); let calls = 0;
    const warnings = [];
    h.context.console = { ...console, warn(message) { warnings.push(message); } };
    h.context.PMJS.optimizations.finalize();
    assert.notEqual(h.context.Yanfly.Core.Bitmap_drawText, h.original);
    const target = instance ? b : h.context.Bitmap.prototype, original = target[method];
    target[method] = function(...args) { calls++; return original.apply(this, args); };
    draw(b);
    assert.equal(calls, 1, method); assert.equal(h.native.calls.outlined.length, 0);
    assert.equal(b.dirtyCount, 1); assert.equal(h.native.calls.text.length, 2);
    draw(b);
    assert.equal(calls, 2);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /plugins.yanfly.core-native-text refused for this use: Bitmap text methods changed after installation/);
    assert.equal(h.context.PMJS.optimizations.isEnabled(optimization), true);
  }
});

test('late font overrides and replacement captured font aliases use ordinary drawing', () => {
  for (const kind of ['instance', 'prototype', 'captured', 'message-object']) {
    const h = harness(); h.install(); const b = h.bitmap(); let calls = 0;
    assert.notEqual(h.context.Yanfly.Core.Bitmap_drawText, h.original);
    if (kind === 'instance' || kind === 'prototype') {
      const target = kind === 'instance' ? b : h.context.Bitmap.prototype, font = target._makeFontNameText;
      target._makeFontNameText = function() { calls++; return font.call(this); };
    } else {
      const previous = h.context.Yanfly.Message.Bitmap_makeFontNameText;
      const replacement = function() { calls++; return previous.call(this); };
      if (kind === 'captured') h.context.Yanfly.Message.Bitmap_makeFontNameText = replacement;
      else h.context.Yanfly.Message = { Bitmap_makeFontNameText: replacement };
    }
    draw(b);
    assert.equal(calls, 1, kind); assert.equal(h.native.calls.outlined.length, 0);
    assert.equal(h.native.calls.text.length, 2); assert.equal(b.dirtyCount, 1);
  }
});

test('an unknown captured draw leaf is refused without changing public or alias methods', () => {
  const authored = function() { this.authoredCalls = (this.authoredCalls || 0) + 1; return 'authored'; };
  const h = harness({ beforeInstall(context) { context.Yanfly.Core.Bitmap_drawText = authored; } });
  h.install(); const b = h.bitmap();
  assert.equal(h.context.Bitmap.prototype.drawText, h.finalMethod);
  assert.equal(h.context.Yanfly.Core.Bitmap_drawText, authored);
  assert.match(h.context.PMJS.optimizations.reason(optimization), /unrecognized captured/);
  assert.equal(draw(b), undefined); assert.equal(b.authoredCalls, 1);
});

test('unknown current and captured predecessor font methods refuse activation', () => {
  for (const current of [false, true]) {
    const h = harness({ beforeInstall(context) {
      const custom = function() { return '24px custom'; };
      if (current) context.Bitmap.prototype._makeFontNameText = custom;
      else context.Yanfly.Message.Bitmap_makeFontNameText = custom;
    } });
    h.install(); assert.equal(h.context.Yanfly.Core.Bitmap_drawText, h.original);
    assert.match(h.context.PMJS.optimizations.reason(optimization), /unrecognized Bitmap font/);
  }
});

test('disabled adapter keeps the ordinary leaf and all outer wrapper effects', () => {
  const h = harness({ native: mockNative(true) }); h.install(); const b = h.bitmap();
  draw(b);
  assert.equal(h.context.Yanfly.Core.Bitmap_drawText, h.original);
  assert.equal(h.context.Bitmap.prototype.drawText, h.finalMethod);
  assert.equal(h.native.calls.outlined.length, 0); assert.equal(h.native.calls.text.length, 2);
  assert.equal(b.fontOptionCalls, 1); assert.equal(b.translationCalls, 1); assert.equal(b.dirtyCount, 1);
});

test('nonprimitive text preserves repeated coercion and custom Canvas methods remain observable', () => {
  const h = harness(); h.install(); const b = h.bitmap(); let coercions = 0;
  assert.notEqual(h.context.Yanfly.Core.Bitmap_drawText, h.original);
  draw(b, { toString() { coercions++; return 'value-' + coercions; } });
  assert.equal(coercions, 2); assert.equal(h.native.calls.outlined.length, 0);
  assert.deepEqual(h.native.calls.text.map(args => args[2]), ['value-1', 'value-2']);
  let calls = 0; const fill = b._context.fillText;
  b._context.fillText = function(...args) { calls++; return fill.apply(this, args); };
  draw(b); assert.equal(calls, 1); assert.equal(h.native.calls.outlined.length, 0);
  let customCalls = 0;
  b._context = { canvas: b._canvas, _transform: [1, 0, 0, 1, 0, 0], _clipPaths: [],
    globalCompositeOperation: 'source-over', globalAlpha: 1, textAlign: 'left',
    shadowColor: 'transparent', shadowBlur: 0, shadowOffsetX: 0, shadowOffsetY: 0,
    save() {}, restore() {}, strokeText() { customCalls++; }, fillText() { customCalls++; } };
  draw(b);
  assert.equal(customCalls, 2, 'a plain context mimic must retain its drawing callbacks');
  assert.equal(h.native.calls.outlined.length, 0);
});

test('primitive values take the native path and undefined remains an ordinary no-op', () => {
  const h = harness(); h.install(); const b = h.bitmap();
  for (const value of [null, false, 0, '']) draw(b, value);
  assert.deepEqual(h.native.calls.outlined.map(args => args[2]), ['null', 'false', '0', '']);
  b.drawText(undefined, 0, 0, 180, 40, 'left');
  assert.equal(b.dirtyCount, 4); assert.equal(h.native.calls.outlined.length, 4);
});

test('omitted alignment respects retained Canvas alignment and transformed drawing falls back', () => {
  const h = harness(); h.install(); const b = h.bitmap();
  assert.notEqual(h.context.Yanfly.Core.Bitmap_drawText, h.original);
  b._context.textAlign = 'right';
  b.drawText('retained', 0, 0, 180, 40);
  assert.equal(b._context.textAlign, 'right'); assert.equal(h.native.calls.outlined.length, 0);
  assert.equal(h.native.calls.text.length, 2);
  b._context.textAlign = 'left'; b._context.translate(2, 3);
  draw(b); assert.equal(h.native.calls.outlined.length, 0); assert.equal(h.native.calls.text.length, 4);
});

test('the factory rejects altered drawing contracts and supports the unchanged stock font contract', () => {
  const h = harness({ stockFont: true }); h.install(); const b = h.bitmap(); draw(b);
  assert.equal(h.native.calls.outlined.length, 1);
  const create = h.context.PMJS.mv.bitmap.createNativeDrawText;
  assert.equal(create(function() {}, h.originalFont), null);
  h.context.Bitmap.prototype._drawTextBody = function() {};
  assert.equal(create(h.original, h.originalFont), null);
});

test('native plugin-chain pixels, context state, dirty flags and retained snapshots match ordinary drawing',
  { skip: !process.env.PMJS_NATIVE_ADDON }, () => {
    const native = require(path.resolve(process.env.PMJS_NATIVE_ADDON));
    native.initialize({ gameRoot: path.resolve(__dirname, 'assets'), width: 32, height: 32,
      windowTitle: 'Captured text drawing contracts' });
    const ordinary = harness({ native, disabled: true }), accelerated = harness({ native });
    ordinary.install(); accelerated.install();
    assert.equal(ordinary.context.Yanfly.Core.Bitmap_drawText, ordinary.original);
    assert.notEqual(accelerated.context.Yanfly.Core.Bitmap_drawText, accelerated.original);
    const initial = native.canvas.memory().liveCount;
    const read = b => native.canvas.readPremultipliedPixels(b._canvas._ensureNativeCanvas().handle, 0, 0, 240, 72);
    let comparisons = 0;
    for (const bold of [false, true]) for (const italic of [false, true]) {
      for (const width of [60, 220]) for (const alpha of [0.4, 1]) for (const realized of [false, true]) {
        const frames = [ordinary, accelerated].map(h => {
          const b = h.bitmap(), c = b._context;
          b.fontBold = bold; b.fontItalic = italic; b.selectedSize = 28;
          b.textColor = 'rgba(170,220,255,0.6)'; b.outlineColor = 'rgba(50,0,10,0.7)';
          c.fillStyle = '#123456'; c.strokeStyle = '#654321'; c.font = '18px old'; c.lineWidth = 2;
          c.lineJoin = 'bevel'; c.textAlign = 'left'; c.textBaseline = 'top'; c.globalAlpha = alpha;
          if (realized) read(b);
          const before = JSON.stringify([c.font, c.fillStyle, c.strokeStyle, c.lineWidth,
            c.lineJoin, c.textAlign, c.textBaseline, c.globalAlpha, c._transform, c._stateStack]);
          b.drawText('AVATAR office ffi', 4.75, 4.25, width, 43.75, 'center');
          assert.equal(b.dirtyCount, 1); assert.equal(b.fontOptionCalls, 1); assert.equal(b.roundingCalls, 1);
          assert.equal(JSON.stringify([c.font, c.fillStyle, c.strokeStyle, c.lineWidth,
            c.lineJoin, c.textAlign, c.textBaseline, c.globalAlpha, c._transform, c._stateStack]), before);
          const pixels = read(b), snapshot = h.context.document.createElement('canvas');
          snapshot.width = 240; snapshot.height = 72;
          snapshot.getContext('2d').drawImage(b._canvas, 0, 0);
          b._canvas._releaseNativeCanvas();
          const retained = native.canvas.readPremultipliedPixels(snapshot._ensureNativeCanvas().handle, 0, 0, 240, 72);
          assert.deepEqual(retained, pixels); snapshot._releaseNativeCanvas();
          return pixels;
        });
        assert.deepEqual(frames[0], frames[1], JSON.stringify({ bold, italic, width, alpha, realized }));
        assert.ok(frames[1].some(value => value), 'fixture must render visible pixels'); comparisons++;
      }
    }
    assert.equal(comparisons, 32); assert.equal(native.canvas.memory().liveCount, initial);
  });
