'use strict';
const assert = require('node:assert/strict');
const vm = require('node:vm');
const test = require('node:test');
const fixture = require('./helpers/plugin-source-fixture.cjs');
function setup(files, options = {}) {
  return fixture('js/pmjs-plugins/olivia/animated-pictures.js', 'Olivia_AnimatedPictures', files,
    { hash: 'a1e3bb3d6861ed8901ddf19fa91bbd8dfc9923d1f813b4a92f0ceec431354905', ...options });
}
for (const newline of ['\n', '\r\n']) {
  test(`animated pictures ignore replaced bitmap callbacks with ${newline === '\n' ? 'LF' : 'CRLF'} source`, () => {
    const file = 'js/plugins/Olivia_AnimatedPictures.js';
    const source = `
    function load() {
  if (this._isAnimatedPicture) {
    this.bitmap.addLoadListener(this.updateAnimatedPictureFrame.bind(this));
  } else {
    this.bitmap.addLoadListener(this.resetFrame.bind(this));
  }
    }
  `.replace(/\n/g, newline);
    const host = setup({ [file]: source });
    host.load(file);
    const patched = host.source(file);
    assert.equal(patched.replace(/\r\n/g, '').includes('\n'), newline === '\n');
    assert.equal(setup({ [file]: patched }).source(file), patched);
    const callbacks = [];
    const picture = { bitmap: { addLoadListener(callback) { callbacks.push(callback); } },
      _isAnimatedPicture: true, frames: 0,
      updateAnimatedPictureFrame() { this.frames++; } };
    host.context.load.call(picture);
    picture.bitmap = { addLoadListener(callback) { callbacks.push(callback); } };
    host.context.load.call(picture);
    callbacks[0]();
    assert.equal(picture.frames, 0);
    callbacks[1]();
    assert.equal(picture.frames, 1);
  });
}

test('obfuscated plugin revision preserves callback ownership', () => {
  const file = 'js/plugins/Olivia_AnimatedPictures.js';
  const authored = "if(this[_0x530c('0x27')]){this[_0x530c('0x26')][_0x530c('0x17')](this[_0x530c('0x2b')][_0x530c('0x18')](this));}else{this['bitmap'][_0x530c('0x17')](this[_0x530c('0x35')][_0x530c('0x18')](this));}";
  const original = `function load() { ${authored} }`;
  const host = setup({ [file]: original }, { hash: '2057fd676895274f066736bb04eed93333ed3177b69ccfdb118f4e537468abf1' });
  const context = host.context, registrations = [];
  context._0x530c = key => ({ '0x27': '_isAnimatedPicture', '0x26': 'bitmap',
    '0x17': 'addLoadListener', '0x2b': 'updateAnimatedPictureFrame',
    '0x18': 'bind', '0x35': 'resetFrame' }[key]);
  assert.notEqual(host.source(file), original);
  host.load(file);
  const first = { addLoadListener(callback) { registrations.push(callback); } };
  const second = { addLoadListener(callback) { registrations.push(callback); } };
  let frames = 0;
  const sprite = { bitmap: first, _isAnimatedPicture: true,
    updateAnimatedPictureFrame() { frames++; }, resetFrame() { throw Error('unexpected reset'); } };
  context.load.call(sprite); sprite.bitmap = second; context.load.call(sprite);
  registrations[0](); assert.equal(frames, 0);
  registrations[1](); assert.equal(frames, 1);
});

test('unknown plugin sources delegate unchanged', () => {
  const file = 'js/plugins/Olivia_AnimatedPictures.js', source = 'unknown plugin';
  const host = setup({ [file]: source }, { reviewed: false });
  assert.equal(host.source(file), source);
  assert.equal(host.delegated, true);
});

test('reviewed plugin source qualifies without substituted fingerprints', { skip: !process.env.PMJS_ISAT_REFERENCE_GAME }, () => {
  const file = 'js/plugins/Olivia_AnimatedPictures.js';
  const input = require('node:fs').readFileSync(require('node:path').join(process.env.PMJS_ISAT_REFERENCE_GAME, file), 'utf8');
  const host = setup({ [file]: input }, { hash: undefined });
  const output = host.source(file);
  assert.notEqual(output, input);
  assert.equal(host.delegated, false);
  assert.doesNotThrow(() => new vm.Script(output));
});
