'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../../../patches/isat/source-qualification.js'), 'utf8');
const engineHashes = {
  'js/rpg_core.js': '930ee1db401dff04792cc7a4ab3181065745795527130d0da564e95d8e91c515',
  'js/rpg_managers.js': '6434f299fba616ca3fedee8aa1b6e66d1b2e53b839cd21475e2ef7868f0c75f1',
  'js/rpg_objects.js': 'db2db44e402a7890b97c17d7892410facec3fcb2ee48a3ff513ca6fba6f26111',
  'js/rpg_scenes.js': '2605309aeb212b86c7d50379cefd6620cf9b6dd0cf782a55e134594c994fd6ad',
  'js/rpg_sprites.js': '09435ecf207f81874a65de8893aabc988205e4983ad9ad6801bc038a581d932b',
  'js/rpg_windows.js': '79babbb19171940787a87e19b5222cc55c74afb978fab0772a409ec1d1e7fd45',
  'data/Map030.json': '628daf9c24481f2a2cf1155dc735b6e1de097c7ecd216c95ea7c917821d63b8c',
  'data/CommonEvents.json': '24b75465d82a74c5cffc373bde9abd75d5dde4d0940e2217599585e1d1e6e279'
};
function setup({ unknown = false, verifierSource = false, wrongEngine = false, wrongData = false, encounterHash } = {}) {
  let phase;
  const seen = [];
  const context = vm.createContext({
    __pmjsBuiltinRequire() { return { createHash() { return { update(text) {
      seen.push(text); return { digest() {
        return text.trim() === 'js/plugins/MPP_EncounterEffect.js' ? encounterHash : engineHashes[text.trim()] || 'unreviewed';
      } };
    } }; } }; },
    NativeHost: { fs: {
      readText(file) {
        if (verifierSource && file === 'js/plugins/Unreviewed.js') return source;
        return wrongEngine ? 'changed engine' : wrongData && file.startsWith('data/') ? 'changed event script' : file + '\r\n';
      }
    } },
    $plugins: encounterHash ? [{ name: 'MPP_EncounterEffect', status: true }] :
      unknown ? [{ name: 'Unreviewed', status: true }] : [],
    PMJS: { phases: { on(name, owner, callback) {
      assert.equal(name, 'afterGuestPlugins'); assert.equal(owner, 'pmjs.isat.source-qualification'); phase = callback;
    } } }
  });
  require('../../helpers/runtime-context.cjs').runModule(context, 'js/pmjs-core/methods.js');
  vm.runInContext(source, context);
  assert.equal(context.PMJS.isatSourceQualification, undefined);
  phase();
  return { context, seen, qualification: context.PMJS.isatSourceQualification };
}

test('source qualification is an immutable independent phase result', () => {
  const h = setup(); assert.equal(h.qualification.verified, true); assert.equal(h.qualification.dormontDataVerified, true);
  assert.equal(Object.isFrozen(h.qualification), true);
  assert.equal(h.seen.length, 8); assert.ok(h.seen.every(text => !text.includes('\r')));
  // This module does not require a horror feature or an optimization enable switch.
  assert.equal(h.context.PMJS.optimizations, undefined);
});

test('unreviewed plugin source stays unqualified even when it contains this verifier', () => {
  const h = setup({ unknown: true, verifierSource: true });
  assert.equal(h.qualification.verified, false);
  assert.match(h.qualification.reason, /unreviewed source: js\/plugins\/Unreviewed\.js/);
});

test('unknown engine or plugin composition remains unqualified', () => {
  for (const options of [{ wrongEngine: true }, { unknown: true }]) {
    const h = setup(options); assert.equal(h.qualification.verified, false);
    assert.equal(Object.isFrozen(h.qualification), true); assert.match(h.qualification.reason, /unreviewed source/);
  }
});

test('unreviewed event data preserves independent JavaScript qualification', () => {
  const h = setup({ wrongData: true });
  assert.equal(h.qualification.verified, true); assert.equal(h.qualification.dormontDataVerified, false);
  assert.match(h.qualification.dormontDataReason, /Map030/);
});

test('encounter qualification accepts pristine source and refuses the retired modified layout', () => {
  const pristine = setup({ encounterHash: 'c4364c06ba9c5e4d08693888f4343141952cec4e48eea8fbae984b84be78d572' });
  assert.equal(pristine.qualification.verified, true);
  const modified = setup({ encounterHash: 'd2c0cdbb7f498f513e303fc31117562844e29265802b92f29bba82f0bb2ca8fd' });
  assert.equal(modified.qualification.verified, false);
  assert.match(modified.qualification.reason, /unreviewed source: js\/plugins\/MPP_EncounterEffect\.js/);
});

test('the shared file contract is available before plugin execution and uses LF-normalized text', () => {
  let hashed;
  const context = vm.createContext({ PMJS: { phases: { on() {} } },
    __pmjsBuiltinRequire() { return { createHash() { return { update(text) {
      hashed = text;
      return { digest() { return engineHashes['js/rpg_core.js']; } };
    } }; } }; }
  });
  require('../../helpers/runtime-context.cjs').runModule(context, 'js/pmjs-core/methods.js');
  vm.runInContext(source, context);
  assert.equal(context.PMJS.isatSourceQualification, undefined);
  assert.equal(context.PMJS.isatSourceMatches('js/rpg_core.js', 'fixture\r\n'), true);
  assert.equal(hashed, 'fixture\n');
  assert.equal(context.PMJS.isatSourceMatches('js/plugins/Unknown.js', 'fixture'), false);
  assert.equal(context.PMJS.isatSourceMatches('js/rpg_core.js', null), false);
});

test('shared method fingerprints normalize only CRLF and reject non-functions', () => {
  const hash = require('./test-fixtures/method-hash.cjs')();
  const lf = vm.runInNewContext('(function() {\n  return 1;\n})');
  const crlf = vm.runInNewContext('(function() {\r\n  return 1;\r\n})');
  const spaced = vm.runInNewContext('(function() {\n return 1;\n})');
  assert.equal(hash(lf), hash(crlf));
  assert.notEqual(hash(lf), hash(spaced));
  assert.equal(hash(null), false);
  assert.equal(hash({ toString() { return lf.toString(); } }), false);
});
