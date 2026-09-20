'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const runtimeRoot = path.resolve(__dirname, '..');

test('virtual file aliases are configured data', () => {
  const source = fs.readFileSync(path.join(runtimeRoot,
    'js/pmjs-web/filesystem.js'), 'utf8');
  const end = source.indexOf('\nvar pendingTasks =');
  const context = {
    pmjsGameConfig: { virtualFiles: {
      extensionAliases: { '.alias': '.json' },
      directoryEntryAliases: { locale: { '.json': '.LANG' } },
    } },
  };
  vm.runInNewContext(source.slice(0, end) +
    '\nthis.contract = { gameReadPath, gameDirectoryEntries };', context);
  assert.equal(context.contract.gameReadPath('/game/data/System.ALIAS'),
    'data/System.json');
  assert.deepEqual(Array.from(context.contract.gameDirectoryEntries(
    '/game/locale/', ['en.json', 'readme.txt'])), ['en.LANG', 'readme.txt']);
});

test('registered CommonJS requests are exact and cannot be replaced', () => {
  const source = fs.readFileSync(path.join(runtimeRoot,
    'js/pmjs-web/modules.js'), 'utf8');
  const end = source.indexOf('\nfunction compatibilityCountedNoop(');
  const context = { Array, Object, Error };
  vm.runInNewContext(source.slice(0, end) +
    '\nthis.contract = { registerCommonJsModule, registeredCommonJsModules };',
  context);
  const exports = { available: true };
  context.contract.registerCommonJsModule(['platform-api', './platform-api'], exports);
  assert.equal(context.contract.registeredCommonJsModules['platform-api'], exports);
  assert.throws(() => context.contract.registerCommonJsModule('platform-api', {}),
    /already registered/);
});

test('MV image cache retrims completed loads without destroying bitmap backing', async () => {
  const source = fs.readFileSync(path.join(runtimeRoot,
    'js/pmjs-mv/images.js'), 'utf8');
  const end = source.indexOf('\n// MV removes an outgoing map spriteset');
  class Bitmap {
    _onLoad() {
      this.ready = true;
      this.events.push('loaded');
    }
  }
  class ImageCache {
    constructor() {
      this._items = {};
      this.trimCount = 0;
    }
    _mustBeHeld(item) { return Boolean(item.held); }
    _truncateCache() { this.trimCount++; }
  }
  ImageCache.limit = 100;
  const cache = new ImageCache();
  const retainedSource = { src: 'retained.png' };
  cache._items = {
    recent: { key: 'recent', touch: 2,
      bitmap: { width: 8, height: 8, _image: retainedSource } },
    old: { key: 'old', touch: 1,
      bitmap: { width: 8, height: 8, _image: { src: 'old.png' } } },
    held: { key: 'held', touch: 0, held: true,
      bitmap: { width: 1, height: 1, _image: { src: 'held.png' } } },
  };
  const context = {
    Bitmap,
    ImageCache,
    ImageManager: { _imageCache: cache },
    pmjsGameConfig: { imageCacheMaxPixels: 64 },
    NativeHost: { runtime: { env() { return ''; } } },
    Promise,
    nativeCompatibilityHit() {},
  };
  vm.runInNewContext(source.slice(0, end), context, { filename: 'images.js' });
  assert.equal(ImageCache.limit, 64);
  ImageCache.limit = 50;
  assert.equal(ImageCache.limit, 50);
  ImageCache.limit = 200;
  assert.equal(ImageCache.limit, 64);
  const patchedTruncate = cache._truncateCache;
  cache._truncateCache = function() {
    this.trimCount++;
    return patchedTruncate.apply(this, arguments);
  };

  cache._truncateCache();
  assert.deepEqual(Object.keys(cache._items).sort(), ['held', 'recent']);
  assert.equal(retainedSource.src, 'retained.png');
  cache.trimCount = 0;

  const first = new Bitmap();
  first.events = [];
  const second = new Bitmap();
  second.events = [];
  first._onLoad();
  second._onLoad();
  assert.equal(cache.trimCount, 0);
  await Promise.resolve();
  assert.equal(cache.trimCount, 1);
  assert.deepEqual(first.events, ['loaded']);
  assert.deepEqual(second.events, ['loaded']);
});
