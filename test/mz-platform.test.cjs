'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.resolve(__dirname,
  '../js/pmjs-mz/platform.js'), 'utf8');

function runWith(host, fonts) {
  const context = vm.createContext({
    globalThis: null,
    NativeHost: host,
    PMJS: fonts ? { fonts: {} } : {},
    Utils: {},
  });
  context.globalThis = context;
  vm.runInContext(source, context, { filename: 'pmjs-mz/platform.js' });
  return context.Utils;
}

test('MZ platform capabilities reflect native services', () => {
  const utils = runWith({ render: {}, scene: {}, media: {}, storage: {} }, true);
  assert.equal(utils.canUseWebGL(), true);
  assert.equal(utils.canUseWebAudioAPI(), true);
  assert.equal(utils.canUseCssFontLoading(), true);
  assert.equal(utils.canUseIndexedDB(), true);
  assert.equal(utils.canPlayOgg(), true);
  assert.equal(utils.canPlayWebm(), true);
});

test('MZ platform capabilities do not claim missing native services', () => {
  const utils = runWith({}, false);
  assert.equal(utils.canUseWebGL(), false);
  assert.equal(utils.canUseWebAudioAPI(), false);
  assert.equal(utils.canUseCssFontLoading(), false);
  assert.equal(utils.canUseIndexedDB(), false);
  assert.equal(utils.canPlayOgg(), false);
  assert.equal(utils.canPlayWebm(), false);
});
