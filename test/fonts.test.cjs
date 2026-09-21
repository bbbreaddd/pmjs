'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const runtimeRoot = path.resolve(__dirname, '..');
const jsDir = path.join(runtimeRoot, 'js');

function createFontSandbox(options = {}) {
  const existingFiles = new Set(options.existingFiles || []);
  const measureCalls = [];
  const drawCalls = [];
  const loadedScripts = [];

  const sandbox = {
    console,
    Math,
    String,
    Number,
    Boolean,
    Object,
    Array,
    RegExp,
    Uint8Array,
    Uint8ClampedArray,
    nativeWindowState: { visible: true, focused: true },
    documentTarget: {
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() {}
    },
    pmjsGameConfig: options.pmjsGameConfig || {},
    nativeBootPhase: () => {},
    Graphics: Object.assign(function() {}, { width: 100, height: 100 }),
    NativeHost: {
      runtime: {
        env: () => '',
        loadScript: (p) => { loadedScripts.push(p); }
      },
      fs: {
        exists: (p) => {
          options.probeCalls && options.probeCalls.push(p);
          return existingFiles.has(p);
        },
        readText: (p) => {
          if (options.vfsFiles && Object.prototype.hasOwnProperty.call(options.vfsFiles, p)) {
            return options.vfsFiles[p];
          }
          return null;
        }
      },
      canvas: {
        canLoadFont: (fontPath) => {
          options.probeCalls && options.probeCalls.push(fontPath);
          if (options.invalidFontFiles && options.invalidFontFiles.includes(fontPath)) {
            return false;
          }
          return existingFiles.has(fontPath);
        },
        measureText: (fontPath, text, size) => {
          measureCalls.push({ fontPath, text, size });
          return text.length * (size || 10) * 0.6;
        },
        measureTextMetrics: (fontPath, text, size) => {
          measureCalls.push({ fontPath, text, size });
          return {
            width: text.length * (size || 10) * 0.6,
            actualAscent: (size || 10) * 0.8,
            actualDescent: (size || 10) * 0.2
          };
        },
        drawText: (handle, fontPath, text, x, y, size, rgba, stroke) => {
          drawCalls.push({ handle, fontPath, text, x, y, size, rgba, stroke });
          return true;
        }
      }
    }
  };
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);

  const eventsCode = fs.readFileSync(path.join(jsDir, 'pmjs-web/events.js'), 'utf8');
  vm.runInContext(eventsCode, context);

  const fontsCode = fs.readFileSync(path.join(jsDir, 'pmjs-web/fonts.js'), 'utf8');
  vm.runInContext(fontsCode, context);

  const canvasCode = fs.readFileSync(path.join(jsDir, 'pmjs-web/canvas.js'), 'utf8');
  vm.runInContext(canvasCode, context);

  const elementsCode = fs.readFileSync(path.join(jsDir, 'pmjs-web/elements.js'), 'utf8');
  vm.runInContext(elementsCode, context);

  const mvFontsCode = fs.readFileSync(path.join(jsDir, 'pmjs-mv/fonts.js'), 'utf8');
  vm.runInContext(mvFontsCode, context);

  return { context, measureCalls, drawCalls, loadedScripts };
}

test('PMJS.fonts.normalizeFontUrl handles all valid game paths and rejects traversal/remote', () => {
  const { context } = createFontSandbox();
  const norm = context.PMJS.fonts.normalizeFontUrl;

  assert.equal(norm('fonts/foo.ttf'), 'fonts/foo.ttf');
  assert.equal(norm('./fonts/foo.ttf'), 'fonts/foo.ttf');
  assert.equal(norm('/game/fonts/foo.ttf'), 'fonts/foo.ttf');
  assert.equal(norm('game/fonts/foo.ttf'), 'fonts/foo.ttf');
  assert.equal(norm('file:///game/fonts/foo.ttf'), 'fonts/foo.ttf');
  assert.equal(norm('file://game/fonts/foo.ttf'), 'fonts/foo.ttf');

  assert.equal(norm('fonts/foo.ttf?version=1.2#hash'), 'fonts/foo.ttf');

  assert.equal(norm('fonts/My%20Font.ttf'), 'fonts/My Font.ttf');

  assert.equal(norm('BestTen-CRT.ttf', 'fonts/gamefont.css'), 'fonts/BestTen-CRT.ttf');
  assert.equal(norm('./BestTen-CRT.ttf', 'fonts/gamefont.css'), 'fonts/BestTen-CRT.ttf');
  assert.equal(norm('/game/fonts/foo.ttf', 'fonts/gamefont.css'), 'fonts/foo.ttf');
  assert.equal(norm('file:///game/fonts/foo.ttf', 'fonts/gamefont.css'), 'fonts/foo.ttf');
  assert.equal(norm('/fonts/foo.ttf', 'fonts/gamefont.css'), 'fonts/foo.ttf');
  assert.equal(norm('file:///etc/foo.ttf', 'fonts/gamefont.css'), '');
  assert.equal(norm('file:///etc/foo.ttf'), '');

  assert.equal(norm('../secret.ttf'), '');
  assert.equal(norm('../../secret.ttf'), '');

  assert.equal(norm('http://example.com/font.ttf'), '');
  assert.equal(norm('https://example.com/font.ttf'), '');
  assert.equal(norm('data:font/ttf;base64,123'), '');
});

test('PMJS.fonts.parseDescriptor parses font shorthand, font stacks, and space-containing names', () => {
  const { context } = createFontSandbox();
  const parse = context.PMJS.fonts.parseDescriptor;

  const single = parse('16px default1');
  assert.equal(single.size, 16);
  assert.equal(single.style, 'normal');
  assert.equal(single.weight, 400);
  assert.deepEqual(Array.from(single.families), ['default1']);

  const stack = parse('28px GameFont, Verdana, Arial, Courier New');
  assert.deepEqual(Array.from(stack.families), ['GameFont', 'Verdana', 'Arial', 'Courier New']);
  assert.equal(stack.size, 28);

  const quoted = parse('bold italic 20px "Times New Roman", sans-serif');
  assert.deepEqual(Array.from(quoted.families), ['Times New Roman', 'sans-serif']);
  assert.equal(quoted.size, 20);
  assert.equal(quoted.style, 'italic');
  assert.equal(quoted.weight, 700);

  const numericWeight = parse('600 24px HeaderFont');
  assert.equal(numericWeight.weight, 600);
  assert.equal(numericWeight.size, 24);
  assert.deepEqual(Array.from(numericWeight.families), ['HeaderFont']);
  const quotedWithComma = parse('bold 18px "Family, With Comma", sans-serif');
  assert.deepEqual(Array.from(quotedWithComma.families), ['Family, With Comma', 'sans-serif']);
  assert.equal(quotedWithComma.size, 18);
  assert.equal(quotedWithComma.weight, 700);
});

test('PMJS.fonts registers initial config, allows dynamic overwrite, and tests readiness', () => {
  const probeCalls = [];
  const { context } = createFontSandbox({
    existingFiles: ['fonts/initial.ttf', 'fonts/replaced.ttf', 'fonts/corrupt.ttf', 'fonts/gamefont.ttf'],
    invalidFontFiles: ['fonts/corrupt.ttf'],
    probeCalls: probeCalls,
    pmjsGameConfig: {
      fonts: {
        GameFont: 'fonts/initial.ttf',
        ConfigOnly: 'fonts/missing.ttf'
      }
    }
  });

  const fonts = context.PMJS.fonts;

  assert.equal(fonts.isFamilyLoaded('GameFont'), true);
  assert.equal(fonts.isFamilyLoaded('ConfigOnly'), false);
  assert.equal(fonts.isFamilyLoaded('UnknownFamily'), false);

  fonts.registerFace('CorruptFont', 'fonts/corrupt.ttf');
  assert.equal(fonts.isFamilyLoaded('CorruptFont'), false);

  fonts.registerFace('GameFont', 'fonts/replaced.ttf');
  const resolved = fonts.resolveDescriptor('20px GameFont');
  assert.equal(resolved.faces[0].path, 'fonts/replaced.ttf');

  probeCalls.length = 0;
  assert.equal(fonts.isFamilyLoaded('GameFont'), true);
  fonts.resolveDescriptor('20px GameFont');
  fonts.resolveDescriptor('20px GameFont');
  context.contextFont('20px GameFont');
  context.contextFont('20px GameFont');
  assert.equal(probeCalls.length, 0);

  probeCalls.length = 0;
  assert.equal(fonts.isFamilyLoaded('CorruptFont'), false);
  assert.equal(fonts.isFamilyLoaded('CorruptFont'), false);
  assert.equal(probeCalls.length, 0);

  fonts.registerFace('GameFont', 'fonts/initial.ttf');
  probeCalls.length = 0;
  assert.equal(fonts.isFamilyLoaded('GameFont'), true);
  assert.equal(probeCalls.length, 1);
  assert.equal(probeCalls[0], 'fonts/initial.ttf');

  assert.equal(fonts._registeredFamilies, undefined);
  const snapshot = fonts.getRegisteredFaces();
  assert.equal(typeof snapshot, 'object');
  assert.equal(snapshot.gamefont.path, 'fonts/initial.ttf');
  snapshot.gamefont.path = 'mutated.ttf';
  assert.equal(fonts.getRegisteredFaces().gamefont.path, 'fonts/initial.ttf');
});

test('Unregistered GameFont returns false even when fonts/gamefont.ttf exists', () => {
  const { context } = createFontSandbox({
    existingFiles: ['fonts/gamefont.ttf']
  });

  assert.equal(context.PMJS.fonts.isFamilyLoaded('GameFont'), false);
  if (context.Graphics && context.Graphics.isFontLoaded) {
    assert.equal(context.Graphics.isFontLoaded('GameFont'), false);
  }
});

test('Stock MV Graphics.loadFont registers @font-face through style.sheet.insertRule end-to-end', () => {
  const { context } = createFontSandbox({
    existingFiles: ['fonts/VCR_OSD_MONO_1.001.ttf', 'fonts/BestTen-CRT.ttf']
  });

  context.Graphics = context.Graphics || {};
  context.Graphics._createFontLoader = function(name) {
    var div = context.document.createElement('div');
    var text = context.document.createTextNode('.');
    div.style.fontFamily = name;
    div.style.fontSize = '0px';
    div.style.color = 'transparent';
    div.style.position = 'absolute';
    div.style.margin = 'auto';
    div.style.top = '0px';
    div.style.left = '0px';
    div.style.width = '1px';
    div.style.height = '1px';
    div.appendChild(text);
    context.document.body.appendChild(div);
  };
  context.Graphics.loadFont = function(name, url) {
    var style = context.document.createElement('style');
    var head = context.document.getElementsByTagName('head');
    var rule = '@font-face { font-family: "' + name + '"; src: url("' + url + '"); }';
    style.type = 'text/css';
    head.item(0).appendChild(style);
    style.sheet.insertRule(rule, 0);
    this._createFontLoader(name);
  };

  context.Graphics.loadFont('default1', 'fonts/VCR_OSD_MONO_1.001.ttf');
  context.Graphics.loadFont('japanese', 'fonts/BestTen-CRT.ttf');

  assert.equal(context.PMJS.fonts.isFamilyLoaded('default1'), true);
  assert.equal(context.PMJS.fonts.isFamilyLoaded('japanese'), true);

  assert.equal(context.Graphics.isFontLoaded('default1'), true);
  assert.equal(context.Graphics.isFontLoaded('japanese'), true);
  assert.equal(context.Graphics.isFontLoaded('nonexistent'), false);
});

test('MV adapter loads fonts/gamefont.css and registers GameFont relative to stylesheet', () => {
  const { context } = createFontSandbox({
    existingFiles: ['fonts/BestTen-CRT.ttf'],
    vfsFiles: {
      'fonts/gamefont.css': '@font-face {\n    font-family: GameFont;\n    src: url("BestTen-CRT.ttf");\n}\n'
    }
  });

  const mvFontsCode = fs.readFileSync(path.join(jsDir, 'pmjs-mv/fonts.js'), 'utf8');
  vm.runInContext(mvFontsCode, context);

  assert.equal(context.PMJS.fonts.isFamilyLoaded('GameFont'), true);
  const resolved = context.PMJS.fonts.resolveDescriptor('24px GameFont');
});

test('registerStylesheet resolves root-absolute @font-face url without stylesheet base', () => {
  const { context } = createFontSandbox({
    existingFiles: ['fonts/foo.ttf']
  });

  context.PMJS.fonts.registerStylesheet(
    '@font-face {\n  font-family: AbsoluteFont;\n  src: url("/game/fonts/foo.ttf");\n}',
    'fonts/gamefont.css'
  );

  const resolved = context.PMJS.fonts.resolveDescriptor('16px AbsoluteFont');
  assert.equal(resolved.faces[0].path, 'fonts/foo.ttf');
});


test('Dynamic font switching: resolve selected face for both drawText and measureText', () => {
  const { context, measureCalls } = createFontSandbox({
    existingFiles: ['fonts/PrimaryFont.ttf', 'fonts/SecondaryFont.ttf'],
    vfsFiles: {
      'fonts/gamefont.css': '@font-face {\n    font-family: GameFont;\n    src: url("PrimaryFont.ttf");\n}\n'
    }
  });

  const mvFontsCode = fs.readFileSync(path.join(jsDir, 'pmjs-mv/fonts.js'), 'utf8');
  vm.runInContext(mvFontsCode, context);

  context.PMJS.fonts.registerFontFaceRule('@font-face { font-family: "secondary"; src: url("fonts/SecondaryFont.ttf"); }');
  context.PMJS.fonts.registerFontFaceRule('@font-face { font-family: "primary"; src: url("fonts/PrimaryFont.ttf"); }');

  const resolvedSecondary = context.contextFont('16px secondary');
  assert.equal(resolvedSecondary.path, 'fonts/SecondaryFont.ttf');

  const resolvedPrimary = context.contextFont('16px primary');
  assert.equal(resolvedPrimary.path, 'fonts/PrimaryFont.ttf');

  const dummyCanvas = { width: 100, height: 50, _ensureNativeCanvas: () => ({ handle: 1 }) };
  const ctx = new context.CanvasContext2D(dummyCanvas);
  ctx.font = '16px secondary';
  ctx.measureText('Hello');
  assert.equal(measureCalls[measureCalls.length - 1].fontPath, 'fonts/SecondaryFont.ttf');

  ctx.font = '16px primary';
  ctx.measureText('World');
  assert.equal(measureCalls[measureCalls.length - 1].fontPath, 'fonts/PrimaryFont.ttf');
});

test('Multiple dynamic faces and font stack with spaces', () => {
  const { context } = createFontSandbox({
    existingFiles: [
      'fonts/CustomFont_A.ttf',
      'fonts/CustomFont_B.ttf',
      'fonts/CustomFont_C.ttf'
    ],
    vfsFiles: {
      'fonts/gamefont.css': '@font-face {\n    font-family: GameFont;\n    src: url("CustomFont_B.ttf");\n}\n'
    }
  });

  const mvFontsCode = fs.readFileSync(path.join(jsDir, 'pmjs-mv/fonts.js'), 'utf8');
  vm.runInContext(mvFontsCode, context);

  context.PMJS.fonts.registerFace('CustomFont_A', 'fonts/CustomFont_A.ttf');
  context.PMJS.fonts.registerFace('CustomFont_B', 'fonts/CustomFont_B.ttf');
  context.PMJS.fonts.registerFace('CustomFont_C', 'fonts/CustomFont_C.ttf');

  const resolvedStack = context.contextFont('28px GameFont, Verdana, Arial, Courier New');
  assert.equal(resolvedStack.path, 'fonts/CustomFont_B.ttf');
  assert.equal(resolvedStack.size, 28);

  const resolvedA = context.contextFont('28px CustomFont_A');
  assert.equal(resolvedA.path, 'fonts/CustomFont_A.ttf');

  const resolvedC = context.contextFont('20px CustomFont_C');
  assert.equal(resolvedC.path, 'fonts/CustomFont_C.ttf');
});

test('Plugin wrap ordering: PMJS drawText accelerated and wrapped by plugin font selector', () => {
  const { context, drawCalls } = createFontSandbox({
    existingFiles: ['fonts/PrimaryFont.ttf', 'fonts/SecondaryFont.ttf']
  });

  context.colorWithGlobalAlpha = () => 0xffffffff;

  function MockBitmap() {
    this.width = 100;
    this.height = 100;
    this.fontSize = 16;
    this.fontFace = 'GameFont';
    this.outlineWidth = 2;
    this.outlineColor = '#000000';
    this.textColor = '#ffffff';
    this._context = {
      globalAlpha: 1,
      save() {},
      restore() {},
      strokeText() {},
      fillText() {},
      measureText: function() { return { width: 42 }; }
    };
    this._canvas = { _ensureNativeCanvas() { return { handle: 1 }; } };
  }
  MockBitmap.prototype._makeFontNameText = function() {
    return (this.fontSize || 16) + 'px ' + (this.fontFace || 'GameFont');
  };
  MockBitmap.prototype._setDirty = function() {};
  MockBitmap.prototype._drawTextOutline = function(text, tx, ty, maxWidth) {
    var context = this._context;
    context.strokeStyle = this.outlineColor;
    context.strokeText(text, tx, ty, maxWidth);
  };
  MockBitmap.prototype._drawTextBody = function(text, tx, ty, maxWidth) {
    var context = this._context;
    context.fillStyle = this.textColor;
    context.fillText(text, tx, ty, maxWidth);
  };
  MockBitmap.prototype.drawText = function(text, x, y, maxWidth, lineHeight, align) {
    if (text !== undefined) {
      var tx = x;
      var ty = y + lineHeight - (lineHeight - this.fontSize * 0.7) / 2;
      var ctx = this._context;
      var alpha = ctx.globalAlpha;
      maxWidth = maxWidth || 0xffffffff;
      ctx.save();
      ctx.font = this._makeFontNameText();
      this._drawTextOutline(text, tx, ty, maxWidth);
      this._drawTextBody(text, tx, ty, maxWidth);
      ctx.restore();
      this._setDirty();
    }
  };
  MockBitmap.prototype.measureTextWidth = function(text) {
    var ctx = this._context;
    ctx.save();
    ctx.font = this._makeFontNameText();
    var width = ctx.measureText(text).width;
    ctx.restore();
    return width;
  };

  context.Bitmap = MockBitmap;
  context.Sprite = function() {};
  context.Graphics = Object.assign(function() {}, { width: 100, height: 100 });
  context.Input = function() {};

  const bitmapCode = fs.readFileSync(path.join(jsDir, 'pmjs-mv/bitmap.js'), 'utf8');
  vm.runInContext(bitmapCode, context);

  context.PMJS.fonts.registerFace('customFace', 'fonts/PrimaryFont.ttf');

  const capturedPmjsDrawText = context.Bitmap.prototype.drawText;
  context.Bitmap.prototype.drawText = function(text, x, y, maxWidth, lineHeight, align) {
    this.fontFace = 'customFace';
    capturedPmjsDrawText.call(this, text, x, y, maxWidth, lineHeight, align);
  };

  const bmp = new context.Bitmap();
  bmp.drawText('Test Text', 0, 0, 100, 20, 'left');

  assert.equal(drawCalls.length, 2);
  assert.equal(drawCalls[0].fontPath, 'fonts/PrimaryFont.ttf');

  bmp.fontFace = 'customFace';
  const width = bmp.measureTextWidth('Test Text');
  assert.equal(width > 0, true);
});
