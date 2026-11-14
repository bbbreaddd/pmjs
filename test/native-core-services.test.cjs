'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { installCoreUtilities } = require('../runner/native-core-utilities.cjs');
const { installTilemapStatics } = require('../runner/native-tilemap-statics.cjs');
const source = fs.readFileSync(path.join(__dirname, '../third_party/rpg-maker-mv/rpg_core.js'), 'utf8');
function environment() {
  const events = [], timers = [];
  const scope = vm.createContext({ setTimeout(callback, delay) { timers.push({ callback, delay }); },
    Graphics: { printLoadingError(url) { events.push(['error', url]); }, eraseLoadingError() { events.push(['erase']); } },
    SceneManager: { stop() { events.push(['stop']); }, resume() { events.push(['resume']); } } });
  return { scope, events, timers, runScript(code) { return vm.runInContext(code, scope); } };
}

test('cache, request queue and retry callbacks match the bundled MV operations', () => {
  const actual = environment(), reference = environment();
  installCoreUtilities(actual);
  reference.runScript(source.slice(source.indexOf('function CacheEntry('), source.indexOf('function ImageCache(')) +
    source.slice(source.indexOf('function RequestQueue('), source.indexOf('function Point(')) +
    source.slice(source.indexOf('function ResourceHandler()')));
  const exercise = runtime => {
    const { scope, events, timers } = runtime;
    const cache = new scope.CacheMap({});
    const first = cache.setItem('a', { value: 3 });
    assert.equal(cache.getItem('a'), first.item);
    first.free(); assert.equal(cache.getItem('a'), null);
    first.allocate(); first.setTimeToLive(0, 0); cache.update(1, 0.1);
    assert.equal(cache.getItem('a'), first.item); cache.clear(); assert.equal(cache.getItem('a'), null);
    const queue = new scope.RequestQueue();
    let ready = false;
    const item = name => ({ isRequestReady() { return ready; }, startRequest() { events.push(['request', name]); } });
    queue.enqueue('a', item('a')); queue.enqueue('b', item('b')); queue.raisePriority('b');
    queue.update(); ready = true; queue.update(); queue.clear(); assert.equal(queue._queue.length, 0);
    const loader = scope.ResourceHandler.createLoader('asset', () => events.push(['retry']), () => events.push(['resign']), [5, 9]);
    loader(); loader(); assert.deepEqual(timers.map(timer => timer.delay), [5, 9]);
    timers.forEach(timer => timer.callback()); loader(); assert.equal(scope.ResourceHandler.exists(), true);
    scope.ResourceHandler.retry(); assert.equal(scope.ResourceHandler.exists(), false);
    loader(); assert.equal(timers.at(-1).delay, 5);
    return events;
  };
  assert.deepEqual(exercise(actual), exercise(reference));
});

test('all tile classification helpers and tables match the bundled MV', () => {
  const actual = environment(), reference = environment();
  for (const runtime of [actual, reference]) runtime.runScript('function Tilemap() {}');
  installTilemapStatics(actual);
  reference.runScript(source.slice(source.indexOf('Tilemap.TILE_ID_B '), source.indexOf('function ShaderTilemap()')));
  for (const name of Object.keys(reference.scope.Tilemap)) {
    const expected = reference.scope.Tilemap[name], value = actual.scope.Tilemap[name];
    if (typeof expected === 'function') {
      for (let id = -1; id <= 8193; ++id) assert.equal(value.call(actual.scope.Tilemap, id, id + 47), expected.call(reference.scope.Tilemap, id, id + 47), name + ':' + id);
    } else assert.equal(JSON.stringify(value), JSON.stringify(expected), name);
  }
});

test('Html5Audio uses native voices for readiness, playback, volume, seeking and errors', async () => {
  const { installAudioElement } = require('../runner/native-audio-element.cjs');
  const runtime = environment(), buffers = [];
  class EventTarget {
    constructor() { this.events = new Map(); }
    addEventListener(type, callback) { this.events.set(type, [...(this.events.get(type) || []), callback]); }
    dispatchEvent(event) { for (const callback of this.events.get(event.type) || []) callback(event); }
  }
  class WebAudio {
    constructor(url) { this.url = url; this.ready = false; this.position = 0; this.failed = false; buffers.push(this); }
    addLoadListener(callback) { this.onLoad = callback; }
    addStopListener(callback) { this.onStop = callback; }
    update() {}
    isReady() { return this.ready; }
    isError() { return this.failed; }
    isPlaying() { return this.playing; }
    play(loop, position) { this.loop = loop; this.position = position; this.playing = true; }
    stop() { this.playing = false; this.onStop?.(); }
    seek() { return this.position; }
  }
  Object.assign(runtime.scope, { EventTarget, WebAudio, document: { addEventListener() {} },
    window: { URL: { revokeObjectURL() {} } }, clearInterval() {} });
  installCoreUtilities(runtime); installAudioElement(runtime.scope);
  const audio = runtime.scope.Html5Audio;
  let loaded = 0;
  audio.setup('track.ogg'); audio._unlocked = true;
  audio.addLoadListener(() => loaded++); audio.play(true, 3);
  const buffer = buffers[0];
  assert.equal(buffer.url, 'track.ogg'); assert.equal(loaded, 0);
  buffer.ready = true; buffer.onLoad();
  assert.equal(loaded, 1); assert.equal(buffer.playing, true); assert.equal(buffer.loop, true);
  assert.equal(audio.seek(), 3); audio.volume = 0.5; assert.equal(buffer.volume, 0.5);
  audio.stop(); assert.equal(buffer.playing, false); assert.equal(audio.isPlaying(), false);
  audio.play(false,1);buffer.position=5;buffer.playing=false;buffer.onStop();
  assert.equal(audio.seek(),5);assert.equal(audio.isPlaying(),false);assert.equal(audio._audioElement.ended,true);
  audio._audioElement.play();assert.equal(buffer.position,0);assert.equal(audio._audioElement.ended,false);audio.stop();
  audio.setup('missing.ogg'); audio.play(false, 0);
  const failure = buffers.at(-1); failure.failed = true; failure.update(); assert.equal(audio.isError(), true);
  runtime.scope.pmjsResolveObjectURL=url=>url==='blob:test'?{arrayBuffer:()=>Promise.resolve(Uint8Array.from([1,2,3]).buffer)}:null;
  const objectAudio=new runtime.scope.Audio('blob:test');await objectAudio.play();
  const objectBuffer=buffers.at(-1);assert.equal(objectAudio.src,'blob:test');
  assert.equal(objectBuffer.url,'data:audio/octet-stream;base64,AQID');assert.equal(objectBuffer.playing,true);
  objectAudio.pause();assert.equal(objectBuffer.playing,false);
  let resolvePending;
  runtime.scope.pmjsResolveObjectURL=url=>url==='blob:pending'?{arrayBuffer:()=>new Promise(resolve=>{resolvePending=resolve;})}:null;
  const changed=new runtime.scope.Audio('blob:pending');changed.src='replacement.ogg';
  const count=buffers.length;resolvePending(Uint8Array.from([4,5]).buffer);await Promise.resolve();
  assert.equal(buffers.length,count);assert.equal(buffers.at(-1).url,'replacement.ogg');

});

test('Decrypter exposes mutable hooks and routes decoded image and audio callbacks', () => {
  const runtime = environment(), requests = [], blobs = [];
  class Request {
    open(method, url) { this.method = method; this.url = url; }
    send() { requests.push(this); }
  }
  Object.assign(runtime.scope, { XMLHttpRequest: Request,
    $dataSystem: { encryptionKey: '00112233445566778899aabbccddeeff' },
    Blob: class { constructor(parts) { this.parts = parts; } },
    window: { URL: { createObjectURL(blob) { blobs.push(blob); return 'blob:' + blobs.length; } } },
    Bitmap: function() {}, AudioManager: { createDecryptBuffer(...args) { this.args = args; } } });
  installCoreUtilities(runtime);
  const decrypter = runtime.scope.Decrypter, header = decrypter.SIGNATURE + decrypter.VER + decrypter.REMAIN;
  const bytes = Uint8Array.from({ length: 48 }, (_, index) => index < 16 ? parseInt(header.slice(index * 2, index * 2 + 2), 16) : index - 16);
  for (let i = 0; i < 16; ++i) bytes[16 + i] ^= i * 17;
  let cuts = 0;
  const cut = decrypter.cutArrayHeader;
  decrypter.cutArrayHeader = function(...args) { ++cuts; return cut.apply(this, args); };
  assert.deepEqual(Array.from(new Uint8Array(decrypter.decryptArrayBuffer(bytes.buffer))), Array.from({ length: 32 }, (_, index) => index));
  assert.equal(cuts, 1); decrypter._encryptionKey = ['custom']; assert.equal(decrypter._encryptionKey[0], 'custom');
  const bitmap = { _image: { listeners: {}, addEventListener(name, callback) { this.listeners[name] = callback; } } };
  runtime.scope.Bitmap.prototype._onLoad = function() { this.loaded = true; };
  runtime.scope.Bitmap.prototype._onError = function() { this.failed = true; };
  decrypter.decryptImg('image.png', bitmap);
  const image = requests[0]; image.status = 200; image.response = bytes.buffer; image.onload.call(image);
  assert.equal(image.url, 'image.rpgmvp'); assert.equal(bitmap._image.src, 'blob:1');
  bitmap._image.listeners.load(); assert.equal(bitmap.loaded, true);
  bitmap._image.listeners.error(); assert.equal(bitmap.failed, true);
  decrypter.decryptHTML5Audio('music.rpgmvo', { name: 'music' }, 4);
  const audio = requests[1]; audio.status = 200; audio.response = bytes.buffer; audio.onload.call(audio);
  assert.equal(runtime.scope.AudioManager.args[0], 'blob:2'); assert.equal(runtime.scope.AudioManager.args[2], 4);
});
