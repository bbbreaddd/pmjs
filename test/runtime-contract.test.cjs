'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const runtimeRoot = path.resolve(__dirname, '..');

test('web runtime keeps V8 RegExp and String built-ins', () => {
  const source = fs.readFileSync(path.join(runtimeRoot,
    'js/pmjs-web/runtime.js'), 'utf8');
  const context = { PMJS: { config: {} }, NativeHost: { runtime: {
    env() { return ''; }, now() { return 0; },
    displaySize() { return { width: 640, height: 480 }; }
  } } };
  context.globalThis = context;
  vm.createContext(context);
  const split = vm.runInContext('String.prototype.split', context);
  const exec = vm.runInContext('RegExp.prototype.exec', context);
  vm.runInContext(source, context);
  assert.equal(vm.runInContext('String.prototype.split', context), split);
  assert.equal(vm.runInContext('RegExp.prototype.exec', context), exec);
  assert.deepEqual(Array.from(vm.runInContext('"a\\n\\nb".split(/[\\r\\n]+/)', context)),
    ['a', 'b']);
});

test('virtual file aliases are configured data', () => {
  const source = fs.readFileSync(path.join(runtimeRoot,
    'js/pmjs-web/filesystem.js'), 'utf8');
  const end = source.indexOf('\nvar pendingTasks =');
  const context = {
    PMJS: { config: { virtualFiles: {
      extensionAliases: { '.alias': '.json' },
      directoryEntryAliases: { locale: { '.json': '.LANG' } },
    } } },
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
  const methodsSource = fs.readFileSync(path.join(runtimeRoot,
    'js/pmjs-core/methods.js'), 'utf8');
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
    _truncateCache() { return ++this.trimCount; }
  }
  ImageCache.limit = 100;
  const cache = new ImageCache();
  const compatibilityHits = [];
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
    PMJS: { config: { imageCacheMaxPixels: 64 } },
    NativeHost: { runtime: { env() { return ''; } } },
    Promise,
    nativeCompatibilityHit(...args) { compatibilityHits.push(args); },
  };
  vm.runInNewContext(methodsSource, context, { filename: 'methods.js' });
  context.PMJS.compat = { hit: (...args) => compatibilityHits.push(args) };
  vm.runInNewContext(source.slice(0, end), context, { filename: 'images.js' });
  context.PMJS.methods.install();
  assert.equal(context.PMJS.methods.dump().find(entry =>
    entry.key === 'ImageCache._truncateCache').mode, 'own');
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

  cache._items = null;
  assert.equal(cache._truncateCache(), 3);
  assert.equal(cache.trimCount, 3);
  assert.equal(compatibilityHits.at(-1)[0], 'imageCache.truncateError');
});

test('PMJS.compat.hit logs on first hit, stacks on verbose, and throws on strict', () => {
  const source = fs.readFileSync(path.join(runtimeRoot,
    'js/pmjs-core/compatibility.js'), 'utf8');
  const snippet = source;

  function runSnippet(env) {
    const warnings = [];
    const context = {
      console: { warn: msg => warnings.push(msg), log: msg => warnings.push(msg) },
      NativeHost: { runtime: { env: name => env[name] || '' } },
      PMJS: {},
      Error,
    };
    vm.runInNewContext(snippet, context);
    return { context, warnings };
  }

  // Normal production: logs concise message once, silent on repeats
  {
    const { context, warnings } = runSnippet({});
    context.PMJS.compat.hit('filter.blur', 'radius=10');
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0], '[pmjs-compat] filter.blur: radius=10');

    context.PMJS.compat.hit('filter.blur', 'radius=20');
    assert.equal(warnings.length, 1, 'subsequent occurrence should only increment counter');
    assert.equal(context.PMJS.compat.dump()['filter.blur'], 2);

    context.PMJS.compat.hit('render.mask');
    assert.equal(warnings.length, 2);
    assert.equal(warnings[1], '[pmjs-compat] render.mask');
    assert.equal(context.PMJS.compat.count('render.'), 1);
    context.PMJS.compat.observed('render.sprite');
    assert.equal(context.PMJS.compat.count('render.'), 2);
    assert.equal(context.PMJS.compat.count('filter.'), 2);
    assert.equal(context.PMJS.compat.count(), 4);
    const snapshot = context.PMJS.compat.dump();
    context.PMJS.compat.hit('render.mask');
    assert.equal(snapshot['render.mask'], 1, 'dump remains a snapshot');
    assert.equal(context.PMJS.compat.count('render.'), 3);
  }

  // Verbose: logs concise message and stack on first hit
  {
    const { context, warnings } = runSnippet({ PMJS_COMPAT_VERBOSE: '1' });
    context.PMJS.compat.hit('filter.kawase', 'kernels=3');
    assert.equal(warnings.length, 2);
    assert.equal(warnings[0], '[pmjs-compat] filter.kawase: kernels=3');
    assert.match(warnings[1], /Error/);

    context.PMJS.compat.hit('filter.kawase', 'kernels=5');
    assert.equal(warnings.length, 2);
  }

  // Strict: logs and throws
  {
    const { context, warnings } = runSnippet({ PMJS_STRICT_COMPAT: '1' });
    assert.throws(
      () => context.PMJS.compat.hit('filter.glow', 'samples=8'),
      /unsupported native capability: filter\.glow: samples=8/
    );
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0], '[pmjs-compat] filter.glow: samples=8');
  }
});
