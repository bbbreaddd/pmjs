'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const audioSource = fs.readFileSync(path.join(__dirname,
  '../js/pmjs-plugins/aetherflow/audio-cache.js'), 'utf8');
const imageSource = fs.readFileSync(path.join(__dirname,
  '../js/pmjs-plugins/aetherflow/image-cache.js'), 'utf8');

test('Aetherflow audio patch is idempotent', () => {
  const context = vm.createContext({
    AudioManager: {
      _cache: { clear() {} },
      loadAudio() { return {}; },
      reserveAudio() { return {}; }
    },
    NativeAudioBuffer: function NativeAudioBuffer() {}
  });

  vm.runInContext(audioSource, context);
  const loadAudio = context.AudioManager.loadAudio;
  const reserveAudio = context.AudioManager.reserveAudio;
  vm.runInContext(audioSource, context);

  assert.equal(context.AudioManager.loadAudio, loadAudio);
  assert.equal(context.AudioManager.reserveAudio, reserveAudio);
});

test('Aetherflow image patch is idempotent', () => {
  const context = vm.createContext({
    ImageCache: function ImageCache() {},
    NativeImage: function NativeImage() {}
  });
  context.ImageCache.prototype.releaseItem = function() {};

  vm.runInContext(imageSource, context);
  const releaseItem = context.ImageCache.prototype.releaseItem;
  vm.runInContext(imageSource, context);

  assert.equal(context.ImageCache.prototype.releaseItem, releaseItem);
});
