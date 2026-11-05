'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');
const { createHostContext } = require('./helpers/mz-host-context.cjs');
function setup() {
  const toggles = [];
  const c = createHostContext({ runtime: { env: () => '', windowSize: () => ({ width: 816, height: 624 }) },
    input: { setTextInput: enabled => toggles.push(enabled) } }, { graphics: false });
  for (const file of ['fonts', 'storage']) vm.runInContext(fs.readFileSync(require.resolve('../js/pmjs-web/' + file + '.js'), 'utf8'), c);
  c.PMJS.images = {};
  return { c, toggles };
}
test('created HTML elements share extensible interfaces and detach with focus cleanup', () => {
  const { c, toggles } = setup();
  vm.runInContext('HTMLElement.prototype.position = function() { return this.tagName; }', c);
  for (const tag of ['div', 'input', 'canvas', 'audio', 'video', 'img', 'script']) {
    const el = tag === 'img' ? new c.Image() : c.document.createElement(tag);
    assert.ok(el instanceof c.HTMLElement && el instanceof c.Element && el instanceof c.Node, tag);
    assert.equal(el.position(), tag.toUpperCase());
    c.document.body.appendChild(el); assert.ok(el.isConnected);
    el.remove(); assert.equal(el.isConnected, false);
  }
  const input = c.document.createElement('input');
  c.document.body.appendChild(input); input.focus(); input.remove(); input.remove();
  assert.equal(c.document.activeElement, c.document.body);
  assert.deepEqual(toggles.slice(-2), [true, false]);
});
for (const property of ['textContent', 'innerHTML']) test(property + ' replacement releases focus in a detached subtree', () => {
  const { c, toggles } = setup();
  const parent = c.document.createElement('div'), branch = c.document.createElement('span');
  const input = c.document.createElement('input');
  branch.appendChild(input); parent.appendChild(branch); c.document.body.appendChild(parent);
  input.value = 'retained'; input.focus();
  const events = [];
  input.addEventListener('blur', () => events.push('blur'));
  parent[property] = 'replacement';
  assert.equal(branch.parentNode, null);
  assert.equal(input.isConnected, false);
  assert.equal(c.document.activeElement, c.document.body);
  assert.deepEqual(toggles, [true, false]);
  assert.deepEqual(events, ['blur']);
  c.__pmjsReceiveInput({ keyEvents: [{ text: 'unexpected' }] });
  assert.equal(input.value, 'retained');
  assert.equal(parent.textContent, 'replacement');
});
for (const property of ['textContent', 'innerHTML']) {
  test(property + ' replacement tolerates removal and reparenting during blur', () => {
    for (const action of ['remove', 'reparent']) {
      const { c } = setup();
      const parent = c.document.createElement('div'), other = c.document.createElement('div');
      const input = c.document.createElement('input'), sibling = c.document.createElement('span');
      parent.appendChild(input); parent.appendChild(sibling);
      c.document.body.appendChild(parent); c.document.body.appendChild(other);
      input.focus();
      input.addEventListener('blur', () => {
        if (action === 'remove') input.remove();
        else other.appendChild(input);
      });
      parent[property] = 'replacement';
      assert.equal(parent.children.length, 0);
      assert.equal(sibling.parentNode, null, action);
      assert.equal(sibling.isConnected, false, action);
      assert.equal(input.parentNode, action === 'remove' ? null : other);
      assert.equal(c.document.activeElement, c.document.body);
    }
  });
  test(property + ' replacement does not invoke a guest removeChild override', () => {
    const { c } = setup(), parent = c.document.createElement('div'), child = c.document.createElement('span');
    parent.appendChild(child);
    parent.removeChild = () => { throw new Error('guest override'); };
    parent[property] = 'replacement';
    assert.equal(child.parentNode, null);
    assert.equal(parent.textContent, 'replacement');
  });
}
test('element and document searches visit descendants in tree order', () => {
  const { c } = setup();
  const parent = c.document.createElement('div'), child = c.document.createElement('input');
  parent.appendChild(child); c.document.body.appendChild(parent);
  assert.deepEqual(Array.from(c.document.getElementsByTagName('input')), [child]);
  assert.deepEqual(Array.from(parent.getElementsByTagName('*')), [child]);
  assert.equal(parent.getElementsByTagName('input').item(1), null);
});
test('font stylesheet enumeration preserves rules, paths and prototype extensions', () => {
  const { c } = setup();
  c.PMJS.fonts.registerStylesheet('@font-face {font-family: Pixel; src:url("pixel.ttf");}', 'fonts/gamefont.css');
  const [sheet] = c.document.styleSheets;
  assert.equal(sheet.href, 'fonts/gamefont.css');
  const [rule] = sheet.cssRules;
  assert.ok(rule instanceof c.CSSFontFaceRule);
  assert.equal(rule.style.fontFamily, 'Pixel');
  assert.equal(rule.style.getPropertyValue('src'), 'url("pixel.ttf")');
  assert.equal(c.PMJS.fonts.getRegisteredFaces().pixel.path, 'fonts/pixel.ttf');
  const style = c.document.createElement('style'); c.document.head.appendChild(style);
  style.sheet.insertRule('@font-face {font-family: New; src:url("new.ttf");}');
  assert.equal(c.document.styleSheets.length, 2);
  assert.equal(c.PMJS.fonts.getRegisteredFaces().new.path, 'new.ttf');
  style.remove(); assert.equal(c.document.styleSheets.length, 1);
});
test('CSS property recognition and computed reads support transform probes and named colors', () => {
  const { c } = setup();
  const el = c.document.createElement('div');
  assert.ok('transform' in el.style);
  assert.equal(c.getComputedStyle(el).transform, 'none');
  el.style.setProperty('transform-origin', '50% 50%');
  assert.equal(el.style.transformOrigin, '50% 50%');
  el.style.color = 'red';
  assert.equal(c.getComputedStyle(el).getPropertyValue('color'), 'rgb(255, 0, 0)');
  assert.equal(el.style.removeProperty('transform-origin'), '50% 50%');
  assert.equal(el.style.transformOrigin, '');
});
test('focused editing consumes ordered native text events and preserves submission propagation', () => {
  const { c } = setup();
  const input = c.document.createElement('input');
  input.value = 'AB'; input.setAttribute('maxlength', '4');
  c.document.body.appendChild(input); input.focus(); input.setSelectionRange(1, 2);
  const keys = [], submissions = [];
  c.document.addEventListener('keydown', event => keys.push(event.keyCode));
  input.addEventListener('keydown', event => {
    if (event.keyCode === 13) { submissions.push(input.value); input.remove(); }
    event.stopPropagation();
  });
  c.__pmjsReceiveInput({ keyEvents: [{ text: '猫' }, { text: 'XYZZ' }, { keyCode: 13, down: true }] });
  assert.deepEqual(submissions, ['A猫XY']); assert.deepEqual(keys, []);
  assert.equal(c.document.activeElement, c.document.body);
});
test('text editing removes a complete Unicode character and respects readonly', () => {
  const { c } = setup(); const input = c.document.createElement('input');
  input.value = 'A🙂'; input._editKey({ keyCode: 8 }); assert.equal(input.value, 'A');
  input.readOnly = true; input._insertText('B'); assert.equal(input.value, 'A');
});
test('session storage is isolated from persistent storage and a new guest', () => {
  const { c } = setup(); c.sessionStorage.setItem('key', 42); c.localStorage.setItem('key', 'persistent');
  assert.equal(c.sessionStorage.getItem('key'), '42'); assert.equal(c.sessionStorage.length, 1);
  assert.equal(c.sessionStorage.key(0), 'key'); assert.equal(setup().c.sessionStorage.getItem('key'), null);
  c.sessionStorage.clear(); assert.equal(c.localStorage.getItem('key'), 'persistent');
});


test('host fixtures preserve caller clocks and method receivers with an optional isolated clock', () => {
  const runtime = Object.freeze({
    now() { assert.equal(this, runtime); return 123; },
    env() { assert.equal(this, runtime); return ''; },
    windowSize() { assert.equal(this, runtime); return { width: 816, height: 624 }; }
  });
  const native = Object.freeze({ runtime });
  const ordinary = createHostContext(native, { graphics: false });
  const mocked = createHostContext(native, { graphics: false, now: () => 456 });
  assert.equal(ordinary.performance.now(), 123);
  assert.equal(mocked.performance.now(), 456);
  assert.equal(native.runtime.now(), 123);
  assert.notEqual(ordinary.NativeHost.runtime, runtime);
  assert.notEqual(mocked.NativeHost.runtime, ordinary.NativeHost.runtime);
  mocked.NativeHost.runtime.loadScript = () => {};
  assert.equal(native.runtime.loadScript, undefined);
  assert.equal(ordinary.NativeHost.runtime.loadScript, undefined);
  assert.equal(mocked.NativeHost.runtime.windowSize().width, 816);
});


test('attributes are separate from arbitrary properties and reflect supported HTML properties', () => {
  const { c } = setup();
  const el = c.document.createElement('div');
  el.setAttribute('DATA-State', '');
  assert.equal(el.getAttribute('data-state'), '');
  assert.equal(el.hasAttribute('DATA-STATE'), true);
  assert.equal(el.getAttribute('constructor'), null);
  el.custom = 'property';
  assert.equal(el.getAttribute('custom'), null);
  el.setAttribute('constructor', 'attribute');
  assert.equal(el.getAttribute('constructor'), 'attribute');
  assert.equal(typeof el.constructor, 'function');
  el.setAttribute('id', 'test');
  assert.equal(el.id, 'test');
  el.id = 'changed';
  assert.equal(el.getAttribute('ID'), 'changed');
  el.className = 'selected';
  assert.equal(el.getAttribute('class'), 'selected');
  el.removeAttribute('ID');
  assert.equal(el.id, '');
  assert.equal(el.getAttribute('id'), null);
  el.removeAttribute('data-state');
  assert.equal(el.hasAttribute('data-state'), false);
  const input = c.document.createElement('input');
  input.setAttribute('maxLength', '4');
  assert.equal(input.maxLength, 4);
  assert.equal(input.getAttribute('maxlength'), '4');
  input.maxLength = 8;
  assert.equal(input.getAttribute('maxlength'), '8');
  input.removeAttribute('maxlength');
  assert.equal(input.maxLength, -1);
  const canvas = c.document.createElement('canvas');
  canvas.setAttribute('width', '42');
  assert.equal(canvas.width, 42);
  canvas.width = 24;
  assert.equal(canvas.getAttribute('width'), '24');
  canvas.removeAttribute('width');
  assert.equal(canvas.width, 300);
  assert.equal(canvas.getAttribute('width'), null);
});


test('input and video attributes reflect supported properties', () => {
  const { c } = setup();
  const input = c.document.createElement('input');
  input.setAttribute('value', 'hello');
  input.setAttribute('disabled', '');
  input._insertText('!');
  assert.equal(input.value, 'hello');
  input.removeAttribute('disabled');
  input.setAttribute('readonly', '');
  input._insertText('!');
  assert.equal(input.value, 'hello');
  input.removeAttribute('readonly');
  input._insertText('!');
  assert.equal(input.value, 'hello!');
  const video = c.document.createElement('video');
  video.setAttribute('loop', '');
  video.setAttribute('preload', 'none');
  video.setAttribute('width', '320');
  assert.equal(video.width, 320);
  video.height = 240;
  assert.equal(video.getAttribute('height'), '240');
  video.removeAttribute('width');
  assert.equal(video.width, 0);
  assert.equal(video.loop, true);
  assert.equal(video.preload, 'none');
  video.removeAttribute('loop');
  video.removeAttribute('preload');
  assert.equal(video.loop, false);
  assert.equal(video.preload, 'auto');
});

test('removing an encrypted image source cancels its pending load', async () => {
  let calls = 0;
  const c = createHostContext({ runtime: { env: () => '' },
    images: { loadEncryptedAsync() { calls++; return Promise.resolve({ handle: 1 }); }, release() {} }
  }, { graphics: false });
  const queued = [];
  c.PMJS.tasks = { enqueue(fn) { queued.push(fn); } };
  const image = new c.Image();
  assert.equal(c.PMJS.images.loadEncrypted(image, 'secret.png_', 'key', 'secret.png'), true);
  assert.equal(image.getAttribute('src'), 'secret.png_');
  image.removeAttribute('src');
  assert.equal(image.getAttribute('src'), null);
  assert.equal(image.src, '');
  for (const task of queued) await task();
  assert.equal(calls, 0);
});


test('numeric attributes preserve authored strings and properties serialize converted integers', () => {
  const { c } = setup();
  const canvas = c.document.createElement('canvas');
  canvas.width = 42.9;
  assert.equal(canvas.width, 42);
  assert.equal(canvas.getAttribute('width'), '42');
  canvas.setAttribute('width', '42.9');
  assert.equal(canvas.width, 42);
  assert.equal(canvas.getAttribute('width'), '42.9');
  canvas.setAttribute('width', 'invalid');
  assert.equal(canvas.width, 300);
  assert.equal(canvas.getAttribute('width'), 'invalid');
  const video = c.document.createElement('video');
  video.width = 12.8;
  assert.equal(video.getAttribute('width'), '12');
  video.setAttribute('width', '15.9');
  assert.equal(video.width, 15);
  assert.equal(video.getAttribute('width'), '15.9');
  video.setAttribute('width', 'bad');
  assert.equal(video.width, 0);
  const input = c.document.createElement('input');
  input.setAttribute('maxlength', 'invalid');
  assert.equal(input.maxLength, -1);
  input.maxLength = 4.8;
  assert.equal(input.getAttribute('maxlength'), '4');
});

test('reflected input and video descriptors remain configurable', () => {
  const { c } = setup();
  const input = c.document.createElement('input');
  const video = c.document.createElement('video');
  for (const [element, names] of [[input, ['disabled', 'readOnly', 'type', 'maxLength']],
    [video, ['width', 'height', 'loop', 'preload']]]) {
    const proto = Object.getPrototypeOf(element);
    for (const name of names) {
      const descriptor = Object.getOwnPropertyDescriptor(proto, name);
      assert.equal(descriptor.configurable, true, name);
      Object.defineProperty(proto, name, descriptor);
    }
  }
});

test('unrelated attributes do not touch native canvas resources', () => {
  const { c } = setup();
  const canvas = c.document.createElement('canvas');
  let releases = 0;
  canvas._releaseNativeCanvas = () => { releases++; };
  canvas.setAttribute('data-state', 'open');
  canvas.removeAttribute('data-state');
  assert.equal(releases, 0);
  canvas.setAttribute('width', 'invalid');
  assert.equal(releases, 1);
});


test('canvas dimension properties do not depend on a guest setAttribute override', () => {
  const { c } = setup();
  const canvas = c.document.createElement('canvas');
  let releases = 0;
  canvas._releaseNativeCanvas = () => { releases++; };
  canvas.setAttribute = () => {};
  canvas.width = 42;
  assert.equal(canvas.width, 42);
  assert.equal(canvas.getAttribute('width'), '42');
  assert.equal(releases, 1);
});

test('removing an image source attribute cancels its pending load', async () => {
  let calls = 0;
  const c = createHostContext({ runtime: { env: () => '' },
    images: { loadAsync() { calls++; return Promise.resolve({ handle: 1 }); }, release() {} }
  }, { graphics: false });
  const queued = [];
  c.PMJS.tasks = { enqueue(fn) { queued.push(fn); } };
  const image = new c.Image();
  image.setAttribute('src', 'pending.png');
  assert.equal(image.src, 'pending.png');
  image.removeAttribute('src');
  assert.equal(image.getAttribute('src'), null);
  assert.equal(image.src, '');
  for (const task of queued) await task();
  assert.equal(calls, 0);
});
