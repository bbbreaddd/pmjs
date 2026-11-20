'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');
const { loadPmjsRuntime, runModule } = require('./helpers/runtime-context.cjs');

const patch = fs.readFileSync(require.resolve('../js/pmjs-plugins/yanfly/event-copier.js'), 'utf8');
const plugin = `
var scriptAtLoad = document.currentScript.src;
Number.prototype.clamp = function(min, max) { return Math.min(Math.max(this, min), max); };
var Yanfly = { PreloadedMaps: [], loadMapData: function(mapId) {
  mapId = mapId.clamp(1, 999);
  if (Yanfly.PreloadedMaps[mapId]) return;
  Yanfly.PreloadedMaps[mapId] = null;
  return read(mapId, function(err, data) {
    if (err) throw err;
    Yanfly.PreloadedMaps[mapId] = JSON.parse(data);
  });
}, SetupParameters: function() {
  for (var i = 0; i < ids.length; i++) Yanfly.loadMapData(ids[i]);
} };
var originalLoad = Yanfly.loadMapData;
Yanfly.SetupParameters();
`;

function fixture({ enabled = true, recognized = true, ids = [2, 2, 3, 2, 3], syncError,
  effectiveSource = plugin, engine = 'mv' } = {}) {
  const requests = [], reported = [];
  let sourceReads = 0;
  const context = loadPmjsRuntime({ ids, __pmjsBuiltinRequire: require, document: {}, PMJS_RUNTIME_ENGINE: engine,
    console: { log() {}, error() {} },
    PMJS_GAME_CONFIG: { disableOptimizations: enabled ? [] : ['plugins.yanfly.event-copier-preload'] },
    PluginManager: { _scripts: [], _path: 'js/plugins/', setParameters() {} },
    DataManager: { isMapLoaded: () => true },
    $plugins: [{ name: 'YEP_EventCopier', status: true }, { name: 'Later', status: true }],
    pmjsReportEventError(error) { reported.push(error); },
    read(id, callback) {
      if (syncError) throw syncError;
      requests.push({ id, callback });
      return 'requested';
    },
    readGameBytes() { assert.fail('adapter must use the source supplied by the loader'); },
    NativeHost: { fs: { exists: () => true }, runtime: {
      readGameScript(name) {
        if (name.endsWith('Later.js')) return 'globalThis.laterLoaded = true;';
        sourceReads++;
        return effectiveSource;
      },
      loadScript(name, transformSource) {
        let source = this.readGameScript(name);
        if (transformSource) source = transformSource(source);
        return vm.runInContext(source, context, { filename: name });
      },
      runScript() { assert.fail('adapter must preserve normal script execution'); }
    } }
  });
  runModule(context, 'js/pmjs-web/script-loader.js');
  runModule(context, 'js/pmjs-' + engine + '/plugin-loader.js');
  const hash = crypto.createHash('sha256').update(plugin).digest('hex');
  vm.runInContext(recognized ? patch.replace(/'[a-f0-9]{64}'/, "'" + hash + "'") : patch, context);
  return { context, requests, reported, sourceReads: () => sourceReads,
    optimization: () => context.PMJS.optimizations.dump().find(row => row.id === 'plugins.yanfly.event-copier-preload'),
    load() { return engine === 'mv' ? context.pmjsMvInitializePlugins() : context.pmjsMzInitializePlugins(); } };
}

test('startup reads and parses each template map once and retains pending readiness', () => {
  const h = fixture();
  h.load();
  assert.equal(h.context.scriptAtLoad, 'file:///game/js/plugins/YEP_EventCopier.js');
  assert.equal(h.context.document.currentScript, null);
  assert.deepEqual(h.requests.map(request => request.id), [2, 3]);
  assert.equal(h.context.Yanfly.PreloadedMaps[2], null);
  assert.equal(h.context.Yanfly.PreloadedMaps[3], null);
  for (const request of h.requests) request.callback(null, JSON.stringify({ id: request.id, events: [null, { id: 1 }] }));
  assert.equal(h.context.Yanfly.PreloadedMaps[2].events[1].id, 1);
  assert.equal(h.context.Yanfly.PreloadedMaps[3].id, 3);
  assert.equal(h.context.Yanfly.loadMapData, h.context.originalLoad);
  h.context.Yanfly.loadMapData(2);
  assert.equal(h.requests.length, 2);
});

test('deduplication uses clamped map IDs and ends with the startup loop', () => {
  const h = fixture({ ids: [0, 1, 1000, 999] });
  h.load();
  assert.deepEqual(h.requests.map(request => request.id), [1, 999]);
  assert.equal(h.context.Yanfly.loadMapData(1), 'requested');
  assert.equal(h.requests.length, 3, 'later requests retain the original pending-load behavior');
});

test('MZ forwards source transforms through its normal plugin and script loaders', () => {
  const h = fixture({ engine: 'mz' });
  h.load();
  assert.deepEqual(h.requests.map(request => request.id), [2, 3]);
  assert.equal(h.context.scriptAtLoad, 'file:///game/js/plugins/YEP_EventCopier.js');
  assert.equal(h.context.laterLoaded, true);
});

test('read failures and invalid JSON propagate and do not leave a request guard installed', () => {
  const h = fixture(); h.load();
  const failure = new Error('read failed');
  assert.throws(() => h.requests[0].callback(failure), error => error === failure);
  assert.throws(() => h.requests[1].callback(null, 'invalid JSON'), { name: 'SyntaxError' });
  assert.equal(h.context.Yanfly.loadMapData, h.context.originalLoad);
  h.context.Yanfly.loadMapData(2);
  assert.equal(h.requests.length, 3);
  const thrown = fixture({ syncError: failure });
  thrown.load();
  assert.equal(thrown.reported[0], failure);
  assert.equal(thrown.context.laterLoaded, true);
  assert.equal(thrown.context.Yanfly.loadMapData, thrown.context.originalLoad);
});

test('unrecognized and disabled plugins retain ordinary loading without a separate source read', () => {
  for (const options of [{ recognized: false }, { enabled: false }]) {
    const h = fixture(options); h.load();
    assert.equal(h.requests.length, 5);
    assert.equal(h.sourceReads(), 1);
    assert.equal(!!h.optimization().refusalReason, options.recognized === false);
    assert.equal(h.context.Yanfly.loadMapData, h.context.originalLoad);
  }
});

test('qualification sees downstream source changes and preserves their execution', () => {
  const h = fixture();
  h.context.PMJS.phases.on('beforePlugins', 'later-loader', () => {
    h.context.PMJS.plugins.interceptLoad('YEP_EventCopier', 'later-loader', next =>
      next(source => source + '\nglobalThis.downstreamRan = true;'));
  });
  h.load();
  assert.equal(h.context.downstreamRan, true);
  assert.equal(h.requests.length, 5);
  assert.match(h.optimization().refusalReason, /unrecognized/);
});

test('qualification uses effective virtual source instead of the original file', () => {
  const h = fixture({ effectiveSource: plugin + '\nglobalThis.virtualSourceRan = true;' });
  h.load();
  assert.equal(h.context.virtualSourceRan, true);
  assert.equal(h.requests.length, 5);
  assert.match(h.optimization().refusalReason, /unrecognized/);
});

test('guest startup failures retain filename, failure stage and subsequent plugin loading', () => {
  const h = fixture({ ids: [null] });
  h.load();
  assert.equal(h.reported.length, 1);
  assert.match(h.reported[0].stack, /js\/plugins\/YEP_EventCopier.js/);
  assert.ok(!h.reported[0].stack.includes('inline-script.js'));
  assert.equal(h.context.PMJS.plugins.dump().guest[0].failureStage, 'guest-script');
  assert.equal(h.context.laterLoaded, true);
  assert.equal(h.context.Yanfly.loadMapData, h.context.originalLoad);
  assert.equal(h.context.document.currentScript, null);
});
