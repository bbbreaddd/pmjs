'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { installWindowDrawing } = require('../runner/native-window-drawing.cjs');

test('resource gauges preserve stock coordinates and the narrow value layout', () => {
  function Window() {}
  installWindowDrawing(Window, {}, { textManager: () => ({ hpA: 'HP', mpA: 'MP', tpA: 'TP' }) });
  const window = new Window(), calls = [];
  Object.assign(window, {
    lineHeight: () => 36, textWidth: text => text.length * 10, textColor: id => `color${id}`,
    normalColor: () => 'normal', changeTextColor(color) { calls.push(['color', color]); },
    drawText(...args) { calls.push(['text', ...args]); },
    contents: { fillRect(...args) { calls.push(['fill', ...args]); }, gradientFillRect(...args) { calls.push(['gradient', ...args]); } }
  });
  const actor = { hp: 25, mhp: 100, hpRate: () => 0.25, isDead: () => false, isDying: () => true };
  window.drawActorHp(actor, 10, 20);
  assert.deepEqual(calls.filter(call => call[0] === 'fill' || call[0] === 'gradient'), [
    ['fill', 10, 48, 186, 6, 'color19'], ['gradient', 10, 48, 46, 6, 'color20', 'color21']
  ]);
  assert.deepEqual(calls.filter(call => call[0] === 'text'), [
    ['text', 'HP', 10, 20, 44], ['text', 25, 106, 20, 40, 'right'],
    ['text', '/', 146, 20, 10, 'right'], ['text', 100, 156, 20, 40, 'right']
  ]);
  calls.length = 0;
  const original = window.drawCurrentAndMax;
  window.drawCurrentAndMax = function(...args) { calls.push(['alias', args[0]]); original.apply(this, args); };
  window.drawActorMp({ mp: 7, mmp: 50, mpRate: () => 0.14 }, 0, 0, 60);
  assert.deepEqual(calls.filter(call => call[0] === 'text'), [['text', 'MP', 0, 0, 44], ['text', 7, 20, 0, 40, 'right']]);
  assert.ok(calls.some(call => call[0] === 'alias'));
});
