'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { loadPmjsRuntime } = require('./helpers/runtime-context.cjs');

const root = path.resolve(__dirname, '..');
function plain(value) { return JSON.parse(JSON.stringify(value)); }

test('plugin lifecycle installation preserves existing plugin capabilities', () => {
  const extension = () => 'existing capability';
  const namespace = { extension };
  const ctx = loadPmjsRuntime({ PMJS: { plugins: namespace } });
  assert.equal(ctx.PMJS.plugins, namespace);
  assert.equal(ctx.PMJS.plugins.extension(), 'existing capability');
  const loaded = [];
  ctx.PMJS.plugins.snapshotEffectiveManifest([{ name: 'Example', status: true }]);
  ctx.PMJS.plugins.onLoaded('Example', () => loaded.push('loaded'));
  ctx.PMJS.plugins.execute('Example', () => {});
  assert.deepEqual(loaded, ['loaded']);
  assert.equal(ctx.PMJS.plugins.dump().counts.loaded, 1);
});

test('startup snapshots keep authored order and canonical guest identity', () => {
  const ctx = loadPmjsRuntime();
  ctx.PMJS.plugins.snapshotOriginalManifest([
    { name: 'YED_Tiled', status: true }, { name: 'Off', status: false }
  ]);
  ctx.PMJS.plugins.snapshotEffectiveManifest([
    { name: 'YED_Tiled', status: true }, { name: 'Off', status: false }
  ]);
  ctx.PMJS.plugins.execute('yed_tiled.js', () => {});
  const dump = plain(ctx.PMJS.plugins.dump());
  assert.deepEqual(dump.original, ['YED_Tiled', 'Off']);
  assert.deepEqual(dump.effective, ['YED_Tiled', 'Off']);
  assert.equal(dump.guest.length, 2);
  assert.equal(dump.guest[0].id, 'game:yed_tiled');
  assert.equal(dump.guest[0].name, 'YED_Tiled');
  assert.equal(dump.guest[0].state, 'loaded');
  assert.equal(dump.guest[1].state, 'disabled');
});

test('manifests are one-shot and unfinished plugins appear unloaded at report time', () => {
  const ctx = loadPmjsRuntime();
  ctx.PMJS.plugins.snapshotOriginalManifest([]);
  ctx.PMJS.plugins.snapshotEffectiveManifest([
    { name: 'A', status: true }, { name: 'B', status: true }
  ]);
  ctx.PMJS.plugins.execute('A', () => {});
  assert.equal(ctx.PMJS.plugins.dump().counts.discovered, 1);
  assert.equal(ctx.PMJS.plugins.finish(), true);
  assert.equal(ctx.PMJS.plugins.dump().counts.unloaded, 1);
  assert.equal(ctx.PMJS.plugins.finish(), false);
  assert.throws(() => ctx.PMJS.plugins.snapshotOriginalManifest([]), /already captured/);
  assert.throws(() => ctx.PMJS.plugins.snapshotEffectiveManifest([]), /already captured/);
});

test('named callbacks run once and late subscribers run immediately', () => {
  const ctx = loadPmjsRuntime();
  const seen = [];
  ctx.PMJS.plugins.onLoaded('yed_tiled.js', 'good', () => seen.push('loaded'));
  ctx.PMJS.plugins.execute('YED_Tiled', () => {});
  ctx.PMJS.plugins.onLoaded('YED_Tiled', 'late', () => seen.push('late'));
  assert.deepEqual(seen, ['loaded', 'late']);
});

test('unexpected loaded and late phase installer failures propagate to the caller', () => {
  const errors = [];
  const ctx = loadPmjsRuntime({ console: { error(...args) { errors.push(args); } } });
  const seen = [];
  ctx.PMJS.plugins.onLoaded('Example', 'bad', () => { throw new Error('loaded installer'); });
  ctx.PMJS.plugins.onLoaded('Example', 'next', () => seen.push('next'));
  assert.throws(() => ctx.PMJS.plugins.execute('Example', () => {}), /loaded installer/);
  assert.deepEqual(seen, [], 'boot stops before further installers can mutate state');
  assert.throws(() => ctx.PMJS.plugins.onLoaded('Example', 'late', () => { throw new Error('late installer'); }), /late installer/);
  ctx.PMJS.phases.emit('afterPlugins');
  assert.throws(() => ctx.PMJS.phases.on('afterPlugins', 'late', () => { throw new Error('late phase'); }), /late phase/);
  assert.equal(errors.length, 3);
});

test('loading callbacks surround the named guest execution and canonicalize its name', () => {
  const ctx = loadPmjsRuntime();
  const seen = [];
  ctx.PMJS.plugins.onLoading('Example.js', 'adapter', () => seen.push('before'));
  ctx.PMJS.plugins.onLoaded('Example', 'adapter', () => seen.push('after'));
  ctx.PMJS.plugins.execute('Other', () => seen.push('other'));
  ctx.PMJS.plugins.execute('example', () => seen.push('guest'));
  assert.deepEqual(seen, ['other', 'before', 'guest', 'after']);
  assert.throws(() => ctx.PMJS.plugins.onLoading('EXAMPLE', 'late', () => {}), /after execution/);
});

test('loading callback failures prevent guest execution and remain visible', () => {
  const errors = [];
  const ctx = loadPmjsRuntime({ console: { error(...args) { errors.push(args); } } });
  ctx.PMJS.plugins.onLoading('Example', 'adapter', () => { throw new Error('capture failed'); });
  let executed = false;
  assert.throws(() => ctx.PMJS.plugins.execute('Example', () => { executed = true; }), /capture failed/);
  assert.equal(executed, false);
  const guest = ctx.PMJS.plugins.dump().guest[0];
  assert.equal(guest.state, 'failed');
  assert.equal(guest.error, 'capture failed');
  assert.match(errors[0][0], /owner adapter/);
});

test('failed plugin execution keeps the error and method mutation attribution', () => {
  const target = { update() {} };
  const ctx = loadPmjsRuntime({ target });
  vm.runInContext(`PMJS.methods.wrap({ key: 'K.update', id: 'pmjs.k',
    getTarget: () => target, method: 'update', wrap: next => next })`, ctx);
  assert.throws(() => ctx.PMJS.plugins.execute('Bad', () => {
    target.update = function() {};
    throw new Error('parse explosion');
  }), /parse explosion/);
  const dump = plain(ctx.PMJS.plugins.dump());
  assert.equal(dump.guest[0].state, 'failed');
  assert.equal(dump.guest[0].error, 'parse explosion');
  assert.equal(plain(ctx.PMJS.methods.dump())[0].mutations[0].plugin, 'Bad');
});

test('phases fire once and late registration runs immediately', () => {
  const ctx = loadPmjsRuntime();
  const seen = [];
  ctx.PMJS.phases.on('beforePlugins', 'first', () => seen.push('first'));
  assert.equal(ctx.PMJS.phases.emit('beforePlugins'), true);
  assert.equal(ctx.PMJS.phases.emit('beforePlugins'), false);
  ctx.PMJS.phases.on('beforePlugins', 'late', () => seen.push('late'));
  assert.deepEqual(seen, ['first', 'late']);
});

test('MV bootstrap executes plugins in order and logs a final summary', () => {
  const lines = [];
  const ctx = loadPmjsRuntime({
    console: { log(message) { lines.push(message); }, error(message) { lines.push(message); } },
    NativeHost: { runtime: { loadScript() {} } },
    PluginManager: { _scripts: [], _path: '', setParameters() {} },
    $plugins: [
      { name: 'First', status: true, parameters: {} },
      { name: 'Off', status: false, parameters: {} },
      { name: 'Last', status: true, parameters: {} }
    ]
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'js/pmjs-mv/plugin-loader.js'), 'utf8'),
    ctx);
  vm.runInContext('pmjsMvInitializePlugins()', ctx);
  const dump = plain(ctx.PMJS.plugins.dump());
  assert.equal(dump.counts.loaded, 2);
  assert.equal(dump.counts.disabled, 1);
  assert.deepEqual(dump.guest.filter(entry => entry.state === 'loaded')
    .map(entry => entry.name), ['First', 'Last']);
  assert.ok(lines.some(line => /guest plugins: 3 manifest, 2 loaded/.test(line)));
});
