'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'js', 'pmjs-web', 'dialogs.js'), 'utf8');

function makeContext({ env = {}, dialog = null, fsExists = () => false } = {}) {
  const calls = [];
  const context = {
    NativeHost: {
      dialog,
      fs: { exists: p => fsExists(p), isDirectory: () => false },
      runtime: { env: name => (name in env ? env[name] : undefined) }
    },
    console: { log: message => calls.push(message) }
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context);
  return { context, calls };
}

test('interactive alert/confirm delegate to the native modal host', () => {
  const seen = [];
  const { context, calls } = makeContext({
    dialog: {
      alert: message => seen.push(['alert', message]),
      confirm: message => { seen.push(['confirm', message]); return true; },
      setFont: () => {}
    }
  });
  vm.runInContext('alert("hi")', context);
  assert.equal(vm.runInContext('confirm("sure?")', context), true);
  assert.deepEqual(seen.map(([kind]) => kind), ['alert', 'confirm']);
  assert.equal(calls.length, 0);
});

test('strict mode throws instead of showing dialogs', () => {
  const { context } = makeContext({
    env: { PMJS_DIALOG_MODE: 'strict' },
    dialog: { alert: () => assert.fail('must not reach host') }
  });
  assert.throws(() => vm.runInContext('alert("x")', context), /browser\.dialog\.alert/);
  assert.throws(() => vm.runInContext('confirm("x")', context), /browser\.dialog\.confirm/);
  assert.throws(() => vm.runInContext('prompt("x")', context), /browser\.dialog\.prompt/);
});

test('headless mode answers from configured policy without host calls', () => {
  const { context } = makeContext({
    env: {
      PMJS_DIALOG_MODE: 'headless',
      PMJS_DIALOG_HEADLESS: '{"confirm":true,"prompt":"typed"}'
    },
    dialog: { alert: () => assert.fail('must not reach host') }
  });
  vm.runInContext('alert("x")', context);
  assert.equal(vm.runInContext('confirm("x")', context), true);
  assert.equal(vm.runInContext('prompt("x", "d")', context), 'typed');
});

test('headless defaults decline confirm and null prompt', () => {
  const { context } = makeContext({
    env: { PMJS_DIALOG_MODE: 'headless' },
    dialog: {}
  });
  assert.equal(vm.runInContext('confirm("x")', context), false);
  assert.equal(vm.runInContext('prompt("x")', context), null);
});

test('headless prompt normalizes to browser return types', () => {
  const { context } = makeContext({
    env: {
      PMJS_DIALOG_MODE: 'headless',
      PMJS_DIALOG_HEADLESS: '{"prompt":123}'
    },
    dialog: {}
  });
  assert.equal(vm.runInContext('prompt("x")', context), '123');
});

test('omitted message renders empty instead of "undefined"', () => {
  const seen = [];
  const { context } = makeContext({
    dialog: {
      confirm: message => { seen.push(message); return true; },
      setFont: () => {}
    }
  });
  assert.equal(vm.runInContext('confirm()', context), true);
  assert.deepEqual(seen, ['']);
});

test('dialog hits emit mergeable compat records', () => {
  const { context, calls } = makeContext({
    env: { PMJS_COMPAT_VERBOSE: '1' },
    dialog: {
      alert: () => {},
      confirm: () => true,
      setFont: () => {}
    }
  });
  vm.runInContext('confirm("sure?")', context);
  assert.equal(calls.length, 1);
  const record = JSON.parse(calls[0].replace('[pmjs-compat] ', ''));
  assert.equal(record.capability, 'browser.dialog.confirm');
  assert.equal(record.detail, 'sure?');
});

test('shared observed hook records evidence without verbose mode', () => {
  const observed = [];
  const logged = [];
  const context = {
    NativeHost: {
      dialog: { confirm: () => true, setFont: () => {} },
      fs: { exists: () => false, isDirectory: () => false },
      runtime: { env: () => undefined }
    },
    nativeCompatibilityObserved: (capability, detail) => {
      observed.push(capability + ':' + detail);
    },
    console: { log: message => logged.push(message) }
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context);
  vm.runInContext('confirm("sure?")', context);
  assert.deepEqual(observed, ['browser.dialog.confirm:sure?']);
  assert.equal(logged.length, 0);
});

test('prompt stays undefined in interactive mode', () => {
  const { context } = makeContext({ dialog: { setFont: () => {} } });
  assert.equal(vm.runInContext('typeof prompt', context), 'undefined');
});

test('no NativeHost.dialog leaves globals untouched', () => {
  const { context } = makeContext({ dialog: null });
  assert.equal(vm.runInContext('typeof alert', context), 'undefined');
  assert.equal(vm.runInContext('typeof confirm', context), 'undefined');
});

test('dialog font prefers game config over stock faces', () => {
  const fonts = [];
  const context = {
    NativeHost: {
      dialog: { setFont: p => fonts.push(p) },
      fs: { exists: () => true, isDirectory: () => false },
      runtime: { env: () => undefined }
    },
    pmjsGameConfig: { fonts: { GameFont: 'fonts/custom.ttf' } },
    console: { log: () => {} }
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context);
  assert.equal(fonts[0], 'fonts/custom.ttf');
});
