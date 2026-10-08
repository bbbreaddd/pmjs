'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(
  path.resolve(__dirname, '../js/pmjs-web/object-urls.js'), 'utf8');
const eventsSource = fs.readFileSync(
  path.resolve(__dirname, '../js/pmjs-web/events.js'), 'utf8');
const canvasSource = fs.readFileSync(
  path.resolve(__dirname, '../js/pmjs-web/canvas.js'), 'utf8');
const elementsSource = require('./helpers/web-element-sources.cjs').source;

function imageContext(loadBytesAsync, loadAsync) {
  const context = {
    performance: { now() { return 0; } },
    Blob,
    URL: function URL() {},
    console,
    PMJS: {},
    pmjsGameConfig: {},
    nativeWindowState: { focused: true, visible: true },
    NativeHost: {
      runtime: { env: function() { return ''; } },
      images: {
        loadBytesAsync,
        loadAsync: loadAsync || function() { throw new Error('filesystem loader used'); },
        release: function() {}
      },
      canvas: {},
      media: {}
    }
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.resolve(__dirname,
    '../js/pmjs-web/scheduler.js'), 'utf8'), context);
  vm.runInContext(eventsSource, context);
  vm.runInContext(canvasSource, context);
  vm.runInContext(source, context);
  vm.runInContext(fs.readFileSync(path.resolve(__dirname,
    '../js/pmjs-web/images.js'), 'utf8'), context);
  vm.runInContext(elementsSource, context);
  return context;
}

function settle() {
  return new Promise(resolve => setImmediate(resolve));
}

test('object URLs retain blobs until revoked', async () => {
  const context = { Blob, URL: function URL() {} };
  vm.createContext(context);
  vm.runInContext(source, context);

  const blob = new Blob([Uint8Array.from([1, 2, 3])]);
  const url = context.URL.createObjectURL(blob);
  assert.match(url, /^blob:pmjs\/\d+$/);
  assert.equal(context.pmjsIsObjectURL(url), true);
  assert.equal(context.pmjsResolveObjectURL(url), blob);
  assert.equal(context.pmjsResolveObjectURL(url), blob);

  context.URL.revokeObjectURL(url);
  assert.equal(context.pmjsIsObjectURL(url), true);
  assert.equal(context.pmjsResolveObjectURL(url), null);
});

test('object URL identities are not reused', () => {
  const context = { Blob, URL: function URL() {} };
  vm.createContext(context);
  vm.runInContext(source, context);
  const first = context.URL.createObjectURL(new Blob(['first']));
  context.URL.revokeObjectURL(first);
  const second = context.URL.createObjectURL(new Blob(['second']));
  assert.notEqual(first, second);
});

test('NativeImage loads object URL bytes without using the path loader', async () => {
  let loads = 0;
  const context = imageContext(async function(buffer) {
    loads++;
    assert.equal(buffer.byteLength, 3);
    return { handle: loads, width: 2, height: 3 };
  });
  const url = context.URL.createObjectURL(new Blob([Uint8Array.from([1, 2, 3])]));
  const first = new context.Image();
  const second = new context.Image();
  first.src = url;
  second.src = url;
  context.PMJS.tasks.drain();
  await settle();
  assert.equal(loads, 2);
  assert.equal(first.complete, true);
  assert.equal(first.naturalWidth, 2);
  assert.equal(second.naturalHeight, 3);

  context.URL.revokeObjectURL(url);
  assert.equal(first.naturalWidth, 2, 'revocation must not release a decoded image');
});

test('revoking before NativeImage consumes an object URL reports an error', async () => {
  let loads = 0;
  const context = imageContext(async function() {
    loads++;
    return { handle: 1, width: 1, height: 1 };
  });
  const url = context.URL.createObjectURL(new Blob(['bytes']));
  const image = new context.Image();
  let errors = 0;
  image.onerror = function() { errors++; };
  image.src = url;
  context.URL.revokeObjectURL(url);
  context.PMJS.tasks.drain();
  await settle();
  assert.equal(loads, 0);
  assert.equal(errors, 1);
  assert.equal(image._pmjsLoadFailed, true);
});

test('NativeImage retries a path after a transient native load failure', async () => {
  let attempts = 0;
  const context = imageContext(async function() {
    throw new Error('byte loader used');
  }, async function(path) {
    attempts++;
    assert.equal(path, 'img/pictures/retry.png');
    if (attempts === 1) throw new Error('temporary upload failure');
    return { handle: 41, width: 32, height: 24 };
  });
  context.NativeHost.images.fallbackImage = () =>
    ({ handle: 40, width: 2, height: 2 });
  const image = new context.Image();
  image.src = 'img/pictures/retry.png';
  context.PMJS.tasks.drain();
  await settle();
  assert.equal(attempts, 1);
  assert.equal(image._pmjsLoadFailed, true);
  assert.equal(image.naturalWidth, 0);

  image.src = 'img/pictures/retry.png';
  context.PMJS.tasks.drain();
  await settle();
  assert.equal(attempts, 2);
  assert.equal(image._pmjsLoadFailed, false);
  assert.equal(image.naturalWidth, 32);
  assert.equal(image.naturalHeight, 24);
});

test('Atlas retention composes with other rules across path, generated, and byte loaders', async () => {
  const loads = [];
  const resource = { handle: 71, width: 4, height: 5 };
  const context = imageContext(async (_buffer, retain) => {
    loads.push(['bytes', retain]);
    return resource;
  }, async (path, retain) => {
    loads.push([path, retain]);
    return resource;
  });
  context.NativeHost.assets = { async loadImageAsync(path, retain) {
    loads.push(['generated:' + path, retain]);
    return resource;
  } };
  vm.runInContext(fs.readFileSync(path.resolve(__dirname,
    '../js/pmjs-plugins/atlas-loader/image-retention.js'), 'utf8'), context);
  context.PMJS.images.addRetentionRule(path =>
    path.startsWith('blob:') || path === 'generated-assets:/retain.png');
  for (const src of ['file:///game/img/atlases/main.png?version=1',
    'img/pictures/ordinary.png', 'generated-assets:/retain.png',
    context.URL.createObjectURL(new Blob(['bytes']))]) {
    const image = new context.Image();
    image.src = src;
  }
  context.PMJS.tasks.drain();
  await settle();
  assert.deepEqual(loads, [
    ['img/atlases/main.png', true],
    ['img/pictures/ordinary.png', false],
    ['generated:retain.png', true],
    ['bytes', true],
  ]);
});

test('image completion listeners follow guest load handlers for path and byte loads', async () => {
  const context = imageContext(async () => ({ handle: 81, width: 3, height: 2 }),
    async () => ({ handle: 82, width: 3, height: 2 }));
  const order = [];
  context.PMJS.images.onLoadComplete(image => {
    assert.equal(image.complete, true);
    assert.equal(image.naturalWidth, 3);
    order.push('first');
  });
  context.PMJS.images.onLoadComplete(() => order.push('second'));
  for (const src of ['img/pictures/test.png',
    context.URL.createObjectURL(new Blob(['bytes']))]) {
    const image = new context.Image();
    image.onload = () => order.push('handler');
    image.addEventListener('load', () => order.push('event'));
    image.src = src;
    context.PMJS.tasks.drain();
    await settle();
  }
  assert.deepEqual(order, ['handler', 'event', 'first', 'second',
    'handler', 'event', 'first', 'second']);
});

test('failed and stale image loads do not notify completion listeners', async () => {
  const releases = [];
  let resolveOld;
  const context = imageContext(async () => { throw new Error('decode failed'); },
    path => path === 'old.png'
      ? new Promise(resolve => { resolveOld = resolve; })
      : Promise.resolve({ handle: 91, width: 2, height: 2 }));
  context.NativeHost.images.release = handle => releases.push(handle);
  const completed = [];
  context.PMJS.images.onLoadComplete(image => completed.push(image.src));
  const image = new context.Image();
  image.src = 'old.png';
  context.PMJS.tasks.drain();
  image.src = 'new.png';
  context.PMJS.tasks.drain();
  resolveOld({ handle: 90, width: 2, height: 2 });
  const failed = new context.Image();
  failed.src = context.URL.createObjectURL(new Blob(['bad']));
  context.PMJS.tasks.drain();
  await settle();
  assert.deepEqual(completed, ['new.png']);
  assert.ok(releases.includes(90));
  assert.equal(failed._pmjsLoadFailed, true);
});
