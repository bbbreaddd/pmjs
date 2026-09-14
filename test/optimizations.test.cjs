'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const runtimeRoot = path.resolve(__dirname, '..');
const optimizationsSource = fs.readFileSync(
  path.join(runtimeRoot, 'js/pmjs-core/optimizations.js'), 'utf8');

function loadRegistry({ config, env = {} } = {}) {
  const logs = [];
  const context = {
    console: { log(message) { logs.push(String(message)); } },
    PMJS_GAME_CONFIG: config,
    NativeHost: { runtime: { env(name) { return env[name]; } } },
  };
  vm.createContext(context);
  vm.runInContext(optimizationsSource, context, { filename: 'optimizations.js' });
  return { context, logs, PMJS: context.PMJS };
}

// Owner modules register their own IDs; core never catalogs game plugins.
function registerOwnerIds(PMJS, ids) {
  for (const id of ids) {
    PMJS.optimizations.register({ id, owner: 'test-owner', fallback: 'test fallback' });
  }
}

const sceneIds = ['scene.graphics-cache', 'scene.gpu-mesh-cache'];
const terraxId = 'terrax.native-lighting';

test('registered optimizations default to enabled without any configuration', () => {
  const { PMJS } = loadRegistry({ config: {}, env: {} });
  registerOwnerIds(PMJS, [...sceneIds, terraxId]);
  for (const id of PMJS.optimizations.ids()) {
    assert.equal(PMJS.optimizations.isEnabled(id), true, id);
    assert.equal(PMJS.optimizations.reason(id), 'enabled', id);
  }
});

test('a port can disable exactly one optimization without affecting others', () => {
  const { PMJS } = loadRegistry({
    config: { disableOptimizations: ['scene.graphics-cache'] }, env: {},
  });
  registerOwnerIds(PMJS, [...sceneIds, terraxId]);
  assert.equal(PMJS.optimizations.isEnabled('scene.graphics-cache'), false);
  assert.equal(PMJS.optimizations.reason('scene.graphics-cache'), 'disabled by port');
  assert.equal(PMJS.optimizations.isEnabled('scene.gpu-mesh-cache'), true);
  assert.equal(PMJS.optimizations.isEnabled(terraxId), true);
});

test('multiple disables work and report their own reasons', () => {
  const { PMJS } = loadRegistry({
    config: { disableOptimizations: [terraxId, 'scene.graphics-cache'] },
    env: {},
  });
  registerOwnerIds(PMJS, [...sceneIds, terraxId]);
  assert.equal(PMJS.optimizations.isEnabled(terraxId), false);
  assert.equal(PMJS.optimizations.isEnabled('scene.graphics-cache'), false);
  assert.equal(PMJS.optimizations.isEnabled('scene.gpu-mesh-cache'), true);
  const dump = PMJS.optimizations.dump();
  assert.equal(dump.find(entry => entry.id === terraxId).disabledBy, 'port');
  assert.equal(dump.find(entry => entry.id === terraxId).owner, 'test-owner');
});

test('developer override is honored and takes precedence over port policy', () => {
  const { PMJS } = loadRegistry({
    config: { disableOptimizations: ['scene.graphics-cache'] },
    env: { PMJS_DISABLE_OPT: 'scene.gpu-mesh-cache' },
  });
  registerOwnerIds(PMJS, [...sceneIds, terraxId]);
  assert.equal(PMJS.optimizations.isEnabled('scene.gpu-mesh-cache'), false);
  assert.equal(PMJS.optimizations.reason('scene.gpu-mesh-cache'),
    'disabled by PMJS_DISABLE_OPT');
  assert.equal(PMJS.optimizations.isEnabled('scene.graphics-cache'), false);
  assert.equal(PMJS.optimizations.reason('scene.graphics-cache'), 'disabled by port');

  const both = loadRegistry({
    config: { disableOptimizations: [terraxId] },
    env: { PMJS_DISABLE_OPT: terraxId },
  });
  registerOwnerIds(both.PMJS, [terraxId]);
  assert.equal(both.PMJS.optimizations.reason(terraxId), 'disabled by PMJS_DISABLE_OPT');
});

test('developer override parsing trims, drops empties, and dedupes', () => {
  const { PMJS } = loadRegistry({
    config: {},
    env: { PMJS_DISABLE_OPT: ' scene.graphics-cache ,,scene.graphics-cache,' },
  });
  registerOwnerIds(PMJS, sceneIds);
  assert.equal(PMJS.optimizations.isEnabled('scene.graphics-cache'), false);
  assert.equal(PMJS.optimizations.isEnabled('scene.gpu-mesh-cache'), true);
});

test('requested disables stay pending until owners register', () => {
  const { PMJS } = loadRegistry({
    config: { disableOptimizations: [terraxId] },
    env: { PMJS_DISABLE_OPT: 'scene.graphics-cache' },
  });
  // No throw yet: the port adapter has not registered its ID.
  assert.equal(PMJS.optimizations.ids().length, 0);
  registerOwnerIds(PMJS, [terraxId, 'scene.graphics-cache']);
  assert.equal(PMJS.optimizations.isEnabled(terraxId), false);
  assert.equal(PMJS.optimizations.isEnabled('scene.graphics-cache'), false);
  PMJS.optimizations.finalize();
});

test('finalize rejects requested disables that nobody registered', () => {
  const port = loadRegistry({
    config: { disableOptimizations: ['terrax.nativeLight'] }, env: {},
  });
  registerOwnerIds(port.PMJS, [terraxId]);
  assert.throws(() => port.PMJS.optimizations.finalize(),
    /Unknown PMJS optimization: terrax\.nativeLight/);

  const developer = loadRegistry({
    config: {}, env: { PMJS_DISABLE_OPT: 'scene.compiled-descriptors' },
  });
  registerOwnerIds(developer.PMJS, sceneIds);
  assert.throws(() => developer.PMJS.optimizations.finalize(),
    /Unknown PMJS optimization: scene\.compiled-descriptors/);
});

test('finalize freezes registration and is idempotent', () => {
  const { PMJS } = loadRegistry({ config: {}, env: {} });
  registerOwnerIds(PMJS, sceneIds);
  PMJS.optimizations.finalize();
  PMJS.optimizations.finalize();
  assert.throws(() => PMJS.optimizations.register({ id: 'late.opt' }),
    /finalized; cannot register: late\.opt/);
});

test('duplicate and malformed registrations throw', () => {
  const { PMJS } = loadRegistry({ config: {}, env: {} });
  registerOwnerIds(PMJS, sceneIds);
  assert.throws(() => PMJS.optimizations.register(
    { id: 'scene.graphics-cache', owner: 'test-owner', fallback: 'test fallback' }),
  /already registered: scene\.graphics-cache/);
  assert.throws(() => PMJS.optimizations.register({}), /nonempty string id/);
  assert.throws(() => PMJS.optimizations.register({ id: '' }), /nonempty string id/);
  assert.throws(() => PMJS.optimizations.register({ id: 'x' }),
    /nonempty string owner/);
  assert.throws(() => PMJS.optimizations.register({ id: 'x', owner: '' }),
    /nonempty string owner/);
  assert.throws(() => PMJS.optimizations.register({ id: 'x', owner: 'o' }),
    /nonempty string fallback/);
  assert.throws(() => PMJS.optimizations.register({ id: 'x', owner: 'o', fallback: '' }),
    /nonempty string fallback/);
});

test('malformed port configuration is fatal at load', () => {
  assert.throws(() => loadRegistry({
    config: { disableOptimizations: 'scene.graphics-cache' }, env: {},
  }), /must be an array/);
  assert.throws(() => loadRegistry({
    config: { disableOptimizations: [''] }, env: {},
  }), /unique nonempty strings/);
  assert.throws(() => loadRegistry({
    config: { disableOptimizations: [42] }, env: {},
  }), /unique nonempty strings/);
  assert.throws(() => loadRegistry({
    config: { disableOptimizations: ['a', 'a'] }, env: {},
  }), /unique nonempty strings/);
});

test('runtime queries for unregistered IDs throw instead of silently passing', () => {
  const { PMJS } = loadRegistry({ config: {}, env: {} });
  registerOwnerIds(PMJS, sceneIds);
  assert.throws(() => PMJS.optimizations.isEnabled('nope.missing'),
    /Unknown PMJS optimization: nope\.missing/);
  assert.throws(() => PMJS.optimizations.reason('nope.missing'),
    /Unknown PMJS optimization: nope\.missing/);
});

test('diagnostics stay silent by default and dump on finalize', () => {
  const silent = loadRegistry({
    config: { disableOptimizations: [terraxId] }, env: {},
  });
  registerOwnerIds(silent.PMJS, [terraxId]);
  assert.deepEqual(silent.logs, []);
  silent.PMJS.optimizations.finalize();
  assert.deepEqual(silent.logs, []);

  const boot = loadRegistry({
    config: { disableOptimizations: [terraxId] },
    env: { PMJS_BOOT_DIAGNOSTICS: '1' },
  });
  registerOwnerIds(boot.PMJS, [terraxId]);
  boot.PMJS.optimizations.finalize();
  assert.deepEqual(boot.logs, ['[pmjs-opt] terrax.native-lighting disabled by port']);

  const full = loadRegistry({ config: {}, env: { PMJS_OPT_DIAGNOSTICS: '1' } });
  registerOwnerIds(full.PMJS, [...sceneIds, terraxId]);
  full.PMJS.optimizations.finalize();
  assert.ok(full.logs.length === full.PMJS.optimizations.ids().length);
  assert.ok(full.logs.every(line => line.startsWith('[pmjs-opt] ')));
  assert.ok(full.logs.some(line => line.endsWith(' enabled')));
});

test('consumers without the registry module default to enabled', () => {
  const context = {};
  vm.createContext(context);
  const enabled = vm.runInContext(
    "typeof pmjsOptimizationEnabled !== 'function' || pmjsOptimizationEnabled('x')",
    context);
  assert.equal(enabled, true);
});
