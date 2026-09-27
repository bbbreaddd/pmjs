'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const native = require(path.resolve(process.argv[2]));
native.initialize({ gameRoot: path.resolve(process.argv[3]), assetRoot: '',
  width: 320, height: 128, windowTitle: 'text layout test' });
const font = 'text-shaping.ttf';
const size = 28;

function draw(text, fonts = font, stroke = 0, realized = false) {
  const canvas = native.canvas.create(320, 128);
  if (realized) native.canvas.readPixels(canvas.handle, 0, 0, 1, 1);
  native.canvas.drawText(canvas.handle, fonts, text, 16, 64, size, 0xffffffff, stroke);
  const pixels = Array.from(native.canvas.readPixels(canvas.handle, 0, 0, 320, 128));
  native.canvas.release(canvas.handle);
  return pixels;
}
function metrics(text, fonts = font) {
  const result = native.canvas.measureTextMetrics(fonts, text, size);
  assert.equal(result.width, native.canvas.measureText(fonts, text, size));
  return result;
}

function inkBounds(pixels) {
  let left = 320, top = 128, right = 0, bottom = 0;
  for (let y = 0; y < 128; y++) {
    for (let x = 0; x < 320; x++) {
      if (!pixels[(y * 320 + x) * 4 + 3]) continue;
      left = Math.min(left, x); top = Math.min(top, y);
      right = Math.max(right, x + 1); bottom = Math.max(bottom, y + 1);
    }
  }
  return right ? [left - 16, top - 64, right - 16, bottom - 64] : [0, 0, 0, 0];
}

for (const cp of [0xAD, 0x34F, 0x61C, 0x200B, 0x200C, 0x200D, 0x200E, 0x200F,
  0x202A, 0x202E, 0x2060, 0x2066, 0xFE0F, 0xFEFF, 0xE0100]) {
  const mark = String.fromCodePoint(cp);
  assert.deepEqual(metrics(`X${mark}`), metrics('X'), `U+${cp.toString(16)} metrics`);
  assert.deepEqual(metrics(mark).width, 0);
  for (const stroke of [0, 4]) {
    assert.deepEqual(draw(`X${mark}`, font, stroke), draw('X', font, stroke));
    assert.ok(draw(mark, font, stroke).every(pixel => pixel === 0));
  }
}
for (const whitespace of ['\t', '\n', '\f', '\r']) {
  assert.deepEqual(metrics(`A${whitespace}B`), metrics('A B'));
  assert.deepEqual(draw(`A${whitespace}B`), draw('A B'));
}
assert.deepEqual(metrics('A\r\nB'), metrics('A  B'));
// Vertical tab is not HTML ASCII whitespace and must not turn into a space.
assert.notEqual(metrics('A\vB').width, metrics('A B').width);
assert.deepEqual(draw('X\u200E'), draw('X', font, 0, true));
assert.deepEqual(draw('e\u0301'), draw('é'));
assert.equal(metrics('e\u0301').width, metrics('é').width);
assert.ok(metrics('AV').width < metrics('A').width + metrics('V').width, 'kerning');
assert.ok(metrics('ffi').width < 2 * metrics('f').width + metrics('i').width, 'ligature');
assert.deepEqual(draw('❤\uFE0F'), draw('♥'), 'variation selector selects the fixture alternate');
assert.notDeepEqual(draw('❤\uFE0F'), draw('❤'));
assert.notDeepEqual(draw('لا'), draw('ل\u200Cا'), 'ZWNJ changes Arabic shaping before being removed');
assert.ok(metrics('\u{1F9D1}').width > 0, 'unsupported visible character keeps notdef');
assert.ok(draw('\u{1F9D1}').some(pixel => pixel !== 0));
assert.ok(metrics('e\u0301', 'testfont.ttf').width > 0);
const stack = ['testfont.ttf', font];
assert.deepEqual(metrics('e\u0301', stack), metrics('e\u0301', font),
  'base and combining mark fall back as one cluster');
assert.deepEqual(draw('e\u0301', stack), draw('e\u0301', font));
assert.deepEqual(draw('é', stack, 4), draw('é', font, 4));
for (const text of ['لا', 'سلام']) {
  assert.deepEqual(metrics(text, stack), metrics(text, font), 'Arabic fallback shapes adjacent clusters');
  assert.deepEqual(draw(text, stack), draw(text, font));
}
assert.deepEqual(metrics('\u{1F9D1}', stack), metrics('\u{1F9D1}', 'testfont.ttf'),
  'failed fallback retains primary notdef');
for (const text of ['AV', 'ffi', 'e\u0301', 'AéB', 'سلام']) {
  assert.deepEqual(draw(text), draw(text, font, 0, true), 'deferred and realized layout');
  const pixels = draw(text);
  const bounds = metrics(text);
  for (let y = 0; y < 128; y++) {
    for (let x = 0; x < 320; x++) {
      if (!pixels[(y * 320 + x) * 4 + 3]) continue;
      assert.ok(x >= 16 - bounds.actualBoundingBoxLeft &&
        x < 16 + bounds.actualBoundingBoxRight &&
        y >= 64 - bounds.actualBoundingBoxAscent &&
        y < 64 + bounds.actualBoundingBoxDescent, `${text} ink inside measured bounds`);
    }
  }
}
const cases = ['X', 'X\u200E', '\u200F', '\u061C', 'A\u200DB', 'A\u200CB',
  '❤\uFE0F', 'é', 'e\u0301', 'AV', 'ffi', 'A\nB', 'AéB', 'سلام', 'ل\u200Cا'];
if (process.argv.includes('--report')) {
  console.log(JSON.stringify(Object.fromEntries(cases.map(text =>
    [text, { ...metrics(text), inkBounds: inkBounds(draw(text)) }]))));
} else {
  console.log('[pmjs-text-layout] preparation, shaping, fallback and pixels passed');
}
