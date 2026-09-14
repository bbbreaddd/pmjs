'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const objectUrlSource = fs.readFileSync(
  path.resolve(__dirname, '../js/pmjs-web/object-urls.js'), 'utf8');
const audioSource = fs.readFileSync(
  path.resolve(__dirname, '../js/pmjs-mv/audio.js'), 'utf8');

function contextFor(decrypter, XMLHttpRequest) {
  const loadedBytes = [];
  const released = [];
  const context = {
    Blob,
    URL: function URL() {},
    console,
    Date,
    AudioManager: { _path: 'audio/', audioFileExt: function() { return '.ogg'; } },
    SceneManager: {},
    Decrypter: decrypter,
    XMLHttpRequest,
    gamePath: function(value) { return value; },
    NativeHost: {
      media: {
        loadAudio: function() { throw new Error('path loader used'); },
        loadAudioBytes: function(buffer) {
          loadedBytes.push(new Uint8Array(buffer));
          return { handle: loadedBytes.length, duration: 1.5 };
        },
        playAudio: function() { return true; },
        setAudioParameters: function() {},
        audioIsPlaying: function() { return false; },
        releaseAudio: function(handle) { released.push(handle); },
        setMasterVolume: function() {}
      }
    }
  };
  vm.createContext(context);
  vm.runInContext(objectUrlSource, context);
  vm.runInContext(audioSource, context);
  context.loadedBytes = loadedBytes;
  context.released = released;
  return context;
}

function settle() {
  return new Promise(resolve => setImmediate(resolve));
}

test('NativeAudioBuffer consumes a PMJS object URL and queues early playback', async () => {
  const context = contextFor({ hasEncryptedAudio: false });
  const url = context.URL.createObjectURL(new Blob([Uint8Array.from([1, 2, 3])]));
  const audio = new context.WebAudio(url);
  audio.play(true, 0.25);
  assert.equal(audio._poll(), true, 'loading audio must remain in the maintenance list');
  await settle();
  assert.equal(context.loadedBytes.length, 1);
  assert.deepEqual(Array.from(context.loadedBytes[0]), [1, 2, 3]);
  assert.equal(audio.isReady(), true);
  assert.equal(audio._wasPlaying, true);
  context.URL.revokeObjectURL(url);
  assert.equal(audio.isReady(), true);
});

test('NativeAudioBuffer delegates encrypted audio to the MV Decrypter', async () => {
  let requestedPath = '';
  let objectUrlsCreated = 0;
  function Request() {
    this.status = 200;
    this.response = Uint8Array.from([9, 8, 7]).buffer;
  }
  Request.prototype.open = function(_method, path) { requestedPath = path; };
  Request.prototype.send = function() { this.onload(); };
  const decrypter = {
    hasEncryptedAudio: true,
    extToEncryptExt: function(path) { return path.replace(/\.ogg$/, '.rpgmvo'); },
    decryptArrayBuffer: function(buffer) { return buffer; }
  };
  const context = contextFor(decrypter, Request);
  const originalCreate = context.URL.createObjectURL;
  context.URL.createObjectURL = function(blob) {
    objectUrlsCreated++;
    return originalCreate(blob);
  };
  const audio = new context.WebAudio('audio/se/cursor.ogg');
  await settle();
  assert.equal(requestedPath, 'audio/se/cursor.rpgmvo');
  assert.deepEqual(Array.from(context.loadedBytes[0]), [9, 8, 7]);
  assert.equal(audio.isReady(), true);
  assert.equal(objectUrlsCreated, 0, 'MV decrypted bytes should go directly to native audio');
});

test('clearing an in-flight object URL load skips native decoding', async () => {
  const context = contextFor({ hasEncryptedAudio: false });
  const url = context.URL.createObjectURL(new Blob([Uint8Array.from([1])]));
  const audio = new context.WebAudio(url);
  audio.clear();
  await settle();
  assert.equal(context.loadedBytes.length, 0, 'cancelled bytes must not enter native decoding');
  assert.deepEqual(context.released, []);
  assert.equal(audio._handle, 0);
  assert.equal(audio.isReady(), false);
});
