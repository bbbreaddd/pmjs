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
  const warnings = [];
  const context = {
    console: {
      log(message) { logs.push(String(message)); },
      warn(message) { warnings.push(String(message)); },
    },
    PMJS_GAME_CONFIG: config,
    NativeHost: { runtime: { env(name) { return env[name]; } } },
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/pmjs-core/config.js'), 'utf8'), context);
  vm.runInContext(optimizationsSource, context, { filename: 'optimizations.js' });
  return { context, logs, warnings, PMJS: context.PMJS };
}

// Owner modules register their own IDs; core never catalogs game plugins.
function registerOwnerIds(PMJS, ids) {
  for (const id of ids) {
    PMJS.optimizations.register({ id, owner: 'test-owner', fallback: 'test fallback' });
  }
}

const sceneIds = ['scene.graphics-cache', 'scene.tiling-texture-cache'];
const terraxId = 'terrax.native-lighting';

test('registry internals stay private despite guest global name collisions', () => {
  const { context, PMJS } = loadRegistry({
    config: { disableOptimizations: [sceneIds[0]] }
  });
  assert.deepEqual(Object.keys(context).filter(name => /^pmjs(?:Optimization|LogOptimization)/.test(name)), []);
  vm.runInContext(`
    var pmjsOptimizationStates = null;
    var pmjsOptimizationFinalized = true;
    var pmjsOptimizationConfigDisabled = null;
    var pmjsOptimizationEnvDisabled = null;
    function pmjsOptimizationState() { throw new Error('guest helper'); }
    function pmjsOptimizationEnv() { throw new Error('guest helper'); }
    function pmjsLogOptimizationPolicy() { throw new Error('guest helper'); }
  `, context);
  registerOwnerIds(PMJS, sceneIds);
  assert.equal(PMJS.optimizations.isEnabled(sceneIds[0]), false);
  assert.equal(PMJS.optimizations.isEnabled(sceneIds[1]), true);
  PMJS.optimizations.finalize();
  assert.throws(() => PMJS.optimizations.register({
    id: 'late', owner: 'test', fallback: 'ordinary'
  }), /finalized/);
});

test('registered optimizations default to enabled without any configuration', () => {
  const { PMJS } = loadRegistry({ config: {}, env: {} });
  registerOwnerIds(PMJS, [...sceneIds, terraxId]);
  for (const id of PMJS.optimizations.ids()) {
    assert.equal(PMJS.optimizations.isEnabled(id), true, id);
    assert.equal(PMJS.optimizations.reason(id), 'enabled', id);
  }
});

test('configuration can disable exactly one optimization without affecting others', () => {
  const { PMJS } = loadRegistry({
    config: { disableOptimizations: ['scene.graphics-cache'] }, env: {},
  });
  registerOwnerIds(PMJS, [...sceneIds, terraxId]);
  assert.equal(PMJS.optimizations.isEnabled('scene.graphics-cache'), false);
  assert.equal(PMJS.optimizations.reason('scene.graphics-cache'), 'disabled by configuration');
  assert.equal(PMJS.optimizations.isEnabled('scene.tiling-texture-cache'), true);
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
  assert.equal(PMJS.optimizations.isEnabled('scene.tiling-texture-cache'), true);
  const dump = PMJS.optimizations.dump();
  assert.equal(dump.find(entry => entry.id === terraxId).disabledBy, 'configuration');
  assert.equal(dump.find(entry => entry.id === terraxId).owner, 'test-owner');
});

test('developer override is honored and takes precedence over configuration policy', () => {
  const { PMJS } = loadRegistry({
    config: { disableOptimizations: ['scene.graphics-cache'] },
    env: { PMJS_DISABLE_OPT: 'scene.tiling-texture-cache' },
  });
  registerOwnerIds(PMJS, [...sceneIds, terraxId]);
  assert.equal(PMJS.optimizations.isEnabled('scene.tiling-texture-cache'), false);
  assert.equal(PMJS.optimizations.reason('scene.tiling-texture-cache'),
    'disabled by PMJS_DISABLE_OPT');
  assert.equal(PMJS.optimizations.isEnabled('scene.graphics-cache'), false);
  assert.equal(PMJS.optimizations.reason('scene.graphics-cache'), 'disabled by configuration');

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
  assert.equal(PMJS.optimizations.isEnabled('scene.tiling-texture-cache'), true);
});

test('requested disables stay pending until owners register', () => {
  const { PMJS } = loadRegistry({
    config: { disableOptimizations: [terraxId] },
    env: { PMJS_DISABLE_OPT: 'scene.graphics-cache' },
  });
  // No throw yet: the owning module has not registered its ID.
  assert.equal(PMJS.optimizations.ids().length, 0);
  registerOwnerIds(PMJS, [terraxId, 'scene.graphics-cache']);
  assert.equal(PMJS.optimizations.isEnabled(terraxId), false);
  assert.equal(PMJS.optimizations.isEnabled('scene.graphics-cache'), false);
  PMJS.optimizations.finalize();
});

test('finalize rejects requested disables that nobody registered', () => {
  const configured = loadRegistry({
    config: { disableOptimizations: ['terrax.nativeLight'] }, env: {},
  });
  registerOwnerIds(configured.PMJS, [terraxId]);
  assert.throws(() => configured.PMJS.optimizations.finalize(),
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

test('malformed configuration is fatal at load', () => {
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
  assert.deepEqual(boot.logs, ['[pmjs-opt] terrax.native-lighting disabled by configuration']);

  const full = loadRegistry({ config: {}, env: { PMJS_OPT_DIAGNOSTICS: '1' } });
  registerOwnerIds(full.PMJS, [...sceneIds, terraxId]);
  full.PMJS.optimizations.finalize();
  assert.ok(full.logs.length === full.PMJS.optimizations.ids().length);
  assert.ok(full.logs.every(line => line.startsWith('[pmjs-opt] ')));
  assert.ok(full.logs.some(line => line.endsWith(' enabled')));
});

test('owners can refuse an unrecognized shape with a reason', () => {
  const { PMJS, warnings } = loadRegistry({ config: {}, env: {} });
  registerOwnerIds(PMJS, sceneIds);
  assert.equal(PMJS.optimizations.refuse('scene.graphics-cache', 'unknown setter shape'), 'refusal');
  assert.equal(PMJS.optimizations.isEnabled('scene.graphics-cache'), false);
  assert.equal(PMJS.optimizations.reason('scene.graphics-cache'),
    'refused: unknown setter shape');
  assert.equal(PMJS.optimizations.isEnabled('scene.tiling-texture-cache'), true);
  const dump = PMJS.optimizations.dump();
  assert.equal(dump.find(entry => entry.id === 'scene.graphics-cache').refusalReason,
    'unknown setter shape');
  assert.equal(dump.find(entry => entry.id === 'scene.tiling-texture-cache').refusalReason, null);
  PMJS.optimizations.refuse('scene.graphics-cache', 'another shape');
  PMJS.optimizations.finalize();
  assert.deepEqual(warnings, [
    '[pmjs-opt] scene.graphics-cache refused: unknown setter shape; fallback: test fallback',
  ]);
});

test('boot diagnostics report refusal and finalization freezes refusal', () => {
  const { PMJS, logs } = loadRegistry({
    config: {}, env: { PMJS_BOOT_DIAGNOSTICS: '1' },
  });
  registerOwnerIds(PMJS, sceneIds);
  PMJS.optimizations.refuse('scene.graphics-cache', 'unknown setter shape');
  PMJS.optimizations.finalize();
  assert.ok(logs.includes('[pmjs-opt] scene.graphics-cache refused: unknown setter shape'));
  assert.throws(() => PMJS.optimizations.refuse('scene.tiling-texture-cache', 'late'),
    /finalized; cannot refuse/);
  assert.equal(PMJS.optimizations.isEnabled('scene.tiling-texture-cache'), true);
});

test('refusal keeps an earlier disable cause and validates input', () => {
  const { PMJS, warnings } = loadRegistry({
    config: { disableOptimizations: ['scene.graphics-cache'] }, env: {},
  });
  registerOwnerIds(PMJS, sceneIds);
  assert.equal(PMJS.optimizations.refuse('scene.graphics-cache', 'unknown shape'), 'configuration');
  assert.equal(PMJS.optimizations.reason('scene.graphics-cache'), 'disabled by configuration');
  assert.throws(() => PMJS.optimizations.refuse('scene.graphics-cache', ''),
    /nonempty string reason/);
  assert.throws(() => PMJS.optimizations.refuse('no.such.id', 'reason'),
    /Unknown PMJS optimization/);
  assert.deepEqual(warnings, []);
});

test('runtime fallback reasons warn once per optimization and reason without changing boot policy', () => {
  const { PMJS, warnings } = loadRegistry({ config: {} });
  registerOwnerIds(PMJS, sceneIds);
  PMJS.optimizations.finalize();
  PMJS.optimizations.reportFallback(sceneIds[0], 'unsupported drawing state', 'first instance');
  PMJS.optimizations.reportFallback(sceneIds[0], 'unsupported drawing state', 'second instance');
  PMJS.optimizations.reportFallback(sceneIds[0], 'source revision unavailable');
  PMJS.optimizations.reportFallback(sceneIds[1], 'unsupported drawing state');
  assert.deepEqual(warnings, [
    '[pmjs-opt] scene.graphics-cache refused for this use: unsupported drawing state (first instance); fallback: test fallback',
    '[pmjs-opt] scene.graphics-cache refused for this use: source revision unavailable; fallback: test fallback',
    '[pmjs-opt] scene.tiling-texture-cache refused for this use: unsupported drawing state; fallback: test fallback',
  ]);
  assert.equal(PMJS.optimizations.reason(sceneIds[0]), 'enabled');
  const record = PMJS.optimizations.dump().find(entry => entry.id === sceneIds[0]);
  assert.equal(record.enabled, true);
  assert.equal(record.refusalReason, null);
  assert.deepEqual(Array.from(record.fallbackReasons), ['unsupported drawing state', 'source revision unavailable']);
  assert.deepEqual({ ...record.fallbackCounts }, { 'unsupported drawing state': 2, 'source revision unavailable': 1 });
  record.fallbackCounts['unsupported drawing state'] = 99;
  assert.equal(PMJS.optimizations.dump()[0].fallbackCounts['unsupported drawing state'], 2);
  record.fallbackReasons.push('unowned reason');
  assert.equal(PMJS.optimizations.dump()[0].fallbackReasons.length, 2);
});

test('runtime fallback reporting preserves explicit disables and global refusals', () => {
  const { PMJS, warnings } = loadRegistry({
    config: { disableOptimizations: [sceneIds[0]] },
  });
  registerOwnerIds(PMJS, sceneIds);
  PMJS.optimizations.refuse(sceneIds[1], 'unrecognized producer');
  PMJS.optimizations.finalize();
  PMJS.optimizations.reportFallback(sceneIds[0], 'unsupported drawing state');
  PMJS.optimizations.reportFallback(sceneIds[1], 'unsupported drawing state');
  assert.equal(warnings.length, 1);
  assert.equal(PMJS.optimizations.reason(sceneIds[0]), 'disabled by configuration');
  assert.equal(PMJS.optimizations.reason(sceneIds[1]), 'refused: unrecognized producer');
  assert.ok(PMJS.optimizations.dump().every(entry => entry.fallbackReasons.length === 0));
});

test('runtime fallback reporting validates its owner and cannot propagate logging failures', () => {
  const { PMJS, context } = loadRegistry({ config: {} });
  registerOwnerIds(PMJS, sceneIds);
  assert.throws(() => PMJS.optimizations.reportFallback('missing', 'reason'), /Unknown PMJS optimization/);
  assert.throws(() => PMJS.optimizations.reportFallback(sceneIds[0], ''), /nonempty string reason/);
  context.console.warn = () => { throw new Error('logger failed'); };
  assert.doesNotThrow(() => PMJS.optimizations.reportFallback(sceneIds[0], 'unsupported state'));
  assert.equal(PMJS.optimizations.isEnabled(sceneIds[0]), true);
});

test('unreadable exception details cannot suppress the refusal reason or escape into gameplay', () => {
  const { PMJS, warnings } = loadRegistry({ config: {} });
  registerOwnerIds(PMJS, sceneIds);
  const detail = Object.defineProperty({}, 'message', { get() { throw new Error('unreadable'); } });
  assert.doesNotThrow(() => PMJS.optimizations.reportFallback(sceneIds[0], 'capture failed', detail));
  assert.deepEqual(warnings, [
    '[pmjs-opt] scene.graphics-cache refused for this use: capture failed; fallback: test fallback',
  ]);
});

test('refusal detail identifies a method without changing reason categories or deduplication', () => {
  const { PMJS, warnings } = loadRegistry();
  registerOwnerIds(PMJS, sceneIds);
  PMJS.optimizations.refuse(sceneIds[0], 'unrecognized pipeline', 'Target.draw');
  PMJS.optimizations.refuse(sceneIds[0], 'unrecognized pipeline', 'Target.other');
  const record = PMJS.optimizations.dump().find(entry => entry.id === sceneIds[0]);
  assert.equal(record.refusalReason, 'unrecognized pipeline');
  assert.equal(record.refusalDetail, 'Target.draw');
  assert.deepEqual({ ...record.fallbackCounts }, {});
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /unrecognized pipeline \(Target.draw\)/);
  assert.equal(PMJS.optimizations.isEnabled(sceneIds[1]), true);
});
