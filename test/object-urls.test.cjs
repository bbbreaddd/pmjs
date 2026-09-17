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
const elementsSource = fs.readFileSync(
  path.resolve(__dirname, '../js/pmjs-web/elements.js'), 'utf8');

function imageContext(loadBytesAsync) {
  const context = {
    Blob,
    URL: function URL() {},
    console,
    pendingTasks: [],
    pmjsGameConfig: {},
    nativeWindowState: { focused: true, visible: true },
    NativeHost: {
      runtime: { env: function() { return ''; } },
      images: {
        loadBytesAsync,
        loadAsync: function() { throw new Error('filesystem loader used'); },
        release: function() {}
      },
      canvas: {},
      media: {}
    }
  };
  vm.createContext(context);
  vm.runInContext(eventsSource, context);
  vm.runInContext(canvasSource, context);
  vm.runInContext(source, context);
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
  context.pendingTasks.splice(0).forEach(task => task());
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
  context.pendingTasks.splice(0).forEach(task => task());
  await settle();
  assert.equal(loads, 0);
  assert.equal(errors, 1);
  assert.equal(image._pmjsLoadFailed, true);
});
