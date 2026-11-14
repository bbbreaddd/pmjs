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

test('Html5Audio uses native voices for readiness, playback, volume, seeking and errors', () => {
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
  audio.setup('missing.ogg'); audio.play(false, 0);
  const failure = buffers.at(-1); failure.failed = true; failure.update(); assert.equal(audio.isError(), true);
});
