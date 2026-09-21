'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.resolve(__dirname,
  '../js/pmjs-mz/fonts.js'), 'utf8');

test('MZ FontManager registers game fonts through the native registry', () => {
  const calls = [];
  const context = vm.createContext({
    globalThis: null,
    FontManager: { _urls: {}, _states: {} },
    PMJS: { fonts: {
      registerFace(family, url, options) {
        calls.push([family, url, options.fromGame]);
        return true;
      },
      isFamilyLoaded(family) { return family === 'rmmz-mainfont'; },
    } },
  });
  context.globalThis = context;
  vm.runInContext(source, context, { filename: 'pmjs-mz/fonts.js' });

  context.FontManager.startLoading('rmmz-mainfont', 'fonts/main.ttf');
  context.FontManager.startLoading('missing', 'fonts/missing.ttf');

  assert.deepEqual(calls, [
    ['rmmz-mainfont', 'fonts/main.ttf', true],
    ['missing', 'fonts/missing.ttf', true],
  ]);
  assert.equal(context.FontManager._urls['rmmz-mainfont'], 'fonts/main.ttf');
  assert.equal(context.FontManager._states['rmmz-mainfont'], 'loaded');
  assert.equal(context.FontManager._states.missing, 'error');
});
