'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { createStorage } = require('../runner/storage.cjs');
const { temporaryDirectory } = require('./helpers/temp.cjs');

const source = name => fs.readFileSync(path.join(__dirname, '../js/pmjs-web', name + '.js'), 'utf8');

test('write flags preserve exclusive-create and append across sync, callback and Promise paths', async () => {
  const root = temporaryDirectory('pmjs-write-flags-');
  const storage = createStorage(root);
  const context = vm.createContext({ Buffer, __pmjsBuiltinRequire: require, NativeHost: { storage },
    PMJS: { config: {}, tasks: { enqueue(callback) { callback(); } } } });
  vm.runInContext(source('filesystem'), context);
  const guest = context.fsModule;
  guest.writeFileSync('/save/exclusive', 'original');
  assert.throws(() => guest.writeFileSync('/save/exclusive', 'changed', { flag: 'wx' }), { code: 'EEXIST' });
  assert.equal(storage.readText('exclusive'), 'original');
  guest.writeFileSync('/save/append', 'first');
  guest.writeFileSync('/save/append', 'second', { flag: 'a' });
  assert.equal(storage.readText('append'), 'firstsecond');
  await guest.promises.writeFile('/save/callback', 'left');
  await guest.promises.writeFile('/save/callback', 'right', { flag: 'a' });
  assert.equal(storage.readText('callback'), 'leftright');
  await new Promise(resolve => guest.writeFile('/save/exclusive', 'changed', { flag: 'wx' }, error => {
    assert.equal(error?.code, 'EEXIST'); resolve();
  }));
  assert.equal(storage.readText('exclusive'), 'original');
  assert.throws(() => guest.writeFileSync('/save/exclusive', 'changed', { flag: 'wat' }), { code: 'EINVAL' });
});

test('localStorage v2 namespace avoids legacy collisions and clears both namespaces', () => {
  const root = temporaryDirectory('pmjs-storage-keys-');
  const storage = createStorage(root);
  fs.mkdirSync(path.join(root, 'web-storage'));
  fs.writeFileSync(path.join(root, 'web-storage', 'legacy'), 'old');
  fs.writeFileSync(path.join(root, 'web-storage', 'k-a'), 'legacy key k-a');
  fs.writeFileSync(path.join(root, 'web-storage', 'a'), 'legacy key a');
  const context = vm.createContext({ NativeHost: { storage } });
  vm.runInContext(source('storage'), context);
  const keys = ['', '.', '..', '雪', 'ordinary'];
  keys.forEach((key, index) => context.localStorage.setItem(key, String(index)));
  assert.deepEqual(keys.map(key => context.localStorage.getItem(key)), ['0', '1', '2', '3', '4']);
  assert.equal(context.localStorage.getItem('legacy'), 'old');
  assert.equal(storage.readText('web-storage-v2/k-'), '0');
  assert.equal(storage.readText('web-storage-v2/k-.') , '1');
  assert.equal(context.localStorage.getItem('a'), 'legacy key a');
  assert.equal(context.localStorage.getItem('k-a'), 'legacy key k-a');
  context.localStorage.setItem('a', 'new a');
  assert.equal(context.localStorage.getItem('a'), 'new a');
  assert.equal(context.localStorage.getItem('k-a'), 'legacy key k-a');
  context.localStorage.clear();
  assert.equal(storage.readText('web-storage-v2/k-ordinary'), null);
  assert.equal(storage.readText('web-storage/legacy'), null);
  context.sessionStorage.setItem('', 'session');
  assert.equal(context.sessionStorage.key(0), '');
  assert.equal(context.sessionStorage.key(1), null);
});

test('plain event properties use the same guest-promise tracking path as listeners', t => {
  const context = vm.createContext({ Promise, console,
    PMJS: { tasks: { trackGuestPromise(value, origin) { if (value?.then) tracked.set(value, origin); },
      invoke(callback) { callback(); }, enqueue() {}, stopped: false } } });
  const tracked = new WeakMap();
  vm.runInContext(source('events'), context);
  const propertyPromise = Promise.resolve(), listenerPromise = Promise.resolve();
  const target = new context.EventTarget();
  target.onclick = () => propertyPromise;
  target.addEventListener('click', () => listenerPromise);
  target.dispatchEvent({ type: 'click' });
  assert.equal(tracked.get(propertyPromise), 'browser');
  assert.equal(tracked.get(listenerPromise), 'browser');
  const canceled = { type: 'cancel', preventDefault() { this.defaultPrevented = true; } };
  target.oncancel = () => false;
  assert.equal(target.dispatchEvent(canceled), false);
});
